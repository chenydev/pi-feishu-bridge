/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 设计依据：docs/DESIGN.md §2.2（B3 根治：pi-remote-feishu ConversationRouter 思想）。
 */
import { join, resolve } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { BridgeConfig, FeishuInboundMessage, SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";
import type { Outbox } from "../outbound/outbox.js";
import { buildConversationKey } from "./conversation-key.js";
import { PendingStore } from "./pending-store.js";
import { ConversationStore, type ConversationPointer } from "./conversation-store.js";
import type { IntakeLedger } from "../inbound/pipeline.js";
import type { ResourceResolver, ResolvedTurnResources } from "../inbound/resource-resolver.js";
import { adaptAgentEvent } from "../outbound/agent-event-adapter.js";
import { StreamingCard } from "../outbound/streaming-card.js";
import { LiveChannel, SerialWriter } from "../outbound/live-channel.js";
import { createRunMetrics, elapsedMs as metricsElapsedMs, recordUsage, renderFooter } from "../outbound/run-metrics.js";
import { RateBudget } from "../runtime/rate-budget.js";
import { randomUUID } from "node:crypto";
import type { ResourceRef } from "../types.js";

type AgentHandle = Awaited<ReturnType<SessionBackend["createSession"]>>;

/** P1-04：相对时间展示（不泄露绝对路径/时间戳细节）。 */
function formatRelative(timestamp: number, now: number): string {
	const delta = Math.max(0, now - timestamp);
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * P1-02：工具参数脱敏摘要 —— 只取有信息量的字段，经 sanitizeCommand 脱敏并截断。
 * 命令/参数可能含秘密，绝不原样展示。
 */
export function summarizeToolArgs(toolName: string, args?: Record<string, unknown>): string | undefined {
	if (!args) return undefined;
	const preferred = toolName === "bash" || toolName === "terminal"
		? ["command", "cmd"]
		: ["file_path", "path", "notebook_path", "pattern", "query", "url", "prompt", "description"];
	for (const field of preferred) {
		const value = args[field];
		if (typeof value === "string" && value.trim()) return sanitizeCommand(value.trim());
	}
	return undefined;
}

/** 工具友好名（hermes build_status_phrase / pi-feishu toolDisplayName 风格）。 */
function toolLabel(tool: string): string {
	const map: Record<string, string> = {
		read: "读取文件", write: "写入文件", edit: "编辑文件", bash: "执行命令", terminal: "执行命令",
		grep: "搜索内容", find: "查找文件", fetch_content: "抓取网页", web_search: "搜索网页",
		browser: "浏览网页", subagent_spawn: "启动子代理", memory_search: "搜索记忆",
		"mcp": "调用 MCP", "plan_mode_question": "确认方案", "ask_user_question": "向你提问",
	};
	return map[tool] ?? tool;
}

/** pending 中断恢复文件（hermes resume_pending 简化版）：agent 运行中进程被杀，
 * 重启后据此重发未完成消息。 */
export interface ConversationManagerDeps {
	config: BridgeConfig;
	/** 会话文件目录（绝对路径；避免相对路径落在 /workspace 无权限）。 */
	sessionDir: string;
	sessionBackend: SessionBackend;
	sender: Sender;
	/** final/error/notify 的可靠投递；进度消息仍由 sender 直接发送。 */
	durableOutbox?: Pick<Outbox, "enqueue"> & Partial<Pick<Outbox, "enqueueMedia">>;
	resourceResolver?: Pick<ResourceResolver, "resolve">;
	/** 本 bot 最近已发消息缓存（回复"自己消息"判定，hermes reply_to_is_own_message 等价）。 */
	lastSent?: { has(messageId: string): boolean };
	/** 处理中表情（reaction）能力：入队时添加、回复发出后撤回。 */
	reactions?: {
		add(messageId: string, emoji: string): Promise<string | undefined>;
		remove(messageId: string, reactionId: string): Promise<boolean>;
	};
	/** 进度消息编辑/撤回（方案 A：处理中消息实时更新工具进度）。 */
	editMessage?: (messageId: string, text: string) => Promise<boolean>;
	recallMessage?: (messageId: string) => Promise<boolean>;
	/** agent 回复文本的发送器（默认 sender.send 到 chat，回复挂 bot 上一条消息）。 */
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/** 超时（默认 300s）后通知用户并释放。 */
	/** run 空闲超时：有活动就不计时，停止产出才中止（默认 10 分钟）。0 = 关闭。 */
	/** P1-01：流式卡片需要直连飞书 API（复用 transport.rawRequest）。 */
	rawRequest?: (opts: { url: string; method: string; params?: unknown; data?: unknown }) => Promise<unknown>;
	runIdleTimeoutMs?: number;
	/** run 总时长硬上限（默认 0 = 不限制，只靠空闲超时兜底）。 */
	runMaxDurationMs?: number;
	/** P1-08：该会话未决审批数；>0 时不回收会话句柄。 */
	pendingApprovalCount?: (conversationKey: string) => number;
	/**
	 * P0-03：审批失效回调 —— run 结束（带 runId）或会话重置（无 runId）时撤销未决审批，
	 * 使已超时/结束/替换的任务再也无法通过旧卡授予 session/always 权限。
	 */
	onApprovalInvalidate?: (input: { conversationKey: string; runId?: string; reason: RunRetireReason }) => void;
	/** shutdown 对单个外部清理动作的等待上限；默认 2s，必须短于 SIGTERM 强退窗口。 */
	shutdownTimeoutMs?: number;
	now?: () => number;
	/** pending 中断恢复文件路径（hermes resume_pending；不设则禁用）。 */
	pendingFile?: string;
	/**
	 * P0-05：会话指针文件（conversationKey → 当前会话文件/世代）。
	 * 不设时退化为旧的内存后缀行为（/_new 重启会回退到初始文件）。
	 */
	conversationFile?: string;
}

interface BridgeSession {
	conversationKey: string;
	/** 原始 chatId（发送目标）；key 用于会话隔离。 */
	chatId: string;
	/** 话题 id（话题会话的发送目标 threadId）。 */
	threadId?: string;
	agent?: AgentHandle;
	/** 防止命令与首条消息并发时重复创建同一个 Pi session。 */
	creatingAgent?: Promise<AgentHandle>;
	/** agent 运行时 sessionId（tool 事件映射用，pi.on ctx.sessionManager.getSessionId()）。 */
	sessionId?: string;
	sessionFile: string;
	queue: Array<QueuedMessage>;
	/** 已由 Pi 接受、将在当前 run 的 turn 边界注入的消息。 */
	steered: Array<QueuedMessage>;
	activeRun: boolean;
	stopRequested?: boolean;
	lastReplyId?: string;
	createdAt: number;
	/** P1-08：最近活动时间（空闲回收依据）。 */
	lastActivityAt?: number;

	/** P2-02：该会话的工作区 realpath（解析自白名单别名）。 */
	workspacePath?: string;

	/** P2-02：工作区别名（诊断/展示用，不泄露绝对路径）。 */
	workspaceAlias?: string;
	/** run 空闲计时器：收到任意 agent 事件就重置；长时间无产出才中止。 */
	runIdleTimer?: ReturnType<typeof setTimeout>;
	/** 空闲超时时用来 reject run 的句柄（按会话，避免多会话并发互相覆盖）。 */
	runIdleReject?: (error: Error) => void;
}

interface QueuedMessage {	runId: string;
	chatId: string;
	messageId: string;
	text: string;
	resources: ResourceRef[];
	replyToMessageId?: string;
	replyToText?: string;
	/** 话题（thread_id）透传：hermes 话题模式。 */
	threadId?: string;
	/**
	 * 发起人 open_id。审批免审判定必须用它 —— conversationKey 只在「群聊+按人隔离」
	 * 这一种形态下才带用户 ID（话题是 `oc:t:th`、私聊是裸 `oc`），
	 * 从 key 里正则提取会漏掉后两种，导致管理员在私聊/话题里仍需逐次审批。
	 */
	senderId?: string;
	/** 处理中表情：reaction_id（add 时返回）。 */
	reactionId?: string;
	emojiReactionId?: string;
}

const MAX_QUEUE = 50;

/** P0-05：run 退出原因（决定未决审批卡的失效语义）。 */
export type RunRetireReason = "completed" | "timeout" | "stopped" | "shutdown" | "failed" | "reset";

/** /new 的结果（P0-05）：busy 表示有未完成任务需要显式 force。 */
export type ResetOutcome =
	| { status: "reset"; generation: number; cancelled: number }
	| { status: "busy"; pending: number }
	| { status: "error"; reason: string };

/**
 * P0-05：决定会话文件 —— 有持久指针则用它；否则用确定性路径并写入 generation=1。
 * 首次采用确定性路径时写指针失败只记日志：不得因此指向其他会话。
 */
function resolveSessionFile(
	sessionDir: string,
	key: string,
	inMemorySuffix: string | undefined,
	pointer: ConversationPointer | undefined,
	store: ConversationStore | undefined,
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void,
): string {
	if (pointer) return pointer.sessionFile;
	const sessionFile = join(sessionDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}${inMemorySuffix ?? ""}.jsonl`);
	if (store) {
		try {
			store.set({ conversationKey: key, sessionFile, generation: 1 });
		} catch (error) {
			log?.("error", "feishu.conv.pointer_init_failed", {
				conversationKey: key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return sessionFile;
}

export class ConversationManager {
	private sessions = new Map<string, BridgeSession>();
	private runIdleTimeoutMs: number;
	private runMaxDurationMs: number;
	private now: () => number;
	/** 进度消息状态（方案 A）：progressMessageId + 节流时间。 */
	private readonly progressBySession = new Map<string, {
		messageId?: string; lastUpdateAt: number; toolStack: string[]; lastCmd?: string; startedAt?: number;
		/** P1-02：按 toolCallId 配对的条目（含耗时与脱敏摘要）。 */
		tools?: Array<{ toolCallId?: string; toolName: string; startedAt: number; summary?: string }>;
		/** P1-02：思考摘要（仅在配置开启时累积）。 */
		thinking?: string;
	}>();
	private readonly progressMinIntervalMs = 1500;
	private readonly progressMaxLines = 4;
	private readonly pendingFile: string;
	private readonly pendingEnabled: boolean;
	private readonly pendingStore?: PendingStore;
	private readonly activeItems = new Map<string, QueuedMessage>();
	private readonly runningPumps = new Set<Promise<void>>();
	private readonly waitingPumps: BridgeSession[] = [];
	private activePumpCount = 0;
	private readonly liveChannel?: LiveChannel;
	/** P0-04：进度消息的串行写入器（与流式通道同语义，避免同一目标并发/乱序）。 */
	private readonly progressWriter?: SerialWriter;
	private readonly nextSessionSuffix = new Map<string, string>();
	/** P0-05：会话指针持久化（/new 后重启仍指向新会话）。 */
	private readonly conversationStore?: ConversationStore;
	/** P2-02：内存工作区别名（与持久化指针互补，避免无 store 时丢失当前工作区认知）。 */
	private readonly workspaceAliasByKey = new Map<string, string>();
	/** P1-07：共享请求预算（易失通道让路给最终交付与审批）。 */
	private readonly rateBudget: RateBudget;
	/**
	 * P2-05：单次 pump 连续执行的 turn 上限。达到上限且还有其他会话在等待时让出执行槽，
	 * 避免热点会话把队列跑完才释放槽（只在完整 run 之间让出，不会在工具/审批中途抢占）。
	 */
	private readonly pumpTurnBatch = 4;
	/** P1-08：空闲回收参数与定时器。 */
	private readonly idleTtlMs: number;
	private readonly maxResidentSessions: number;
	private readonly sweepIntervalMs: number;
	private sweepTimer?: ReturnType<typeof setInterval>;
	private shuttingDown = false;
	private readonly shutdownTimeoutMs: number;

	constructor(private deps: ConversationManagerDeps) {
		// 对齐 hermes 的做法：**不设固定总时长**（长时间跑测试是正常的），
		// 只在「完全没有事件产出」时才判定卡死 —— 空闲超时。
		this.runIdleTimeoutMs = deps.runIdleTimeoutMs ?? 600_000;
		this.runMaxDurationMs = deps.runMaxDurationMs ?? 0;
		this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 2_000;
		this.now = deps.now ?? Date.now;
		this.pendingFile = deps.pendingFile ?? "";
		this.pendingEnabled = Boolean(deps.pendingFile);
		this.pendingStore = this.pendingEnabled ? new PendingStore(this.pendingFile, { now: this.now }) : undefined;
		this.conversationStore = deps.conversationFile
			? new ConversationStore(deps.conversationFile, { now: this.now })
			: undefined;
		this.idleTtlMs = Math.max(0, deps.config.sessionLifecycle?.idleTtlMs ?? 30 * 60_000);
		this.maxResidentSessions = Math.max(1, deps.config.sessionLifecycle?.maxResidentSessions ?? 32);
		this.sweepIntervalMs = Math.max(1_000, deps.config.sessionLifecycle?.sweepIntervalMs ?? 60_000);
		this.rateBudget = new RateBudget();
		if (deps.editMessage) {
			this.liveChannel = new LiveChannel({ edit: deps.editMessage, budget: this.rateBudget, log: deps.log });
			this.progressWriter = new SerialWriter({ edit: deps.editMessage, log: deps.log });
		}
	}

	/** 工具事件 → 进度消息更新（pi.on("tool_execution_start/end") 转接）。 */
	onToolEvent(sessionId: string, toolName: string, kind: "start" | "end", args?: Record<string, unknown>, toolCallId?: string): void {
		const sess = [...this.sessions.values()].find((s) => s.sessionId === sessionId);
		if (!sess) return;
		// 用 conversationKey 索引（sessionId 在 createSession 前为 undefined，不可作 key）
		const st = this.progressBySession.get(sess.conversationKey) ?? { lastUpdateAt: 0, toolStack: [] };
		st.tools ??= [];
		if (kind === "start") {
			st.toolStack.push(toolName);
			// P1-02：同 toolCallId 的重复 start 不重复入栈（SDK 重试/重放）
			if (!toolCallId || !st.tools.some((entry) => entry.toolCallId === toolCallId)) {
				st.tools.push({
					toolCallId, toolName, startedAt: this.now(),
					summary: summarizeToolArgs(toolName, args),
				});
			}
			if (toolName === "bash" || toolName === "terminal") {
				// 记录最近一条命令（bash 代码块渲染，hermes supports_code_blocks 精神）
				const cmd = args?.command ?? args?.cmd;
				if (typeof cmd === "string" && cmd.trim()) st.lastCmd = cmd.trim();
			}
		} else {
			// 以 toolCallId 优先配对；缺 id 时回退到最近的同名条目
			const index = toolCallId
				? st.tools.findIndex((entry) => entry.toolCallId === toolCallId)
				: st.tools.map((entry) => entry.toolName).lastIndexOf(toolName);
			if (index >= 0) st.tools.splice(index, 1);
			const i = st.toolStack.lastIndexOf(toolName);
			if (i >= 0) st.toolStack.splice(i, 1);
		}
		this.progressBySession.set(sess.conversationKey, st);
		void this.renderProgress(sess, st);
	}

	private async renderProgress(sess: BridgeSession, st: {
		messageId?: string; lastUpdateAt: number; toolStack: string[]; lastCmd?: string;
		tools?: Array<{ toolCallId?: string; toolName: string; startedAt: number; summary?: string }>;
		thinking?: string;
	}): Promise<void> {
		if (!this.deps.editMessage) return;
		if (this.liveChannel?.hasContent(sess.conversationKey)) return;
		const now = Date.now();
		if (now - st.lastUpdateAt < this.progressMinIntervalMs) return; // 节流
		st.lastUpdateAt = now;
		if (!st.messageId) return; // 进度消息还没发（或已撤回）
		const lines: string[] = [];
		if (st.tools && st.tools.length > 0) {
			// P1-02：带 toolCallId 的条目可展示耗时与脱敏摘要；工具风暴时折叠
			const shown = st.tools.slice(-this.progressMaxLines);
			if (st.tools.length > shown.length) lines.push(`🔧 另有 ${st.tools.length - shown.length} 个工具在运行`);
			for (const entry of shown) {
				const elapsed = Math.max(0, now - entry.startedAt);
				const cost = elapsed >= 1_000 ? ` · ${(elapsed / 1_000).toFixed(1)}s` : "";
				lines.push(`🔧 ${toolLabel(entry.toolName)}${cost}${entry.summary ? `\n   ↳ ${entry.summary}` : ""}`);
			}
		} else {
			lines.push(...st.toolStack.slice(-this.progressMaxLines).map((tool) => `🔧 ${toolLabel(tool)}`));
			if (st.lastCmd && st.toolStack.some((tool) => tool === "bash" || tool === "terminal")) {
				lines.push(`↳ ${sanitizeCommand(st.lastCmd)}`);
			}
		}
		// P1-02：思考摘要默认关闭（单独开关，仅展示 provider 公开返回的简短摘要）
		if (this.deps.config.progress?.showThinking && st.thinking) lines.push(`💭 ${st.thinking.slice(-120)}`);
		const text = lines.length ? `🤖 正在处理…
${lines.join("\n")}` : "🤖 正在处理…";
		// P0-04：进度写入与流式写入共用串行语义（同一目标永不并发，顺序确定）。
		this.progressWriter?.enqueue(st.messageId, text);
	}

	/** 优雅关闭：撤回所有进行中的进度消息与处理中表情（SIGTERM 调用）。 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.waitingPumps.length = 0;
		const tasks: Promise<unknown>[] = [];
		for (const [key, sess] of this.sessions) {
			const st = this.progressBySession.get(key);
			if (st?.messageId && this.deps.recallMessage) {
				const messageId = st.messageId;
				st.messageId = undefined;
				// P0-04：先 drain 再撤回，避免关闭期间还有迟到写入落到已撤回消息上。
				tasks.push((async () => {
					await this.progressWriter?.drain(messageId);
					await this.deps.recallMessage!(messageId);
				})().catch(() => false));
			}
			for (const item of sess.queue) {
				if (item.emojiReactionId && this.deps.reactions) {
					tasks.push(this.deps.reactions.remove(item.messageId, item.emojiReactionId).catch(() => false));
				}
			}
			// 未开始的消息保留在 pending ledger，交给下次启动恢复；关闭期间不得继续消费。
			sess.queue.length = 0;
			const activeItem = this.activeItems.get(key);
			if (activeItem?.emojiReactionId && this.deps.reactions) {
				tasks.push(this.deps.reactions.remove(activeItem.messageId, activeItem.emojiReactionId).catch(() => false));
				activeItem.emojiReactionId = undefined;
			}
			if (sess.agent) {
				const agent = sess.agent;
				sess.agent = undefined;
				sess.sessionId = undefined;
				tasks.push((async () => {
					if (sess.activeRun) {
						try { await agent.abort(); } catch { /* best effort */ }
					}
					try { await agent.dispose(); } catch { /* best effort */ }
				})());
			}
		}
		this.progressBySession.clear();
		await Promise.allSettled(tasks.map((task) => this.settleWithinShutdown(task)));
		await Promise.allSettled([...this.runningPumps].map((task) => this.settleWithinShutdown(task)));
	}

	private async settleWithinShutdown(task: Promise<unknown>): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, this.shutdownTimeoutMs);
			timer.unref?.();
		});
		try { await Promise.race([task.then(() => undefined, () => undefined), timeout]); }
		finally { if (timer) clearTimeout(timer); }
	}

	/** 启动时恢复上次中断的未完成消息（hermes resume_pending）。 */
	async recoverPending(): Promise<number> {
		if (!this.pendingEnabled) return 0;
		const entries = this.pendingStore?.recoverable() ?? [];
		for (const e of entries) {
			this.deps.log?.("warn", "feishu.conv.recover_pending", { chatId: e.message.chatId, messageId: e.message.messageId });
			if (e.replayPolicy === "manual") {
				const handled = await this.notify(
					e.message.chatId,
					"上次任务在工具执行期间中断。为避免重复副作用，系统未自动重跑；请确认现场后重新发送任务。",
					{ replyTo: e.message.messageId, threadId: e.message.threadId },
					`${e.message.messageId}:recovery-manual`,
					e.conversationKey,
					"error",
				);
				if (handled) this.pendingStore?.ack(e.id);
				continue;
			}
			await this.route({ ...e.message, raw: undefined }, { pendingClaimed: true, conversationKey: e.conversationKey });
		}
		return entries.length;
	}

	private clearPending(item: QueuedMessage): void {
		this.pendingStore?.ack(item.messageId);
	}

	count(): number {
		return this.sessions.size;
	}

	/**
	 * 入站流水线用的持久接管账本（P0-01）：准入通过即写账，使合并窗口内崩溃可恢复。
	 * 返回 undefined 表示 pending ledger 未启用，调用方需退化为纯内存行为。
	 */
	intakeLedger(): IntakeLedger | undefined {
		const store = this.pendingStore;
		if (!store) return undefined;
		return {
			claim: (msg, conversationKey) => {
				store.claim(msg, conversationKey);
			},
			has: (id) => store.has(id),
			merge: (primaryId, memberIds, merged) => {
				store.mergeInto(
					primaryId,
					memberIds,
					merged as Omit<FeishuInboundMessage, "raw">,
					merged.sourceMessageIds ?? memberIds,
				);
			},
		};
	}

	listKeys(): string[] {
		return [...this.sessions.keys()];
	}

	queueStats(): { queued: number; active: number; waiting: number } {
		return {
			queued: [...this.sessions.values()].reduce((total, session) => total + session.queue.length, 0),
			active: this.activePumpCount,
			waiting: this.waitingPumps.length,
		};
	}

	routeForSessionId(sessionId: string): { conversationKey: string; chatId: string; threadId?: string; sourceMessageId?: string; runId?: string; senderId?: string } | undefined {
		const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === sessionId);
		if (!session) return undefined;
		const active = this.activeItems.get(session.conversationKey);
		return {
			conversationKey: session.conversationKey,
			chatId: session.chatId,
			threadId: session.threadId,
			sourceMessageId: active?.messageId,
			runId: active?.runId,
			// 审批免审判定用这个而不是解析 conversationKey（后者在私聊/话题下拿不到用户）
			senderId: active?.senderId,
		};
	}

	/** tool_call hook 在工具真正执行前调用，防止崩溃恢复时重复外部副作用。 */
	markPendingToolBoundary(sessionId: string): void {
		const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === sessionId);
		if (!session) return;
		const item = this.activeItems.get(session.conversationKey);
		if (item) this.pendingStore?.markManual(item.messageId);
		for (const steered of session.steered) this.pendingStore?.markManual(steered.messageId);
	}

	/**
	 * 路由入站消息：同 chat 串行（排队），跨 chat 并行。
	 * 回复链路：入站 replyToText 注入提示词；出站 send 挂 chat 上一条 bot 消息。
	 */
	async route(
		msg: FeishuInboundMessage,
		options: { pendingClaimed?: boolean; conversationKey?: string; behavior?: "auto" | "queue" | "steer" } = {},
	): Promise<"queued" | "steered" | "rejected"> {
		if (this.shuttingDown) throw new Error("conversation manager is shutting down");
		// 会话 key（对齐 hermes build_session_key）：
		// 1. 话题消息：chatId:t:threadId → 话题独立会话（thread_sessions_per_user=false：
		//    话题内所有参与者共享同一话题会话——B 回复 A 的话题消息复用同一上下文）
		// 2. 群普通消息：groupSessionsPerUser=true → chatId:u:senderId
		//    （B 在主聊天发无关联新消息 → B 自己的新会话）
		// 3. 私聊：chatId（p2p chat）
		const key = options.conversationKey ?? buildConversationKey(msg, this.deps.config);
		const sess = this.getOrCreateSession(msg, key);

		const queued: QueuedMessage = {
			runId: randomUUID(),
			chatId: msg.chatId,
			messageId: msg.messageId,
			text: msg.text,
			resources: msg.resources ?? [],
			replyToMessageId: msg.replyToMessageId,
			replyToText: msg.replyToText,
			threadId: msg.threadId,
			senderId: msg.senderId,
		};
		if (sess.queue.length >= MAX_QUEUE) {
			this.deps.log?.("warn", "feishu.conv.queue_full", { chatId: key });
			await this.notify(msg.chatId, "消息过多，当前队列已满，请稍后再试。", {
				replyTo: msg.messageId,
				threadId: msg.threadId,
			}, `${msg.messageId}:queue-full`, key);
			// 流水线已在准入后提前接管（P0-01）；明确拒绝时清除该记录，避免重启后重放被拒消息。
			this.pendingStore?.ack(msg.messageId);
			return "rejected";
		}
		if (!options.pendingClaimed) this.pendingStore?.claim(msg, key);
		// 处理中表情（hermes 式）：确认可入队后添加，runOne 结束后撤回
		if (this.deps.config.reaction.enabled && this.deps.reactions) {
			try {
				const reactionId = await this.deps.reactions.add(msg.messageId, this.deps.config.reaction.processingEmoji);
				queued.reactionId = msg.messageId;
				queued.emojiReactionId = reactionId ?? "";
			} catch { /* reaction 失败不影响已持久接管的消息 */ }
		}
		if (options.behavior !== "queue" && await this.trySteer(sess, queued)) return "steered";

		sess.queue.push(queued);
		if (!sess.activeRun) {
			sess.activeRun = true;
			this.schedulePump(sess);
		}
		return "queued";
	}

	/** 普通忙碌消息与 /steer 都优先注入当前 Pi run；空闲时退化为普通新 turn。 */
	async steerConversation(msg: FeishuInboundMessage): Promise<"queued" | "steered" | "rejected"> {
		return this.route(msg, { behavior: "steer" });
	}

	/** /queue 始终排成独立完整 turn，不受忙碌时默认 steer 行为影响。 */
	async queueConversation(msg: FeishuInboundMessage): Promise<"queued" | "rejected"> {
		const result = await this.route(msg, { behavior: "queue" });
		return result === "rejected" ? "rejected" : "queued";
	}

	private async prepareAgentInput(item: QueuedMessage): Promise<{
		text: string;
		images?: import("../types.js").PiImageContent[];
		resources?: ResolvedTurnResources;
	}> {
		let text = item.text;
		let resources: ResolvedTurnResources | undefined;
		if (item.resources.length > 0 && this.deps.resourceResolver) {
			resources = await this.deps.resourceResolver.resolve(item.resources);
			text += resources.promptSuffix;
		}
		if (item.replyToMessageId && item.replyToText) {
			const quote = item.replyToText.slice(0, 500).replace(/@_user_\w+/g, "@").replace(/\n/g, " ");
			const replyingToSelf = Boolean(this.deps.lastSent?.has(item.replyToMessageId));
			text = replyingToSelf
				? `[你正在回复自己上一条消息，原文："${quote}"]\n\n${text}`
				: `[正在回复的消息原文："${quote}"]\n\n${text}`;
		}
		return { text, images: resources?.images, resources };
	}

	/**
	 * 标记会话的 run 有活动（收到任意 agent 事件时调用），重置空闲计时器。
	 * 对齐 hermes 的做法：不做固定总时长超时（跑长测试是正常的），
	 * 只在「完全无产出」时判定卡死。
	 */
	touchRunActivity(sess: BridgeSession): void {
		if (this.runIdleTimeoutMs <= 0 || !sess.runIdleReject) return;
		if (sess.runIdleTimer) clearTimeout(sess.runIdleTimer);
		sess.runIdleTimer = setTimeout(() => {
			this.deps.log?.("warn", "feishu.conv.run_idle_timeout", { chatId: sess.chatId, idleMs: this.runIdleTimeoutMs });
			sess.runIdleReject?.(new Error("run idle timeout"));
		}, this.runIdleTimeoutMs);
		sess.runIdleTimer.unref?.();
	}

	/**
	 * P2-02：解析工作区别名 → realpath。
	 * 只接受配置中登记的别名；拒绝绝对路径、`..`、白名单外目录与不存在的路径。
	 */
	resolveWorkspace(alias: string): { ok: true; path: string } | { ok: false; reason: string } {
		const aliases = this.deps.config.workspaces?.aliases ?? {};
		if (!alias) return { ok: false, reason: "缺少工作区别名" };
		if (alias.includes("/") || alias.includes("\\") || alias.includes("..")) {
			return { ok: false, reason: "只接受配置中的别名（不接受路径）" };
		}
		const configured = aliases[alias];
		if (!configured) return { ok: false, reason: `未登记的工作区别名：${alias}` };
		let real: string;
		try {
			real = realpathSync(configured);
			if (!statSync(real).isDirectory()) return { ok: false, reason: `工作区不是目录：${alias}` };
		} catch {
			return { ok: false, reason: `工作区不可访问：${alias}` };
		}
		return { ok: true, path: real };
	}

	/** P2-02：查看当前会话工作区（只显示别名与是否启用，不泄露绝对路径）。 */
	workspaceInfo(msg: FeishuInboundMessage): string {
		const aliases = Object.keys(this.deps.config.workspaces?.aliases ?? {});
		if (aliases.length === 0) return "未配置受控工作区（如需启用，请在 config.json 的 workspaces.aliases 登记别名）";
		const key = buildConversationKey(msg, this.deps.config);
		const pointer = this.conversationStore?.get(key);
		const current = this.workspaceAliasByKey.get(key) ?? pointer?.workspace ?? this.sessions.get(key)?.workspaceAlias;
		return `当前工作区：${current ?? "默认工作区"}\n可用别名：${aliases.join(" / ")}`;
	}

	/**
	 * P2-02：切换工作区（仅管理员；忙碌拒绝）。
	 * 先校验别名 → 新建该工作区会话 → 落盘指针 → 处置旧句柄 → 旧审批/澄清失效。
	 * 失败时保留当前工作区；**绝不修改进程 cwd**。
	 */
	async switchWorkspace(msg: FeishuInboundMessage, alias?: string, options: { isAdmin?: boolean } = {}): Promise<string> {
		if (!alias) return this.workspaceInfo(msg);
		if (!options.isAdmin) return "仅管理员可切换工作区";
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		const busy = (session?.queue.length ?? 0) + (session?.steered.length ?? 0) + (session?.activeRun ? 1 : 0) + (this.activeItems.has(key) ? 1 : 0);
		if (busy > 0) return "当前会话仍在执行或有排队任务，请先 /stop 再切换工作区";

		const resolved = this.resolveWorkspace(alias);
		if (!resolved.ok) return resolved.reason;
		const current = this.workspaceAliasByKey.get(key) ?? session?.workspaceAlias;
		if (current === alias) return `当前已经是工作区 ${alias}`;

		// ① 先落盘指针（失败则不切换）
		const pointerFile = this.conversationStore?.get(key)?.sessionFile;
		if (this.conversationStore && pointerFile) {
			try {
				this.conversationStore.set({ conversationKey: key, sessionFile: pointerFile, generation: (this.conversationStore.get(key)?.generation ?? 0) + 1, workspace: alias });
			} catch {
				return "工作区指针写入失败，已保留当前工作区";
			}
		}
		this.workspaceAliasByKey.set(key, alias);
		// ② 处置旧句柄与会话状态（下一条消息在新工作区懒建会话）
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		const previous = session?.agent;
		if (previous) {
			try { await previous.dispose(); } catch { /* best effort */ }
		}
		// ③ 旧审批/澄清一律失效（旧卡片不得影响新工作区）
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		this.deps.log?.("info", "feishu.conv.workspace_switched", { conversationKey: key, alias });
		return `已切换到工作区 ${alias}；下一条消息将在该工作区新建会话（进程 cwd 未改变）`;
	}

	/**
	/**
	 * P2-03：无 durable outbox 时的直发通知（工具反馈里会标明「已投递」而非「已排队」）。
	 */
	async notifyNow(chatId: string, text: string, opts: { replyTo?: string; threadId?: string }, dedupeKey: string): Promise<{ success: boolean; error?: string }> {
		const res = await this.deps.sender.send(chatId, text, opts);
		this.deps.log?.("info", "feishu.conv.notify_sent", { chatId, dedupeKey, success: res.success });
		return { success: res.success, error: res.error };
	}

	/** P1-04：本会话可访问的历史会话（选择 id 形如 #N，最近在前）。 */
	async listSessionsFor(msg: FeishuInboundMessage, page = 0): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const pointer = this.conversationStore?.get(key);
		if (!pointer) return "当前会话尚无历史记录（/new 之后会保留上一段会话）";
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch {
			return "会话列表获取失败，请稍后重试";
		}
		if (!agent.listSessions) return "当前 Pi 版本不支持列出会话";
		let infos: Array<{ path: string; name?: string; modified: number; messageCount: number }>;
		try {
			infos = await agent.listSessions();
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.list_sessions_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return "会话列表获取失败，请稍后重试";
		}
		// 归属过滤：只显示本会话指针索引内的文件，绝不列出会话目录里的其他会话
		const ordered = [pointer.sessionFile, ...(pointer.history ?? []).map((entry) => entry.sessionFile)];
		const byPath = new Map(infos.map((info) => [info.path, info]));
		const entries = ordered.map((file, index) => ({
			selector: `#${index + 1}`,
			sessionFile: file,
			info: byPath.get(file),
			isCurrent: file === pointer.sessionFile,
		}));
		const pageSize = 10;
		const pages = Math.max(1, Math.ceil(entries.length / pageSize));
		const current = Math.min(Math.max(0, page), pages - 1);
		const slice = entries.slice(current * pageSize, current * pageSize + pageSize);
		const lines = slice.map((entry) => {
			const name = entry.info?.name?.trim() || "未命名会话";
			const when = entry.info ? formatRelative(entry.info.modified, this.now()) : "未知时间";
			const count = entry.info ? `${entry.info.messageCount} 条` : "文件缺失";
			return `${entry.selector} · ${name}（${when}，${count}）${entry.isCurrent ? " · 当前" : ""}`;
		});
		const footer = [
			`共 ${entries.length} 段`,
			pages > 1 ? `第 ${current + 1}/${pages} 页` : "",
			current + 1 < pages ? `下一页：/sessions ${current + 1}` : "",
			"用 /resume <选择 id> 恢复；/name <名称> 命名当前会话",
		].filter(Boolean).join("　");
		return `本会话历史\n${lines.join("\n")}\n\n${footer}`;
	}

	/** P1-04：重命名当前会话（写入 Pi transcript 的 session_info）。 */
	async renameConversation(msg: FeishuInboundMessage, rawName?: string): Promise<string> {
		const name = (rawName ?? "").trim();
		if (!name) return "用法：/name <名称>（最多 60 字）";
		if (name.length > 60) return "名称过长（最多 60 字）";
		// 去掉控制字符，避免落进 transcript 造成渲染/解析问题
		const cleaned = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
		if (!cleaned) return "名称不合法（仅含控制字符）";
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch {
			return "会话初始化失败，请稍后重试";
		}
		if (!agent.setSessionName) return "当前 Pi 版本不支持重命名会话";
		try {
			agent.setSessionName(cleaned);
		} catch (error) {
			return `重命名失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		return `已将会话命名为：${cleaned}`;
	}

	/**
	 * P1-05：恢复历史会话。只接受本会话列表内的选择 id（不接受任意路径），
	 * 忙碌/有排队时拒绝；先落盘指针再切运行态，失败保留当前会话。
	 */
	async resumeConversation(msg: FeishuInboundMessage, rawSelector?: string): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		if (!this.conversationStore) return "当前部署未启用会话索引，无法恢复";
		const pointer = this.conversationStore.get(key);
		if (!pointer) return "当前会话尚无历史记录，无法恢复";
		const session = this.sessions.get(key);
		const pending = (session?.queue.length ?? 0) + (session?.steered.length ?? 0) + (this.activeItems.has(key) ? 1 : 0);
		if (session?.activeRun || pending > 0) return "当前会话仍在执行或有排队任务，请先 /stop 或处理队列后再恢复";

		const match = /^#(\d+)$/.exec((rawSelector ?? "").trim());
		if (!match) return "用法：/resume <选择 id>（先用 /sessions 查看）";
		const index = Number.parseInt(match[1], 10);
		const ordered = [pointer.sessionFile, ...(pointer.history ?? []).map((entry) => entry.sessionFile)];
		const target = ordered[index - 1];
		if (!target) return `选择 id 无效：${rawSelector}（先用 /sessions 查看）`;
		if (target === pointer.sessionFile) return "该会话已经是当前会话";
		if (!existsSync(target)) return "目标会话文件不存在，已保留当前会话";

		// ① 先原子落盘指针：失败则不切换（避免重启后状态不一致）
		try {
			this.conversationStore.set({ conversationKey: key, sessionFile: target, generation: pointer.generation + 1 });
		} catch {
			return "会话指针写入失败，已保留当前会话";
		}
		// ② 处置旧 handle 与易失状态（Pi 历史、pending、outbox 不动）
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		const old = session?.agent;
		if (old) {
			try { await old.dispose(); } catch { /* best effort */ }
		}
		// ③ P0-03：旧审批卡一律失效（不携带 runId → 按会话全量撤销）
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		this.deps.log?.("info", "feishu.conv.session_resumed", { conversationKey: key, selector: rawSelector });
		return `已恢复会话 ${rawSelector}；下一条消息将在该会话继续`;
	}

	/** 当前会话的名称（/sessions 之外的诊断用）。 */
	sessionNameFor(msg: FeishuInboundMessage): string | undefined {
		const session = this.sessions.get(buildConversationKey(msg, this.deps.config));
		return session?.agent?.sessionName?.();
	}

	/**
	 * P1-06：列出已认证模型（provider 用于区分同名模型）。
	 * 首次调用会懒初始化会话，避免"当前会话尚未建立"。
	 */
	async listModels(msg: FeishuInboundMessage, page = 0): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.models_init_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return "模型列表获取失败，请稍后重试";
		}
		if (!agent.listModels) return "当前 Pi 版本不支持远程列出模型";
		let models: Array<{ id: string; provider?: string }>;
		try {
			models = await agent.listModels();
		} catch (error) {
			return `模型列表获取失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`;
		}
		if (models.length === 0) return "没有已认证的模型";

		const pageSize = 20;
		const pages = Math.max(1, Math.ceil(models.length / pageSize));
		const current = Math.min(Math.max(0, page), pages - 1);
		const slice = models.slice(current * pageSize, current * pageSize + pageSize);
		const lines = slice.map((model) => {
			const label = model.provider ? `${model.provider}/${model.id}` : model.id;
			return model.id === agent.modelId ? `· ${label}（当前）` : `· ${label}`;
		});
		// P1-06：每页都标出页码（最后一页也可见"第 N/N 页"），并给出下一页指令
		const footer = [
			pages > 1 ? `第 ${current + 1}/${pages} 页` : "",
			current + 1 < pages ? `下一页：/models ${current + 1}` : "",
		].filter(Boolean).join("　");
		return `可用模型（${models.length}）\n${lines.join("\n")}${footer ? `\n\n${footer}` : ""}`;
	}

	/** P1-06：查看或设置思考等级（仅接受当前模型可用等级；忙碌时拒绝变更）。 */
	async thinkingConversation(msg: FeishuInboundMessage, level?: string): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		if (!level && session.agent) {
			const levels = session.agent.availableThinkingLevels?.() ?? [];
			if (levels.length === 0) return "当前模型不支持思考等级";
			return `当前思考等级：${session.agent.thinkingLevel?.() || "未知"}\n可用：${levels.join(" / ")}`;
		}
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch (error) {
			return "思考等级会话初始化失败，请稍后重试";
		}
		const levels = agent.availableThinkingLevels?.() ?? [];
		if (levels.length === 0) return "当前模型不支持思考等级";
		if (!level) return `当前思考等级：${agent.thinkingLevel?.() || "未知"}\n可用：${levels.join(" / ")}`;
		if (session.activeRun) return "当前会话仍在执行，请稍后调整思考等级";
		if (!agent.setThinkingLevel) return "当前 Pi 版本不支持远程调整思考等级";
		if (!levels.includes(level)) return `不支持的等级：${level}\n可用：${levels.join(" / ")}`;
		agent.setThinkingLevel(level);
		// 回显实际等级（provider 会按模型能力 clamp）
		return `已设置思考等级：${agent.thinkingLevel?.() || level}`;
	}

	/** P1-08：启动空闲回收巡检（幂等）。 */
	startLifecycle(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => { void this.reclaimIdle(); }, this.sweepIntervalMs);
		this.sweepTimer.unref?.();
	}

	stopLifecycle(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
	}

	/**
	 * P1-08：回收空闲会话句柄（不删除 Pi 历史、pending 或 outbox）。
	 * 可回收条件：无 active run、无排队/steer、无未决审批、不在初始化中，且空闲超 TTL。
	 * 超过驻留上限时按 LRU 再回收一批（与 maxActiveSessions 的并发上限语义分开）。
	 */
	async reclaimIdle(now: number = this.now()): Promise<number> {
		let reclaimed = 0;
		for (const [key, session] of [...this.sessions]) {
			if (!this.canReclaim(key, session, now)) continue;
			await this.retireSession(key, session);
			reclaimed += 1;
		}
		// 驻留上限：仍超限则按最近活动时间升序回收（不触碰不可回收者）
		if (this.sessions.size > this.maxResidentSessions) {
			const candidates = [...this.sessions.entries()]
				.filter(([key, session]) => this.canReclaim(key, session, Number.POSITIVE_INFINITY))
				.sort((a, b) => (a[1].lastActivityAt ?? a[1].createdAt) - (b[1].lastActivityAt ?? b[1].createdAt));
			for (const [key, session] of candidates) {
				if (this.sessions.size <= this.maxResidentSessions) break;
				await this.retireSession(key, session);
				reclaimed += 1;
			}
		}
		return reclaimed;
	}

	/** P1-07：预算快照（status/doctor 展示限流冷却）。 */
	budgetSnapshot() {
		return this.rateBudget.snapshot();
	}

	/** P1-07：冷却提示文案（无冷却时返回 undefined）。 */
	budgetCooldownNotice(): string | undefined {
		return this.rateBudget.cooldownNotice();
	}

	/** P1-07：把 API 结果反馈给预算（限频/网络失败累计触发冷却）。 */
	recordApiOutcome(outcome: { errorClass?: string; retryAfterMs?: number; ok?: boolean }): void {
		this.rateBudget.record(outcome);
	}

	/** 当前驻留会话数（诊断用）。 */
	residentCount(): number {
		return this.sessions.size;
	}

	private canReclaim(key: string, session: BridgeSession, now: number): boolean {
		if (session.activeRun || session.creatingAgent) return false;
		if (session.queue.length > 0 || session.steered.length > 0) return false;
		if (this.activeItems.has(key)) return false;
		if ((this.deps.pendingApprovalCount?.(key) ?? 0) > 0) return false;
		const idleSince = session.lastActivityAt ?? session.createdAt;
		return now - idleSince >= this.idleTtlMs;
	}

	/** 回收单个会话句柄：先从索引移除，再（有界等待）dispose，失败只记日志。 */
	private async retireSession(key: string, session: BridgeSession): Promise<void> {
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		const agent = session.agent;
		session.agent = undefined;
		session.sessionId = undefined;
		if (!agent) return;
		const bounded = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 3_000);
			timer.unref?.();
		});
		await Promise.race([
			(async () => { try { await agent.dispose(); } catch { /* best effort */ } })(),
			bounded,
		]);
		this.deps.log?.("info", "feishu.conv.session_reclaimed", {
			conversationKey: key,
			resident: this.sessions.size,
		});
	}

	/** P1-03：final 页脚（配置关闭时返回空串）。 */
	private footerFor(metrics: ReturnType<typeof createRunMetrics>): string {
		if (!this.deps.config.footer?.enabled) return "";
		try {
			return renderFooter(metrics, {
				elapsedMs: metricsElapsedMs(metrics),
				showCost: this.deps.config.footer?.showCost !== false,
			});
		} catch {
			return "";
		}
	}

	private async trySteer(sess: BridgeSession, item: QueuedMessage): Promise<boolean> {
		const agent = sess.agent;
		if (!sess.activeRun || !agent?.steer || !this.activeItems.has(sess.conversationKey)) return false;
		sess.steered.push(item);
		let prepared: Awaited<ReturnType<ConversationManager["prepareAgentInput"]>> | undefined;
		let accepted = false;
		try {
			prepared = await this.prepareAgentInput(item);
			if (!sess.activeRun || sess.agent !== agent || !this.activeItems.has(sess.conversationKey)) return false;
			await agent.steer(prepared.text, prepared.images);
			accepted = true;
			this.deps.log?.("info", "feishu.conv.steered", {
				messageId: item.messageId, conversationKey: sess.conversationKey, runId: item.runId,
			});
			return true;
		} catch (error) {
			this.deps.log?.("warn", "feishu.conv.steer_fallback_queue", {
				messageId: item.messageId,
				conversationKey: sess.conversationKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			try { prepared?.resources?.cleanup(); } catch { /* best effort */ }
			if (!accepted) {
				const index = sess.steered.indexOf(item);
				if (index >= 0) sess.steered.splice(index, 1);
			}
		}
	}

	/**
	 * /new：切换到新会话。P0-05 语义：
	 * - 有执行中/排队任务时默认拒绝（不静默丢弃队列），force 才取消；
	 * - 先原子落盘新指针，再切运行态（避免“运行态已切、重启又回退到旧会话”）；
	 * - 指针写失败则不切换并报错，不得静默继续用旧会话。
	 */
	async resetConversation(msg: FeishuInboundMessage, options: { force?: boolean } = {}): Promise<ResetOutcome> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		const pending = (session?.queue.length ?? 0)
			+ (session?.steered.length ?? 0)
			+ (this.activeItems.has(key) ? 1 : 0);
		if (pending > 0 && !options.force) return { status: "busy", pending };

		const previous = this.conversationStore?.get(key);
		const generation = (previous?.generation ?? 0) + 1;
		const base = key.replace(/[^a-zA-Z0-9_-]/g, "_");
		const sessionFile = join(this.deps.sessionDir, `${base}-${randomUUID()}.jsonl`);

		// ① 先落盘新指针：失败则不切换（否则重启会回退到旧会话）。
		if (this.conversationStore) {
			try {
				this.conversationStore.set({ conversationKey: key, sessionFile, generation });
			} catch (error) {
				this.deps.log?.("error", "feishu.conv.pointer_write_failed", {
					conversationKey: key,
					error: error instanceof Error ? error.message : String(error),
				});
				return { status: "error", reason: "会话指针写入失败" };
			}
		} else {
			// 未配置持久指针时退化为进程内的后缀（重启后仍会回退，已由日志可见）。
			this.nextSessionSuffix.set(key, `-${randomUUID()}`);
		}

		// ② force 路径：取消执行/排队中的任务，并为每条落终态（从 ledger 移除）。
		const cancelled = [...(session?.queue ?? []), ...(session?.steered ?? [])];
		if (session) {
			session.queue.length = 0;
			session.steered.length = 0;
		}
		for (const item of cancelled) this.clearPending(item);

		// ③ 切运行态。
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		if (session?.agent) {
			if (session.activeRun) { try { await session.agent.abort(); } catch { /* best effort */ } }
			try { await session.agent.dispose(); } catch { /* best effort */ }
			session.agent = undefined;
		}
		// ④ P0-03：会话重置后旧审批卡一律失效（不携带 runId → 按会话全量撤销）。
		this.deps.onApprovalInvalidate?.({ conversationKey: key, reason: "reset" });
		return { status: "reset", generation, cancelled: cancelled.length };
	}

	async stopConversation(msg: FeishuInboundMessage): Promise<boolean> {
		const session = this.sessions.get(buildConversationKey(msg, this.deps.config));
		if (!session?.agent || !session.activeRun) return false;
		session.stopRequested = true;
		await session.agent.abort();
		return true;
	}

	async compactConversation(msg: FeishuInboundMessage, instructions?: string): Promise<string> {
		const session = this.sessions.get(buildConversationKey(msg, this.deps.config));
		if (!session?.agent) return "当前会话尚未建立";
		if (session.activeRun) return "当前会话仍在执行，请稍后压缩";
		if (!session.agent.compact) return "当前 Pi 版本不支持远程压缩";
		return session.agent.compact(instructions);
	}

	async modelConversation(msg: FeishuInboundMessage, modelId?: string): Promise<string> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		if (session.activeRun && !session.agent) return "当前会话正在初始化模型，请稍后重试";
		if (!modelId && session.agent) return `当前模型：${session.agent.modelId}`;
		if (session.activeRun) return "当前会话仍在执行，请稍后切换模型";
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.model_session_init_failed", {
				conversationKey: key,
				error: error instanceof Error ? error.message : String(error),
			});
			return "模型会话初始化失败，请稍后重试";
		}
		if (!modelId) return `当前模型：${agent.modelId}`;
		if (!agent.setModel) return "当前 Pi 版本不支持远程切换模型";
		return await agent.setModel(modelId) ? `已切换模型：${modelId}` : `找不到已认证模型：${modelId}`;
	}

	private getOrCreateSession(msg: FeishuInboundMessage, key: string): BridgeSession {
		const existing = this.sessions.get(key);
		if (existing) return existing;
		// P2-02：恢复该会话的工作区（别名 → realpath；配置被移除时回落到默认）
		const storedWorkspace = this.conversationStore?.get(key)?.workspace;
		const effectiveWorkspace = this.workspaceAliasByKey.get(key) ?? storedWorkspace;
		const workspaceResolved = effectiveWorkspace ? this.resolveWorkspace(effectiveWorkspace) : undefined;
		const session: BridgeSession = {
			...(workspaceResolved?.ok ? { workspaceAlias: effectiveWorkspace, workspacePath: workspaceResolved.path } : {}),
			conversationKey: key,
			chatId: msg.chatId,
			threadId: msg.threadId,
			sessionFile: resolveSessionFile(
				this.deps.sessionDir,
				key,
				this.nextSessionSuffix.get(key),
				this.conversationStore?.get(key),
				this.conversationStore,
				this.deps.log,
			),
			queue: [],
			steered: [],
			activeRun: false,
			createdAt: this.now(),
		};
		this.sessions.set(key, session);
		return session;
	}

	private async ensureAgentSession(session: BridgeSession): Promise<AgentHandle> {
		if (session.agent) return session.agent;
		if (!session.creatingAgent) {
			session.creatingAgent = this.deps.sessionBackend.createSession({
				chatId: session.chatId,
				conversationKey: session.conversationKey,
				sessionFile: session.sessionFile,
				// P2-02：按会话工作区传 cwd（未设置时不传，保持进程默认）
				...(session.workspacePath ? { cwd: session.workspacePath } : {}),
			}).then(async (agent) => {
				if (this.shuttingDown || this.sessions.get(session.conversationKey) !== session) {
					try { await agent.dispose(); } catch { /* best effort */ }
					throw new Error("conversation session was reset during initialization");
				}
				session.agent = agent;
				session.sessionId = agent.sessionId;
				return agent;
			}).finally(() => {
				session.creatingAgent = undefined;
			});
		}
		return session.creatingAgent;
	}

	private schedulePump(sess: BridgeSession): void {
		if (this.shuttingDown) return;
		if (this.activePumpCount >= Math.max(1, this.deps.config.maxActiveSessions)) {
			if (!this.waitingPumps.includes(sess)) this.waitingPumps.push(sess);
			return;
		}
		this.activePumpCount += 1;
		const running = this.pump(sess).finally(() => {
			this.activePumpCount -= 1;
			this.runningPumps.delete(running);
			const next = this.shuttingDown ? undefined : this.waitingPumps.shift();
			if (next) this.schedulePump(next);
		});
		this.runningPumps.add(running);
	}

	private async pump(sess: BridgeSession): Promise<void> {
		let processed = 0;
		try {
			while (!this.shuttingDown && sess.queue.length > 0) {
				// P2-05：公平性 —— 连续处理若干 turn 后若还有其他会话在等待，就让出执行槽。
				// 让出点只在两个完整 run 之间，绝不会打断工具执行或审批等待。
				if (processed > 0 && processed >= this.pumpTurnBatch && this.waitingPumps.length > 0) {
					this.deps.log?.("info", "feishu.conv.pump_yield", {
						conversationKey: sess.conversationKey,
						processed,
						waiting: this.waitingPumps.length,
						queued: sess.queue.length,
					});
					if (!this.waitingPumps.includes(sess)) this.waitingPumps.push(sess);
					break;
				}
				const item = sess.queue.shift();
				if (!item) break;
				this.activeItems.set(sess.conversationKey, item);
				try {
					await this.runOne(sess, item);
					processed += 1;
				} finally {
					this.activeItems.delete(sess.conversationKey);
				}
			}
		} finally {
			sess.activeRun = false;
		}
	}

	/** P2-05：调度等待量诊断（waiting 会话数 + 各会话排队与等待时长）。 */
	schedulerSnapshot(): { waiting: number; queues: Array<{ conversationKey: string; queued: number; active: boolean }> } {
		return {
			waiting: this.waitingPumps.length,
			queues: [...this.sessions.values()].map((session) => ({
				conversationKey: session.conversationKey,
				queued: session.queue.length,
				active: Boolean(session.activeRun),
			})),
		};
	}

	private async runOne(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		const logMeta = (meta: Record<string, unknown> = {}): Record<string, unknown> => ({
			messageId: item.messageId,
			conversationKey: sess.conversationKey,
			runId: item.runId,
			...meta,
		});
		sess.lastActivityAt = this.now();
		const st = this.progressBySession.get(sess.conversationKey) ?? { lastUpdateAt: 0, toolStack: [] };
		this.progressBySession.set(sess.conversationKey, st);
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		let activeAgent: BridgeSession["agent"];
		let durableHandled = false;
		let runSucceeded = false;
		let runTimedOut = false;
		// P1-03：run 级指标（模型/耗时/token/费用估算），final 页脚用。
		const metrics = createRunMetrics();
		let resolvedResources: ResolvedTurnResources | undefined;
		// P1-01：流式卡片句柄（默认关闭）。声明在 try 外，finally 里才能收尾。
		let streamCard: StreamingCard | undefined;
		// P1-01：启用流式卡片时，卡片本身就是「处理中」的可见载体，
		// 不再发「正在处理…」进度消息，也不开 liveChannel ——
		// 否则同一条消息会被文本编辑与卡片两套机制争用，出现 `[Invalid text JSON]` 这类坏内容。
		const cardMode = Boolean(this.deps.config.streamingCard?.enabled && this.deps.rawRequest);
		this.deps.log?.("info", "feishu.conv.card_mode", {
			cardMode,
			configured: Boolean(this.deps.config.streamingCard?.enabled),
			hasRawRequest: Boolean(this.deps.rawRequest),
			throttleMs: this.deps.config.streamingCard?.throttleMs,
		});
		try {
			if (!cardMode) {
				// 方案 A：处理中进度消息（回复挂载用户消息；完成后撤回）
				const sent = await this.deps.sender.send(item.chatId, "🤖 正在处理…", {
					replyTo: item.messageId,
					threadId: sess.threadId ?? item.threadId,
				});
				if (sent.success && sent.messageId) {
					st.messageId = sent.messageId;
					st.startedAt = Date.now();
					this.liveChannel?.open(sess.conversationKey, sent.messageId);
				}
			}
			if (this.shuttingDown) throw new Error("bridge shutting down");

			activeAgent = await this.ensureAgentSession(sess);
			// shutdown 可能发生在异步 session 初始化完成之后、prompt 开始之前。
			if (this.shuttingDown || sess.agent !== activeAgent) throw new Error("bridge shutting down");

			// 流式/完成事件：从 subscribe 事件提取回复文本（pi SDK 的 prompt() 返回值
			// 结构不可靠，pi-feishu-link 同样走事件通道：message_update.text_delta 累积、
			// message_end.content 完整提取）。
			let streamedText = "";
			// 卡片用累积文本：`streamedText` 会在每轮 message_end/turn_end 清空
			// （多轮工具场景只保留最后一轮作为最终答案），但卡片要展示"到目前为止的全部输出"，
			// 所以单独维护一份不清空的累积值 —— 否则卡片永远只拿到空串（实测 deltaCount=1053 而 streamedLen=0）。
			let cardText = "";
			let deltaCount = 0;
			// 埋点：模型真实输出窗口（用来把「模型慢」和「卡片拖慢」分开）
			let firstDeltaAt: number | undefined;
			let lastDeltaAt: number | undefined;
			let lastEndText = "";
			let agentError: string | undefined;
			let sentFromEvent = false;
			const preparedInput = await this.prepareAgentInput(item);
			const injectedPrompt = preparedInput.text;
			resolvedResources = preparedInput.resources;
			const sendReply = async (text: string): Promise<void> => {
				if (sentFromEvent || !text.trim()) return;
				try {
					this.deps.log?.("debug", "feishu.conv.send_reply_start", logMeta({ chatId: sess.chatId, textLen: text.length }));
					// 模型偶发复述注入的引用块/提示：剥离后发送
					const cleaned = stripInjectedPrompt(text, injectedPrompt);
					if (!cleaned.trim()) {
						// 纯引用残留（无实际内容）：静默跳过，不报错
						this.deps.log?.("debug", "feishu.conv.empty_after_strip", logMeta({ chatId: sess.chatId }));
						durableHandled = true;
						return;
					}
					// 回复挂用户消息（hermes: reply_to = source.message_id）；
					// 话题会话发送到话题（threadId 优先会话级，其次消息级）
					const liveMessageId = await this.liveChannel?.claimFinalTarget(sess.conversationKey);
					const sendOpts = {
						replyTo: item.messageId,
						threadId: sess.threadId ?? item.threadId,
						editMessageId: liveMessageId,
					};
					let envelopeId: string | undefined;
					const res = this.deps.durableOutbox
						? (() => {
							const ids = this.deps.durableOutbox!.enqueue(sess.chatId, cleaned, sendOpts, {
								dedupeKey: `${item.messageId}:final`, laneKey: sess.conversationKey, kind: "final",
							});
							envelopeId = ids[0];
							return { success: ids.length > 0, messageId: undefined, error: undefined, fallback: undefined };
						})()
						: await this.deps.sender.send(sess.chatId, cleaned, sendOpts);
					if (res.success) {
						sentFromEvent = true;
						durableHandled = true;
						if (liveMessageId) st.messageId = undefined;
					}
					this.deps.log?.("info", "feishu.conv.reply_sent", logMeta({
						chatId: sess.chatId,
						envelopeId,
						success: res.success,
						sentMessageId: res.messageId,
						error: res.error,
						fallback: res.fallback,
						textLen: text.trim().length,
					}));
				} catch (err) {
					this.deps.log?.("error", "feishu.conv.send_error", logMeta({
						chatId: sess.chatId,
						error: err instanceof Error ? err.message : String(err),
					}));
				}
			};
			unsubscribe = activeAgent.subscribe((ev) => {
				// 任何事件都算「有产出」：重置空闲计时器（长时间工具/长回答不该被误杀）
				this.touchRunActivity(sess);
				// message_update 风暴降噪：只打非 text_delta 的 update（tool 事件等）
				const evType = (ev as { type?: string })?.type ?? "?";
				if (evType === "message_update") {
					const ame = (ev as { assistantMessageEvent?: { type?: string } })?.assistantMessageEvent;
					if (ame?.type === "text_delta") {
						// 静默：纯流式文本
					} else {
						this.deps.log?.("debug", "feishu.conv.event", logMeta({
							chatId: sess.chatId,
							type: evType,
							sub: ame?.type ?? (ev as { delta?: unknown }).delta !== undefined ? "delta" : "other",
						}));
					}
				} else {
					this.deps.log?.("debug", "feishu.conv.event", logMeta({
						chatId: sess.chatId,
						type: evType,
					}));
				}
				const adapted = adaptAgentEvent(ev);
				if (adapted?.type === "text_delta") {
					deltaCount += 1;
					const nowMs = Date.now();
					firstDeltaAt ??= nowMs;
					lastDeltaAt = nowMs;
					streamedText += adapted.delta;
					cardText += adapted.delta;
					this.liveChannel?.append(sess.conversationKey, adapted.delta);
					streamCard?.update(cardText);
					return;
				}
				if (adapted?.type === "message_end") {
					// 关键：user 消息也会触发 message_end（role=user），须先检查 role
					// （对齐 pi-feishu-link handleMessageEnd 的 role==='assistant' 检查）。
					// 多轮 agent：工具轮（stopReason=toolUse）也会 message_end——
					// 只记最后一轮文本，prompt() resolve（= agent 全部结束）后统一发送，
					// 避免中间轮文本（如"好的，再展开一层…"）被当最终回复发出。
					if (adapted.role !== "assistant") return;
					// P1-03：assistant 用量按 messageId 去重后累加（跨工具多轮，重投不重复）
					recordUsage(metrics, {
						messageId: adapted.messageId, provider: adapted.provider,
						model: adapted.model, usage: adapted.usage,
					});
					if (adapted.stopReason === "error") {
						agentError = adapted.errorMessage?.trim() || "模型未返回具体错误信息";
						this.deps.log?.("error", "feishu.conv.agent_error_event", logMeta({
							chatId: sess.chatId,
							error: agentError,
							agentMessageId: adapted.messageId,
						}));
					} else {
						// SDK 重试可能在错误轮后补发成功轮；最终成功结果应清除暂存错误。
						agentError = undefined;
					}
					const text = adapted.text;
					this.deps.log?.("debug", "feishu.conv.message_end_extract", logMeta({
						chatId: sess.chatId,
						textLen: text?.length ?? 0,
						agentMessageId: adapted.messageId,
					}));
					if (text) lastEndText = text;
					streamedText = ""; // 新一轮从零累积
					return;
				}
				// P1-02：思考摘要仅在开启时累积（不持久化完整 reasoning）
				if (adapted?.type === "reasoning_delta" && this.deps.config.progress?.showThinking) {
					st.thinking = `${st.thinking ?? ""}${adapted.delta}`.slice(-500);
				}
				if (adapted?.type === "turn_end" && adapted.text) {
					lastEndText = adapted.text;
					streamedText = "";
				}
			});

			// 组装提示词（回复链路可见性：B1）——对齐 hermes 的回复注入格式：
			// `[Replying to: "原文"]` 方括号元信息（非对话内容，模型不易复述）；
			// 区分回复自己消息 vs 回复他人消息；原文截断 500、占位转 @。
			// P1-01：启用时先建流式卡片；失败就静默降级（下面走原文本通道）
			if (cardMode) {
				streamCard = new StreamingCard({
					rawRequest: (opts) => { const rr = this.deps.rawRequest; if (!rr) throw new Error("rawRequest unavailable"); return rr(opts); },
					log: (level, message, meta) => this.deps.log?.(level, message, meta),
					throttleMs: this.deps.config.streamingCard?.throttleMs,
					printFrequencyMs: this.deps.config.streamingCard?.printFrequencyMs,
					printStep: this.deps.config.streamingCard?.printStep,
				});
				const started = await streamCard.start({
					chatId: sess.chatId,
					replyTo: item.messageId,
					threadId: sess.threadId ?? item.threadId,
				});
				if (!started) streamCard = undefined;
			}

			// 周期刷新进度消息（增量更新：长时间处理时持续展示耗时与工具状态）
			progressTimer = setInterval(() => {
				void this.renderProgress(sess, st);
			}, 8000);

			// 双计时器：
			// - 空闲计时器：每次事件重置；长时间无产出才判卡死（默认 10 分钟）
			// - 总时长上限：仅当显式配置 > 0 时生效（默认不限，避免长任务被硬杀）
			const timeout = new Promise<never>((_, reject) => {
				sess.runIdleReject = reject;
				if (this.runIdleTimeoutMs > 0) this.touchRunActivity(sess);
				if (this.runMaxDurationMs > 0) {
					timeoutTimer = setTimeout(() => reject(new Error("run max duration exceeded")), this.runMaxDurationMs);
				}
			});
			const result = await Promise.race([activeAgent.prompt(injectedPrompt, preparedInput.images), timeout]);
			if (agentError) throw new Error(agentError);

			// 最终发送：最后一轮 message_end 文本优先，其次流式累积/返回值
			const rawText = lastEndText || streamedText.trim() || extractAssistantText(result);
			const footer = this.footerFor(metrics);
			const text = rawText && footer ? `${rawText}\n\n${footer}` : rawText;
			this.deps.log?.("info", "feishu.conv.stream_stats", logMeta({
				chatId: sess.chatId,
				deltaCount,
				streamedLen: streamedText.length,
				lastEndLen: lastEndText.length,
				textLen: text?.length ?? 0,
				cardActive: Boolean(streamCard),
				modelWindowMs: firstDeltaAt && lastDeltaAt ? lastDeltaAt - firstDeltaAt : 0,
				modelCharsPerSec: firstDeltaAt && lastDeltaAt && lastDeltaAt > firstDeltaAt
					? Math.round((cardText.length / ((lastDeltaAt - firstDeltaAt) / 1000)) * 10) / 10 : 0,
			}));
			let cardDelivered = false;
			if (streamCard && text) {
				// 卡片承载最终答案：成功则不再重复发文本（失败则落回下面的 durable 文本通道）
				cardDelivered = await streamCard.finish(text);
				if (cardDelivered) {
					// 卡内容已由飞书侧持久化，等价于「final 已交付」；
					// 必须同时置 durableHandled，否则接管账本不会 ack，重启后会把同一条消息重放成重复任务。
					durableHandled = true;
				} else {
					this.deps.log?.("warn", "feishu.stream_card.fallback_to_text", logMeta({ chatId: sess.chatId }));
				}
				streamCard = undefined;
			}
			if (text && !cardDelivered) await sendReply(text);
			else if (!text) durableHandled = true;
			runSucceeded = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const isRunTimeout = msg === "run idle timeout" || msg === "run max duration exceeded";
			if (isRunTimeout) runTimedOut = true;
			if (activeAgent && sess.agent === activeAgent) {
				if (isRunTimeout) {
					try { await activeAgent.abort(); } catch { /* best effort */ }
				}
				try { await activeAgent.dispose(); } catch { /* best effort */ }
				sess.agent = undefined;
				sess.sessionId = undefined;
			}
			if (sess.stopRequested) {
				// 用户主动 /stop：确认消息由命令路径负责，当前 turn 不再伪装成执行错误。
				durableHandled = true;
				this.deps.log?.("info", "feishu.conv.run_cancelled_by_user", logMeta({ chatId: sess.chatId }));
			} else if (this.shuttingDown) {
				// shutdown/abort 不是面向用户的执行失败；pending 保留供重启恢复。
				this.deps.log?.("info", "feishu.conv.run_cancelled_by_shutdown", logMeta({
					chatId: sess.chatId,
					messageId: item.messageId,
					conversationKey: sess.conversationKey,
				}));
			} else if (isRunTimeout) {
				// 说明「多久没动静」而不是「总共跑了多久」——两者语义不同，用户需要能区分
				const idleLabel = this.runIdleTimeoutMs >= 60_000
					? `${Math.round(this.runIdleTimeoutMs / 60_000)} 分钟`
					: `${Math.round(this.runIdleTimeoutMs / 1000)} 秒`;
				const timeoutText = msg === "run idle timeout"
					? `任务已 ${idleLabel} 没有新进展，已中止（不是总时长限制）。长时间无输出的任务可把 runIdleTimeoutMs 调大。`
					: "任务超过配置的最长执行时间，已中止。";
				durableHandled = await this.notify(sess.chatId, timeoutText, {
					replyTo: item.messageId,
					threadId: sess.threadId ?? item.threadId,
				}, `${item.messageId}:timeout`, sess.conversationKey, "error");
			} else {
				this.deps.log?.("error", "feishu.conv.run_error", logMeta({ chatId: sess.chatId, error: msg }));
				durableHandled = await this.notify(sess.chatId, `处理出错：${msg.slice(0, 200)}`, {
					replyTo: item.messageId,
					threadId: sess.threadId ?? item.threadId,
				}, `${item.messageId}:error`, sess.conversationKey, "error");
			}
		} finally {
			const steered = sess.steered.splice(0);
			if (!runSucceeded && !sess.stopRequested && steered.length > 0) {
				// 当前 run 异常时，已接管的 steer 降级为独立 FIFO turn，避免静默丢失。
				sess.queue.unshift(...steered);
			}
			if (streamCard) {
				// run 异常结束时收尾卡片，避免它永远停在「正在处理…」
				await streamCard.abandon(runSucceeded ? "已完成" : "任务已中止，未产出最终答案。").catch(() => {});
				streamCard = undefined;
			}
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (sess.runIdleTimer) { clearTimeout(sess.runIdleTimer); sess.runIdleTimer = undefined; }
			sess.runIdleReject = undefined;
			if (progressTimer) clearInterval(progressTimer);
			try { unsubscribe?.(); } catch { /* best effort */ }
			const completedSteers = runSucceeded || sess.stopRequested ? steered : [];
			await Promise.allSettled([
				this.removeProcessingReaction(sess, item),
				this.finishProgress(sess, st),
				...completedSteers.map((steeredItem) => this.removeProcessingReaction(sess, steeredItem)),
			]);
			if (durableHandled) {
				this.clearPending(item);
				for (const steeredItem of completedSteers) this.clearPending(steeredItem);
			}
			sess.stopRequested = false;
			// P0-03：run 退出后未决审批一律失效（旧卡不得再授予 session/always 权限）。
			this.deps.onApprovalInvalidate?.({
				conversationKey: sess.conversationKey,
				runId: item.runId,
				reason: runSucceeded ? "completed" : sess.stopRequested ? "stopped" : this.shuttingDown ? "shutdown" : runTimedOut ? "timeout" : "failed",
			});
			try { resolvedResources?.cleanup(); } catch { /* best effort */ }
		}
	}

	/** 撤回进度消息（方案 A：正式回复前撤回，避免刷屏）。 */
	private async finishProgress(sess: BridgeSession, st: { messageId?: string; lastUpdateAt: number; toolStack: string[]; lastCmd?: string }): Promise<void> {
		try {
			this.liveChannel?.discard(sess.conversationKey);
			if (st.messageId && this.deps.recallMessage) {
				const messageId = st.messageId;
				// P0-04：撤回前先 drain，避免迟到写入落在撤回之后（撤回后内容不可控）。
				await this.progressWriter?.drain(messageId);
				await this.deps.recallMessage(messageId);
				st.messageId = undefined;
			}
		} finally {
			this.progressBySession.delete(sess.conversationKey);
		}
	}

	private async removeProcessingReaction(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		if (!this.deps.reactions || !item.messageId || !item.emojiReactionId) return;
		try {
			await this.deps.reactions.remove(item.messageId, item.emojiReactionId);
			item.emojiReactionId = undefined;
		} catch {
			/* ignore */
		}
	}

	/** 供桥层在每次成功发送后更新 lastReplyId（真实回复链）。 */
	updateLastReplyId(chatId: string, messageId: string): void {
		const sess = this.sessions.get(chatId);
		if (sess) sess.lastReplyId = messageId;
	}

	private async notify(
		chatId: string,
		text: string,
		opts?: { replyTo?: string; threadId?: string },
		dedupeKey = `${chatId}:${text}`,
		laneKey = chatId,
		kind: "error" | "notify" = "notify",
	): Promise<boolean> {
		try {
			if (this.deps.durableOutbox) {
				return this.deps.durableOutbox.enqueue(chatId, text, opts ?? {}, { dedupeKey, laneKey, kind }).length > 0;
			}
			return (await this.deps.sender.send(chatId, text, opts)).success;
		} catch {
			return false;
		}
	}

	stop(): void {
		this.sessions.clear();
	}
}

/**
 * 剥离模型复述的注入提示（引用块 + 空行 + 原始用户消息残留）：
 * - 删除开头的 `> 引用` 连续块
 * - 删除"以下是用户回复…"等引导句残留
 */
export function stripInjectedPrompt(text: string, quoteBlock: string): string {
	let out = text;
	// 精确剥离本次注入块（若被完整复述）
	if (quoteBlock && out.includes(quoteBlock)) out = out.replace(quoteBlock, "");
	// 兜底：剥离开头引用块行（> ...）及其后空行
	out = out.replace(/^(> [^\n]*\n?)+/, "");
	out = out.replace(/^\n+/, "");
	// 兜底：剥离 hermes 式回复注入残留（[正在回复…] / [你正在回复…] / 旧格式引导句）
	out = out.replace(/^\[(?:正在回复|你正在回复)[^\]]*\]\s*\n?/, "");
	out = out.replace(/^(以下是用户回复[^\n]*\n?)+/, "");
	out = out.replace(/^\[系统提示[^\]]*\]\s*\n?/, "");
	return out.trim();
}

export function sanitizeCommand(command: string): string {
	return command
		.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)=([^\s]+)/gi, "$1=***")
		.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1***")
		.replace(/(--(?:token|password|secret|api-key)(?:=|\s+))[^\s"']+/gi, "$1***")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180);
}

/** 从事件 content 提取文本（pi 的 assistant message content 结构：string 或 [{type:'text',text}] 数组）。 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: string }).type === "text"
				? ((p as { text?: string }).text ?? "")
				: "",
		)
		.join("")
		.trim();
}

/** 从 agent 结果中提取助手文本（兼容字符串/含 message 的对象）。 */
export function extractAssistantText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (typeof r.text === "string" && r.text.trim()) return r.text;
		const msg = r.message as Record<string, unknown> | undefined;
		if (msg && typeof msg.text === "string" && msg.text.trim()) return msg.text;
	}
	return undefined;
}
