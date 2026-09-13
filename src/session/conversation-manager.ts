/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 设计依据：docs/DESIGN.md §2.2（B3 根治：pi-remote-feishu ConversationRouter 思想）。
 */
import { join } from "node:path";
import type { BridgeConfig, FeishuInboundMessage, SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";
import type { Outbox } from "../outbound/outbox.js";
import { buildConversationKey } from "./conversation-key.js";
import { PendingStore } from "./pending-store.js";
import type { ResourceResolver, ResolvedTurnResources } from "../inbound/resource-resolver.js";
import { adaptAgentEvent } from "../outbound/agent-event-adapter.js";
import { LiveChannel } from "../outbound/live-channel.js";
import { randomUUID } from "node:crypto";
import type { ResourceRef } from "../types.js";

type AgentHandle = Awaited<ReturnType<SessionBackend["createSession"]>>;

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
	runTimeoutMs?: number;
	/** shutdown 对单个外部清理动作的等待上限；默认 2s，必须短于 SIGTERM 强退窗口。 */
	shutdownTimeoutMs?: number;
	now?: () => number;
	/** pending 中断恢复文件路径（hermes resume_pending；不设则禁用）。 */
	pendingFile?: string;
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
}

interface QueuedMessage {
	runId: string;
	chatId: string;
	messageId: string;
	text: string;
	resources: ResourceRef[];
	replyToMessageId?: string;
	replyToText?: string;
	/** 话题（thread_id）透传：hermes 话题模式。 */
	threadId?: string;
	/** 处理中表情：reaction_id（add 时返回）。 */
	reactionId?: string;
	emojiReactionId?: string;
}

const MAX_QUEUE = 50;

export class ConversationManager {
	private sessions = new Map<string, BridgeSession>();
	private runTimeoutMs: number;
	private now: () => number;
	/** 进度消息状态（方案 A）：progressMessageId + 节流时间。 */
	private readonly progressBySession = new Map<string, { messageId?: string; lastUpdateAt: number; toolStack: string[]; lastCmd?: string; startedAt?: number }>();
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
	private readonly nextSessionSuffix = new Map<string, string>();
	private shuttingDown = false;
	private readonly shutdownTimeoutMs: number;

	constructor(private deps: ConversationManagerDeps) {
		this.runTimeoutMs = deps.runTimeoutMs ?? 300_000;
		this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? 2_000;
		this.now = deps.now ?? Date.now;
		this.pendingFile = deps.pendingFile ?? "";
		this.pendingEnabled = Boolean(deps.pendingFile);
		this.pendingStore = this.pendingEnabled ? new PendingStore(this.pendingFile, { now: this.now }) : undefined;
		if (deps.editMessage) this.liveChannel = new LiveChannel({ edit: deps.editMessage });
	}

	/** 工具事件 → 进度消息更新（pi.on("tool_execution_start/end") 转接）。 */
	onToolEvent(sessionId: string, toolName: string, kind: "start" | "end", args?: Record<string, unknown>): void {
		const sess = [...this.sessions.values()].find((s) => s.sessionId === sessionId);
		if (!sess) return;
		// 用 conversationKey 索引（sessionId 在 createSession 前为 undefined，不可作 key）
		const st = this.progressBySession.get(sess.conversationKey) ?? { lastUpdateAt: 0, toolStack: [] };
		if (kind === "start") {
			st.toolStack.push(toolName);
			if (toolName === "bash" || toolName === "terminal") {
				// 记录最近一条命令（bash 代码块渲染，hermes supports_code_blocks 精神）
				const cmd = args?.command ?? args?.cmd;
				if (typeof cmd === "string" && cmd.trim()) st.lastCmd = cmd.trim();
			}
		} else {
			const i = st.toolStack.lastIndexOf(toolName);
			if (i >= 0) st.toolStack.splice(i, 1);
		}
		this.progressBySession.set(sess.conversationKey, st);
		void this.renderProgress(sess, st);
	}

	private async renderProgress(sess: BridgeSession, st: { messageId?: string; lastUpdateAt: number; toolStack: string[]; lastCmd?: string }): Promise<void> {
		if (!this.deps.editMessage) return;
		if (this.liveChannel?.hasContent(sess.conversationKey)) return;
		const now = Date.now();
		if (now - st.lastUpdateAt < this.progressMinIntervalMs) return; // 节流
		st.lastUpdateAt = now;
		if (!st.messageId) return; // 进度消息还没发（或已撤回）
		const lines = st.toolStack.slice(-this.progressMaxLines).map((t) => `🔧 ${toolLabel(t)}`);
		if (st.lastCmd && st.toolStack.some((tool) => tool === "bash" || tool === "terminal")) lines.push(`↳ ${sanitizeCommand(st.lastCmd)}`);
		const text = lines.length ? `🤖 正在处理…
${lines.join("\n")}` : "🤖 正在处理…";
		await this.deps.editMessage(st.messageId, text);
	}

	/** 优雅关闭：撤回所有进行中的进度消息与处理中表情（SIGTERM 调用）。 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.waitingPumps.length = 0;
		const tasks: Promise<unknown>[] = [];
		for (const [key, sess] of this.sessions) {
			const st = this.progressBySession.get(key);
			if (st?.messageId && this.deps.recallMessage) {
				tasks.push(this.deps.recallMessage(st.messageId).catch(() => false));
				st.messageId = undefined;
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

	routeForSessionId(sessionId: string): { conversationKey: string; chatId: string; threadId?: string; sourceMessageId?: string; runId?: string } | undefined {
		const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === sessionId);
		if (!session) return undefined;
		const active = this.activeItems.get(session.conversationKey);
		return {
			conversationKey: session.conversationKey,
			chatId: session.chatId,
			threadId: session.threadId,
			sourceMessageId: active?.messageId,
			runId: active?.runId,
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
		};
		if (sess.queue.length >= MAX_QUEUE) {
			this.deps.log?.("warn", "feishu.conv.queue_full", { chatId: key });
			await this.notify(msg.chatId, "消息过多，当前队列已满，请稍后再试。", {
				replyTo: msg.messageId,
				threadId: msg.threadId,
			}, `${msg.messageId}:queue-full`, key);
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

	async resetConversation(msg: FeishuInboundMessage): Promise<void> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		this.nextSessionSuffix.set(key, `-${randomUUID()}`);
		this.sessions.delete(key);
		this.liveChannel?.discard(key);
		if (session?.agent) {
			if (session.activeRun) { try { await session.agent.abort(); } catch { /* best effort */ } }
			try { await session.agent.dispose(); } catch { /* best effort */ }
			session.agent = undefined;
		}
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
		const session: BridgeSession = {
			conversationKey: key,
			chatId: msg.chatId,
			threadId: msg.threadId,
			sessionFile: join(this.deps.sessionDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}${this.nextSessionSuffix.get(key) ?? ""}.jsonl`),
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
			this.waitingPumps.push(sess);
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
		try {
			while (!this.shuttingDown && sess.queue.length > 0) {
				const item = sess.queue.shift();
				if (!item) break;
				this.activeItems.set(sess.conversationKey, item);
				try {
					await this.runOne(sess, item);
				} finally {
					this.activeItems.delete(sess.conversationKey);
				}
			}
		} finally {
			sess.activeRun = false;
		}
	}

	private async runOne(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		const logMeta = (meta: Record<string, unknown> = {}): Record<string, unknown> => ({
			messageId: item.messageId,
			conversationKey: sess.conversationKey,
			runId: item.runId,
			...meta,
		});
		const st = this.progressBySession.get(sess.conversationKey) ?? { lastUpdateAt: 0, toolStack: [] };
		this.progressBySession.set(sess.conversationKey, st);
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		let activeAgent: BridgeSession["agent"];
		let durableHandled = false;
		let runSucceeded = false;
		let resolvedResources: ResolvedTurnResources | undefined;
		try {
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
			if (this.shuttingDown) throw new Error("bridge shutting down");

			activeAgent = await this.ensureAgentSession(sess);
			// shutdown 可能发生在异步 session 初始化完成之后、prompt 开始之前。
			if (this.shuttingDown || sess.agent !== activeAgent) throw new Error("bridge shutting down");

			// 流式/完成事件：从 subscribe 事件提取回复文本（pi SDK 的 prompt() 返回值
			// 结构不可靠，pi-feishu-link 同样走事件通道：message_update.text_delta 累积、
			// message_end.content 完整提取）。
			let streamedText = "";
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
					streamedText += adapted.delta;
					this.liveChannel?.append(sess.conversationKey, adapted.delta);
					return;
				}
				if (adapted?.type === "message_end") {
					// 关键：user 消息也会触发 message_end（role=user），须先检查 role
					// （对齐 pi-feishu-link handleMessageEnd 的 role==='assistant' 检查）。
					// 多轮 agent：工具轮（stopReason=toolUse）也会 message_end——
					// 只记最后一轮文本，prompt() resolve（= agent 全部结束）后统一发送，
					// 避免中间轮文本（如"好的，再展开一层…"）被当最终回复发出。
					if (adapted.role !== "assistant") return;
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
				if (adapted?.type === "turn_end" && adapted.text) {
					lastEndText = adapted.text;
					streamedText = "";
				}
			});

			// 组装提示词（回复链路可见性：B1）——对齐 hermes 的回复注入格式：
			// `[Replying to: "原文"]` 方括号元信息（非对话内容，模型不易复述）；
			// 区分回复自己消息 vs 回复他人消息；原文截断 500、占位转 @。
			// 周期刷新进度消息（增量更新：长时间处理时持续展示耗时与工具状态）
			progressTimer = setInterval(() => {
				void this.renderProgress(sess, st);
			}, 8000);

			// 运行超时保护（300s；timer 必须清理，否则测试/进程悬挂）
			const timeout = new Promise<never>((_, reject) => {
				timeoutTimer = setTimeout(() => reject(new Error("run timeout")), this.runTimeoutMs);
			});
			const result = await Promise.race([activeAgent.prompt(injectedPrompt, preparedInput.images), timeout]);
			if (agentError) throw new Error(agentError);

			// 最终发送：最后一轮 message_end 文本优先，其次流式累积/返回值
			const text = lastEndText || streamedText.trim() || extractAssistantText(result);
			this.deps.log?.("debug", "feishu.conv.final_send", logMeta({
				chatId: sess.chatId,
				lastEndLen: lastEndText.length,
				streamedLen: streamedText.length,
				textLen: text?.length ?? 0,
			}));
			if (text) await sendReply(text);
			else durableHandled = true;
			runSucceeded = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (activeAgent && sess.agent === activeAgent) {
				if (msg === "run timeout") {
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
			} else if (msg === "run timeout") {
				durableHandled = await this.notify(sess.chatId, "任务处理超时已中止，请重试。", {
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
			if (timeoutTimer) clearTimeout(timeoutTimer);
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
			try { resolvedResources?.cleanup(); } catch { /* best effort */ }
		}
	}

	/** 撤回进度消息（方案 A：正式回复前撤回，避免刷屏）。 */
	private async finishProgress(sess: BridgeSession, st: { messageId?: string; lastUpdateAt: number; toolStack: string[]; lastCmd?: string }): Promise<void> {
		try {
			this.liveChannel?.discard(sess.conversationKey);
			if (st.messageId && this.deps.recallMessage) {
				await this.deps.recallMessage(st.messageId);
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
