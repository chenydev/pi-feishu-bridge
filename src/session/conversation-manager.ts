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
import {
	DEFAULT_PREVIEW_CHARS,
	renderProgressText,
	renderToolLine,
	sanitizeCommand,
	type ProgressLine,
	type ProgressMode,
} from "../outbound/progress-render.js";
import { StreamingCard } from "../outbound/streaming-card.js";
import { LiveChannel, SerialWriter } from "../outbound/live-channel.js";
import { createRunMetrics, elapsedMs as metricsElapsedMs, recordUsage, renderFooter } from "../outbound/run-metrics.js";
import { resolveFooterEnabled } from "../config.js";
import { cnyPerUsdForModel } from "../outbound/deepseek-usage.js";
import { stripFooterFromQuote, stripMarkdown } from "../outbound/run-metrics.js";
import type { RunUsage, SessionUsage, UsageSnapshot } from "../commands/usage-card.js";
import { RateBudget } from "../runtime/rate-budget.js";
import { randomUUID } from "node:crypto";
import type { ResourceRef } from "../types.js";

type AgentHandle = Awaited<ReturnType<SessionBackend["createSession"]>>;

/**
 * 飞书对同一条消息的编辑次数上限（官方文档为 20 次；超出返回 `code 230072`
 * "The message has reached the number of times it can be edited"）。
 *
 * 这是**真实链路验证发现的硬约束**：进度会随每个工具行 + 周期心跳持续改写同一条消息，
 * 长任务必然撞上限，表现为「耗时页脚冻结在某一秒 + 终态页脚（✅/⏹/⚠️）永远发不出去」。
 */
const FEISHU_MAX_MESSAGE_EDITS = 20;
/** 非终态写入的编辑配额：预留 2 次给终态页脚，避免「跑很久 → 结果页脚写不进去」。 */
const PROGRESS_EDIT_BUDGET = FEISHU_MAX_MESSAGE_EDITS - 2;
/**
 * 进度心跳间隔：只在长时间无工具变化时刷新耗时页脚。
 *
 * 不用更短的间隔是因为编辑配额有限（见上），而且编辑是要花网络往返的；
 * 30s 对「还在跑」的体感已经足够，配额用尽后会自动轮换新消息（见 `writeProgressText`）。
 */
const PROGRESS_HEARTBEAT_MS = 30_000;

/** 进度消息的会话内状态（随 run 创建，收尾后删除）。 */
interface ProgressState {
	/** 进度消息 id；被 final 复用（非卡片模式下已吐出正文）时清空，避免撤回正在用的消息。 */
	messageId?: string;
	/** 当前进度消息已被编辑的次数（飞书同一条消息上限 20 次，见 `FEISHU_MAX_MESSAGE_EDITS`）。 */
	edits: number;
	/** 轮换新进度消息时的回复目标（沿用触发消息，保持阅读顺序）。 */
	replyTo?: string;
	threadId?: string;
	/** 非卡片模式：该进度消息同时是流式草稿的载体，轮换时要一并改指。 */
	liveTarget?: boolean;
	/** 上次写入时间（节流用）。 */
	lastUpdateAt: number;
	/** 追加式日志行（见 `progress-render.ts` 的设计说明）。 */
	lines: ProgressLine[];
	/**
	 * 当前气泡第一行的下标。
	 *
	 * 飞书同一条消息最多编辑 20 次，长任务必然撞上限，因此需要换气泡（新发一条继续）。
	 * 换气泡时把它移到「旧气泡从未展示过的第一行」：新气泡只写之后的内容，不重复旧气泡，
	 * 一轮任务在群里读成一段连续日志（对齐 hermes `_roll_progress_overflow_if_needed` 的切分语义）。
	 */
	pageStart: number;
	/** 当前气泡上一次写出去时 `lines` 的长度（= 旧气泡已经展示到哪一行）。 */
	shownUpTo: number;
	/** 第几个进度气泡（0 = 首个）。换过气泡后标题标「（续）」，避免看成新的一轮。 */
	pageIndex: number;
	/** `new` 档去重：上一个已追加的工具名（hermes `last_tool`）。 */
	lastToolName?: string;
	/** 已见过的 toolCallId（SDK 重放/重试去重）。 */
	seenCallIds: Set<string>;
	startedAt?: number;
	/** 已收尾：之后不再接受进度写入（关掉与 8s 定时器竞争的最后一道闸）。 */
	finishedAt?: number;
	/** 思考摘要（仅配置开启时累积；只保留末尾 500 字）。 */
	thinking?: string;
}

/** P1-04：相对时间展示（不泄露绝对路径/时间戳细节）。 */
function formatRelative(timestamp: number, now: number): string {
	const delta = Math.max(0, now - timestamp);
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * P1-03：把 SDK 会话统计收成报告用的形状。
 *
 * 两层容错：老 SDK 没这个方法、或取统计时抛错 —— 两者都只是"这段不显示"，
 * 不能让页脚和 `/feishu usage` 整体挂掉。
 */
function sessionUsageStats(agent: AgentHandle | undefined): SessionUsage | undefined {
	try {
		const stats = agent?.getSessionStats?.();
		if (!stats) return undefined;
		const tokens = stats.tokens;
		return {
			...(tokens
				? { tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite } }
				: {}),
			...(typeof stats.cost === "number" ? { cost: stats.cost } : {}),
			...(stats.contextUsage ? { contextUsage: stats.contextUsage } : {}),
			...(typeof stats.userMessages === "number" ? { userMessages: stats.userMessages } : {}),
			...(typeof stats.assistantMessages === "number" ? { assistantMessages: stats.assistantMessages } : {}),
			...(typeof stats.toolCalls === "number" ? { toolCalls: stats.toolCalls } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * 工具参数脱敏摘要 —— 只取有信息量的字段，经 sanitizeCommand 脱敏并截断。
 * 命令/参数可能含秘密，绝不原样展示。
 *
 * L2 起保留为兼容入口：新代码直接用 `renderToolLine`（动词短语 + 预览 + 技能识别）。
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
	/** P1-03：最近一轮 run 的指标快照（`/feishu usage` 展示用）。 */
	lastRun?: RunUsage;
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
	/** Pi 的 agent_settled 信号：本轮确实不会再继续（比 turn_end 更终局）。 */
	settled?: boolean;
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
	/**
	 * 恢复提示（对齐 hermes build_resume_recovery_note）：崩溃恢复后给模型注入
	 * 一条方括号元信息，告诉它"上次中断了，不要重跑历史里未完成的工具调用"。
	 * 按 conversationKey 索引 —— 恢复后用户会发**新**消息（新 messageId），
	 * 按被中断那条消息的 id 索引永远匹配不上。注入一次即删除；
	 * 只在内存里，不落盘、不发给用户。
	 */
	private readonly recoveryNotes = new Map<string, string>();
	private runIdleTimeoutMs: number;
	private runMaxDurationMs: number;
	private now: () => number;
	/**
	 * 进度消息状态（L1–L3）。
	 *
	 * `lines` 是**追加式日志**（hermes 进度气泡同构）：工具*开始*时追加一行，之后永不改写
	 * —— 因此能看到「这轮做了什么」的完整顺序，而不是只剩「此刻还剩哪几个在跑」。
	 * 行不可变也是连续重复行能安全折叠成 `(×N)` 的前提。
	 */
	private readonly progressBySession = new Map<string, ProgressState>();
	private readonly progressMinIntervalMs = 1500;
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

	/** 进度状态（懒建）：不变量集中在这里，避免各处 `?? {}` 漏字段。 */
	private progressState(key: string): ProgressState {
		let state = this.progressBySession.get(key);
		if (!state) {
			state = { lastUpdateAt: 0, edits: 0, lines: [], seenCallIds: new Set(), pageStart: 0, shownUpTo: 0, pageIndex: 0 };
			this.progressBySession.set(key, state);
		}
		return state;
	}

	/** L3：进度档位（`off` 时既不发进度消息也不追加行）。 */
	private get progressMode(): ProgressMode {
		return this.deps.config.progress?.mode ?? "all";
	}

	private get progressMaxLines(): number {
		return Math.max(1, this.deps.config.progress?.maxLines ?? 6);
	}

	private get progressPreviewChars(): number {
		return Math.max(4, this.deps.config.progress?.previewChars ?? DEFAULT_PREVIEW_CHARS);
	}

	/** L3：完成后是否保留进度消息（默认 true，对齐 hermes `cleanup_progress: false`）。 */
	private get progressKeepOnFinish(): boolean {
		return this.deps.config.progress?.keepOnFinish !== false;
	}

	private progressThinking(st: ProgressState): string | undefined {
		return this.deps.config.progress?.showThinking ? st.thinking : undefined;
	}

	/** 工具事件 → 追加一行进度日志（`pi.on("tool_execution_start/end")` 转接用）。
	 *
	 * 主路径其实是 `subscribe()` 回调（见 `runOneTurn`）：那里本来就拿着 `sess`，不需要猜
	 * sessionId。这个方法保留给能直接拿到 sessionId 的传输层，两条路径靠 `toolCallId` 去重。
	 */
	onToolEvent(sessionId: string, toolName: string, kind: "start" | "end", args?: Record<string, unknown>, toolCallId?: string): void {
		const sess = [...this.sessions.values()].find((s) => s.sessionId === sessionId);
		if (!sess) {
			// 找不到会话是「进度不出现」最常见的成因（sessionId 对不上），得能一眼看出来
			this.deps.log?.("debug", "feishu.progress.unknown_session", { sessionId: sessionId || "(empty)", toolName, kind });
			return;
		}
		if (kind === "end") return;
		this.appendToolLine(sess, toolName, args, toolCallId);
	}

	/** 追加一行工具日志（追加式：只在工具*开始*时调用）。 */
	private appendToolLine(sess: BridgeSession, toolName: string, args?: Record<string, unknown>, toolCallId?: string): void {
		// `off` 档连日志都不维护（避免做无用的事后又发现没人看）
		if (this.progressMode === "off") return;
		const st = this.progressState(sess.conversationKey);
		// 同一 toolCallId 的重复 start 只记一次（SDK 重试/重放）；缺 id 时无法区分，只能照记
		if (toolCallId) {
			if (st.seenCallIds.has(toolCallId)) return;
			if (st.seenCallIds.size < 512) st.seenCallIds.add(toolCallId);
		}
		// `new` 档：只在工具**变化**时追加（hermes `progress_mode == "new"` 的语义）
		if (this.progressMode === "new" && toolName === st.lastToolName) return;
		st.lastToolName = toolName;

		const text = renderToolLine(toolName, args, { previewChars: this.progressPreviewChars, mode: this.progressMode });
		const last = st.lines[st.lines.length - 1];
		// 连续相同行折叠：`echo 1` 跑五遍只占一行（hermes `__dedup__` 哨兵的等价物）
		if (last && last.text === text) last.count += 1;
		else st.lines.push({ text, count: 1 });
		this.deps.log?.("info", "feishu.progress.append", {
			chatId: sess.chatId, conversationKey: sess.conversationKey,
			toolName, line: text, steps: st.lines.length,
			hasMessage: Boolean(st.messageId), hasCallId: Boolean(toolCallId),
		});
		void this.renderProgress(sess, st);
	}

	private async renderProgress(sess: BridgeSession, st: ProgressState): Promise<void> {
		if (!this.deps.editMessage) return;
		if (this.progressMode === "off") return;
		// 非卡片模式下进度消息同时是流式草稿的载体：一旦开始吐正文，进度就得让位，
		// 否则编辑会把已经流出的答案覆盖回进度块。
		if (this.liveChannel?.hasContent(sess.conversationKey)) return;
		if (!st.messageId) return; // 进度消息还没发（或已撤回）
		if (st.finishedAt !== undefined) return; // 已收尾（关掉与心跳定时器的写入竞争）
		const now = Date.now();
		if (now - st.lastUpdateAt < this.progressMinIntervalMs) return; // 节流
		st.lastUpdateAt = now;
		await this.writeProgressText(sess, st, false);
	}

	/**
	 * 渲染**当前气泡**的正文。
	 *
	 * 只取 `st.lines.slice(st.pageStart)` —— 即本气泡自己的窗口；换过气泡之后标题变
	 * 「执行过程（续）」，因此新气泡不会把旧气泡的尾部再贴一遍。
	 */
	private currentProgressText(
		st: ProgressState,
		opts: { outcome?: "ok" | "failed" | "stopped" } = {},
	): string {
		return renderProgressText(st.lines.slice(st.pageStart), this.progressThinking(st), {
			mode: this.progressMode, maxLines: this.progressMaxLines, previewChars: this.progressPreviewChars,
		}, {
			startedAt: st.startedAt,
			finishedAt: st.finishedAt,
			outcome: opts.outcome,
			now: st.finishedAt ?? Date.now(),
			continued: st.pageIndex > 0,
		});
	}

	/**
	 * 写进度正文：优先编辑当前进度消息；**编辑配额用尽则另发一条继续**。
	 *
	 * 为什么必须轮换：飞书对同一条消息的编辑次数有硬上限（20 次，超出返回 `code 230072`）。
	 * 进度会随每个工具行与周期心跳持续改写同一条消息，长任务必然撞上限 —— 2026-09-21 用真实
	 * 长时间静默任务复现：第 20 次编辑后全部被拒，群里表现为耗时页脚冻结在 `⏱ 2m33s`，
	 * 紧随其后的终态页脚（`✅/⏹/⚠️`）**永远发不出去**（用户以为任务卡死）。
	 *
	 * 因此：非终态写入只用 `PROGRESS_EDIT_BUDGET`（留 2 次给终态）；用尽即**换气泡续写**
	 * （思路同 hermes 的 `_roll_progress_overflow_if_needed`，但触发条件是**次数**而非长度）：
	 * 新气泡从「旧气泡从未展示过的第一行」开始（`pageStart = shownUpTo`），因此
	 * 旧气泡保留自己的窗口、新气泡接着往后写 —— 不重复、历史不断。
	 * 终态写入额外拿到剩余配额，配额也已耗尽时直接新发一条 —— 结果页脚绝不丢。
	 */
	private async writeProgressText(
		sess: BridgeSession,
		st: ProgressState,
		terminal = false,
		opts: { outcome?: "ok" | "failed" | "stopped" } = {},
	): Promise<void> {
		if (!st.messageId) return;
		const budget = terminal ? FEISHU_MAX_MESSAGE_EDITS : PROGRESS_EDIT_BUDGET;
		if (st.edits < budget) {
			st.edits += 1;
			st.shownUpTo = st.lines.length;
			// P0-04：进度写入与流式写入共用串行语义（同一目标永不并发，顺序确定）。
			this.progressWriter?.enqueue(st.messageId, this.currentProgressText(st, opts));
			return;
		}
		st.pageStart = Math.max(st.pageStart, st.shownUpTo);
		st.pageIndex += 1;
		await this.rollProgressMessage(sess, st, this.currentProgressText(st, opts));
	}

	/** 编辑配额用尽：换气泡续写（旧气泡保留它自己的窗口，新气泡只写之后的行）。 */
	private async rollProgressMessage(sess: BridgeSession, st: ProgressState, text: string): Promise<void> {
		if (!st.replyTo) {
			this.deps.log?.("warn", "feishu.progress.roll_skipped", { chatId: sess.chatId, reason: "no_reply_target" });
			return;
		}
		try {
			const sent = await this.deps.sender.send(sess.chatId, text, { replyTo: st.replyTo, threadId: st.threadId });
			if (!sent.success || !sent.messageId) {
				this.deps.log?.("warn", "feishu.progress.roll_failed", { chatId: sess.chatId, error: sent.error });
				return;
			}
			st.messageId = sent.messageId;
			st.edits = 0;
			st.shownUpTo = st.lines.length;
			// 非卡片模式下这条消息同时是流式草稿的载体：把草稿也改指到新消息上。
			// 只有「还没吐正文」时才会走到轮换（有正文时 renderProgress 已提前 return），
			// 且终态阶段（finishedAt 已置）不再重绑定。
			if (st.liveTarget && st.finishedAt === undefined) this.liveChannel?.open(sess.conversationKey, sent.messageId);
			this.deps.log?.("info", "feishu.progress.rolled", {
				chatId: sess.chatId, messageId: sent.messageId, editsBefore: PROGRESS_EDIT_BUDGET,
			});
		} catch (error) {
			this.deps.log?.("warn", "feishu.progress.roll_error", {
				chatId: sess.chatId, error: error instanceof Error ? error.message : String(error),
			});
		}
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
			// 命令类消息不重放：重放一个 /new 等于再清一次上下文，重放 /stop 会打断新任务。
			if (e.replayPolicy === "never") {
				this.pendingStore?.ack(e.id);
				continue;
			}
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
				// 同时让模型自己也知道"上次中断过" —— 对齐 hermes 的
				// "Do NOT re-execute old tool calls"，避免它从历史里自行
				// 推断并重试旧工具调用（用户看不到这条，它只进模型上下文）。
				this.recoveryNotes.set(e.conversationKey,
					"[系统提示：本会话上次在工具执行期间被中断。不要重新执行对话历史中未完成的工具调用；"
					+ "如果用户要求继续，先确认当前实际状态再决定下一步。]");
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
			markNever: (id) => {
				store.markNever(id);
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

	private async prepareAgentInput(item: QueuedMessage, conversationKey: string): Promise<{
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
			// 先剔掉桥自己加的页脚块：那是给人看的元信息，不该每轮花 token 喂回模型。
			// 先按注册表精确匹配我们发过的原文，再按行形态兜底（保证一定删干净）。
			const strippedQuote = stripFooterFromQuote(item.replyToText, this.sentFooters);
			// 整条都是页脚（引用了一条纯元信息消息）：注入占位提示，别塞空引用
			const quote = (strippedQuote.trim() || "[无法获取被回复消息原文]").slice(0, 500).replace(/@_user_\w+/g, "@").replace(/\n/g, " ");
		const replyingToSelf = Boolean(this.deps.lastSent?.has(item.replyToMessageId));
			text = replyingToSelf
				? `[你正在回复自己上一条消息，原文："${quote}"]\n\n${text}`
				: `[正在回复的消息原文："${quote}"]\n\n${text}`;
		}
		// 恢复提示：一次性注入。注意必须放在 replyTo 分支之外 ——
		// 崩溃恢复后用户重发的消息通常不带回复引用，若写在分支内就永远不会生效。
		const recoveryNote = this.recoveryNotes.get(conversationKey);
		if (recoveryNote) {
			text = `${recoveryNote}\n\n${text}`;
			this.recoveryNotes.delete(conversationKey);
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
	/**
	 * Pi 的 agent_settled 信号：本轮彻底结束（不会再有 retry / compaction / follow-up）。
	 * 比 turn_end / agent_end 更准确 —— 官方文档明确 agent_end 之后 Pi 仍可能继续。
	 * 记录到活动项上，供收尾逻辑与诊断使用。
	 */
	markSettled(sessionId: string): void {
		const session = [...this.sessions.values()].find((candidate) => candidate.sessionId === sessionId);
		if (!session) return;
		const item = this.activeItems.get(session.conversationKey);
		if (item) item.settled = true;
	}

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
	/**
	 * 供 /models 卡片使用的数据快照：模型清单 + 当前模型 + 会话 key。
	 * 返回 null 表示无法获取（调用方回退到文本版 listModels）。
	 */
	async modelsCardData(msg: FeishuInboundMessage): Promise<{
		models: Array<{ id: string; provider?: string }>; currentId: string; conversationKey: string;
	} | null> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.models_init_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		if (!agent.listModels) return null;
		try {
			const models = await agent.listModels();
			if (models.length === 0) return null;
			return { models, currentId: agent.modelId, conversationKey: key };
		} catch {
			return null;
		}
	}



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

	/**
	 * P1-03：final 页脚（配置关闭时返回空串）。
	 *
	 * 上下文占用取自 SDK 会话统计（拿不到就不显示该段）：不能用 run 指标里的 token
	 * 加总代替 —— 那个是「本轮花了多少」，上下文是「当前窗口占了多少」，压缩后两者
	 * 会差一个数量级。
	 */
	private footerFor(metrics: ReturnType<typeof createRunMetrics>, sess: BridgeSession): string {
		const footerCfg = this.deps.config.footer;
		// 群级开关优先（管理员可用 /feishu footer off 当场关掉本群页脚）
		if (!resolveFooterEnabled(this.deps.config, sess.chatId).enabled) return "";
		try {
			const stats = footerCfg.showSession === false ? undefined : sessionUsageStats(sess.agent);
			return renderFooter(metrics, {
				elapsedMs: metricsElapsedMs(metrics),
				// 模型优先用会话当下的（本轮没收到 usage 事件时 metrics.model 是空的）
				model: metrics.model ?? sess.agent?.modelId,
				showCost: footerCfg.showCost !== false,
				showCny: footerCfg.showCny !== false,
				cnyPerUsd: cnyPerUsdForModel(metrics.model ?? sess.agent?.modelId),
				context: footerCfg.showContext === false ? undefined : stats?.contextUsage,
				...(stats
					? { session: { ...(stats.tokens ? { tokens: stats.tokens } : {}), ...(typeof stats.cost === "number" ? { cost: stats.cost } : {}) } }
					: {}),
			});
		} catch {
			return "";
		}
	}

	/**
	 * P1-03：`/feishu usage` 的数据源 —— 会话累计（SDK 统计）+ 本轮 run 指标。
	 *
	 * 不新建会话：没有会话就是没有用量，回 null 让命令层告诉用户去发条消息。
	 */
	usageSnapshot(msg: FeishuInboundMessage): UsageSnapshot | undefined {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.sessions.get(key);
		if (!session) return undefined;
		const stats = sessionUsageStats(session.agent);
		const modelLabel = session.agent?.modelId;
		return {
			...(modelLabel ? { modelLabel } : {}),
			...(stats ? { session: stats } : {}),
			...(session.lastRun ? { run: session.lastRun } : {}),
		};
	}

	/**
	 * 最近发出的文本页脚原文（FIFO，上限 50 条）。
	 *
	 * 为什么记：引用回复时要把页脚从注入的引用块里去掉。单靠行形态判断是"超集"，
	 * 有极小概率误删正文；先按注册表做整段后缀精确匹配，就能做到"确定删掉我们写进去的那段"。
	 * 进程重启后为空 → 退化成行形态判断，仍然能删干净。
	 */
	private readonly sentFooters: string[] = [];

	private rememberSentFooter(footer: string): void {
		const text = footer.trim();
		if (!text) return;
		const existing = this.sentFooters.indexOf(text);
		if (existing >= 0) this.sentFooters.splice(existing, 1);
		this.sentFooters.push(text);
		if (this.sentFooters.length > 50) this.sentFooters.shift();
	}

	private async trySteer(sess: BridgeSession, item: QueuedMessage): Promise<boolean> {
		const agent = sess.agent;
		if (!sess.activeRun || !agent?.steer || !this.activeItems.has(sess.conversationKey)) return false;
		sess.steered.push(item);
		let prepared: Awaited<ReturnType<ConversationManager["prepareAgentInput"]>> | undefined;
		let accepted = false;
		try {
			prepared = await this.prepareAgentInput(item, sess.conversationKey);
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
		// 不带参数 = 展示型查询（对齐 hermes /model）：给出当前模型、可用候选与切换语法，
		// 而不是只回一行「当前模型：x」让用户不知道下一步该输什么。
		if (!modelId && session.agent) return await this.describeModel(session.agent);
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
		if (!modelId) return await this.describeModel(agent);
		if (!agent.setModel) return "当前 Pi 版本不支持远程切换模型";
		return await agent.setModel(modelId) ? `已切换模型：${modelId}` : `找不到已认证模型：${modelId}`;
	}

	/**
	 * 构造 /model 的展示文本：当前模型 + 可用候选 + 切换语法。
	 * 候选有上限（默认 10），超出时指向 /models 分页查看 —— 模型多时避免刷屏。
	 * 列模型时一律带 provider 前缀，因为同名 id 可能来自不同 provider
	 * （例如自建网关与官方 API 都可能有同名模型）。
	 */
	private async describeModel(agent: AgentHandle, limit = 10): Promise<string> {
		const current = agent.modelId;
		const lines: string[] = [`当前模型：${current}`];
		const thinking = agent.thinkingLevel?.();
		if (thinking) lines[0] += `　思考等级：${thinking}`;

		let all: Array<{ id: string; provider?: string }> = [];
		try {
			all = (await agent.listModels?.()) ?? [];
		} catch {
			// 列出候选失败不影响展示当前模型（例如 provider 暂时不可达）
		}
		const candidates = all.filter((entry) => entry.id !== current);
		if (candidates.length > 0) {
			const shown = candidates.slice(0, limit);
			lines.push("", `可切换（${candidates.length}）`);
			for (const entry of shown) {
				const label = entry.provider ? `${entry.provider}/${entry.id}` : entry.id;
				lines.push(`· ${label}`);
			}
			if (candidates.length > shown.length) lines.push(`· …其余 ${candidates.length - shown.length} 个`);
		}
		lines.push("", "切换：/model <模型>　查看全部：/models　思考等级：/thinking");
		return lines.join("\n");
	}

	/**
	 * 状态卡的数据源（/model 无参）。
	 *
	 * 当前模型要尽量带上 provider 前缀：`agent.modelId` 是**裸 id**，而 /models
	 * 表格里是 `provider/id` —— 两边不一致会让人以为不是一个模型，而且带前缀
	 * 才能直接复制进 `/model` 命令。
	 *
	 * 反查有歧义时**返回裸 id 而不猜**：猜错会让人复制一个错误的模型名去切换，
	 * 比不显示前缀更糟。
	 */
	async modelStatusCardData(msg: FeishuInboundMessage): Promise<{
		currentLabel: string;
		thinkingLevel?: string;
		availableLevels: string[];
		conversationKey: string;
		models: Array<{ id: string; provider?: string }>;
	} | null> {
		const key = buildConversationKey(msg, this.deps.config);
		const session = this.getOrCreateSession(msg, key);
		let agent: AgentHandle;
		try {
			agent = await this.ensureAgentSession(session);
		} catch (error) {
			this.deps.log?.("error", "feishu.conv.model_status_init_failed", {
				conversationKey: key, error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}

		let currentLabel = agent.modelId;
		let models: Array<{ id: string; provider?: string }> = [];
		try {
			models = (await agent.listModels?.()) ?? [];
			const matches = models.filter((entry) => entry.id === agent.modelId);
			const only = matches.length === 1 ? matches[0] : undefined;
			if (only?.provider) currentLabel = `${only.provider}/${only.id}`;
		} catch {
			// 列不出模型不影响展示当前模型（provider 暂时不可达时也一样）
		}

		const thinkingLevel = agent.thinkingLevel?.();
		const availableLevels = agent.availableThinkingLevels?.() ?? [];
		return {
			currentLabel,
			...(thinkingLevel ? { thinkingLevel } : {}),
			availableLevels,
			conversationKey: key,
			// 展开表格时直接用这份清单，不必为同一件事再 listModels 一次
			models,
		};
	}

	/** 按钮回调用：按 key 取状态卡数据（回调里没有 inbound 消息，拿不到 chatId）。 */
	async modelStatusCardDataByKey(conversationKey: string): Promise<{
		currentLabel: string;
		thinkingLevel?: string;
		availableLevels: string[];
		conversationKey: string;
		models: Array<{ id: string; provider?: string }>;
	} | null> {
		const session = this.sessions.get(conversationKey);
		if (!session?.agent) return null;
		const agent = session.agent;

		let currentLabel = agent.modelId;
		let models: Array<{ id: string; provider?: string }> = [];
		try {
			models = (await agent.listModels?.()) ?? [];
			const matches = models.filter((entry) => entry.id === agent.modelId);
			const only = matches.length === 1 ? matches[0] : undefined;
			if (only?.provider) currentLabel = `${only.provider}/${only.id}`;
		} catch {
			// 反查失败就用裸 id（不猜 provider）
		}
		const thinkingLevel = agent.thinkingLevel?.();
		return {
			currentLabel,
			...(thinkingLevel ? { thinkingLevel } : {}),
			availableLevels: agent.availableThinkingLevels?.() ?? [],
			conversationKey,
			models,
		};
	}


	/** 按钮回调：按会话 key 切换思考等级（等价于 /thinking <level>）。 */
	async setThinkingByKey(conversationKey: string, level: string): Promise<{ ok: boolean; reason?: string }> {
		const session = this.sessions.get(conversationKey);
		if (!session?.agent) return { ok: false, reason: "会话已失效，请重新发送 /model" };
		const available = session.agent.availableThinkingLevels?.() ?? [];
		if (available.length > 0 && !available.includes(level)) {
			return { ok: false, reason: `当前模型不支持档位 ${level}` };
		}
		try {
			session.agent.setThinkingLevel?.(level);
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message.slice(0, 80) : "切换失败" };
		}
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
		const st = this.progressState(sess.conversationKey);
		// 进度消息的回复目标：轮换新消息（编辑配额用尽）时沿用，保持阅读顺序。
		st.replyTo = item.messageId;
		st.threadId = sess.threadId ?? item.threadId;
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
		// P1-01：流式卡片启用时答案是卡片；进度（L1）仍然要有一条**自己的**可编辑消息。
		const cardMode = Boolean(this.deps.config.streamingCard?.enabled && this.deps.rawRequest);
		this.deps.log?.("info", "feishu.conv.card_mode", {
			cardMode,
			configured: Boolean(this.deps.config.streamingCard?.enabled),
			hasRawRequest: Boolean(this.deps.rawRequest),
			throttleMs: this.deps.config.streamingCard?.throttleMs,
			progressMode: this.progressMode,
		});
		try {
			// 进度消息（L1）：
			// - 非卡片模式：这条消息同时是**流式草稿的载体**（首 token 前显示进度、之后变成答案），
			//   所以与进度档位无关，必须发（否则连流式吐字一起没了）；
			// - 卡片模式：答案是卡片，进度需要自己的消息 —— 旧代码用 `if (!cardMode)` 把这段整段跳过，
			//   导致开了流式卡片后**完全没有执行进度**（L1 修的就是这个回归）。
			if (!cardMode || this.progressMode !== "off") {
				const sent = await this.deps.sender.send(item.chatId, "🤖 正在处理…", {
					replyTo: item.messageId,
					threadId: sess.threadId ?? item.threadId,
				});
				if (sent.success && sent.messageId) {
					st.messageId = sent.messageId;
					st.startedAt = Date.now();
					// 只有非卡片模式才把它交给 liveChannel：卡片模式下流式正文会把进度块覆盖掉。
					if (!cardMode) { this.liveChannel?.open(sess.conversationKey, sent.messageId); st.liveTarget = true; }
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
			const preparedInput = await this.prepareAgentInput(item, sess.conversationKey);
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
				// 工具进度（L1）：订阅回调本来就在会话上下文里（不用猜 sessionId），
				// 因此这是主路径；`pi.on` 全局钩子是退路，两边靠 toolCallId 去重。
				if (adapted?.type === "tool_start") {
					this.appendToolLine(sess, adapted.toolName, adapted.args, adapted.toolCallId);
					return;
				}
				if (adapted?.type === "tool_end") return; // 追加式日志：结束不改写已落地的行
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
				}, "正在处理…", { withMetrics: resolveFooterEnabled(this.deps.config, sess.chatId).enabled });
				if (!started) streamCard = undefined;
			}

			// 周期刷新进度消息（增量更新：长时间处理时持续展示耗时与工具状态）
			progressTimer = setInterval(() => {
				void this.renderProgress(sess, st);
			}, PROGRESS_HEARTBEAT_MS);

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
			const footer = this.footerFor(metrics, sess);
			// 卡片模式：页脚走**独立元素**（分割线 + 小号淡色块），不拼进答案正文
			const footerBlock = footer.replace(/^———\n/, "");
			// P1-03：留一份本轮快照，`/feishu usage` 用（会话被回收后自然消失）
			sess.lastRun = {
				...(metrics.model ? { model: metrics.model } : {}),
				tokens: { ...metrics.usage },
				cost: metrics.cost,
				hasCost: metrics.hasCost,
				elapsedMs: metricsElapsedMs(metrics),
			};
			// 文本通道不解析 markdown、也没有分割线元素：同一份页脚落到纯文本前要先剥标记
			// 与 `———` 标记（那是给卡片/引用剥离用的内部标记，不是给人看的字面内容）
			const footerPlain = footer ? stripMarkdown(footer.replace(/^———\n/, "")) : "";
			if (footerPlain) this.rememberSentFooter(footerPlain);
			const text = rawText && footerPlain ? `${rawText}\n\n${footerPlain}` : rawText;
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
				// 卡片承载最终答案：成功则不再重复发文本（失败则落回下面的 durable 文本通道）。
				// 正文与页脚分开传：页脚是元信息，写进独立元素（见 StreamingCard.finish）。
				cardDelivered = await streamCard.finish(rawText || text, footerBlock ? { metrics: footerBlock } : undefined);
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
				this.finishProgress(sess, st, runSucceeded ? "ok" : sess.stopRequested ? "stopped" : "failed"),
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

	/**
	 * 收尾进度消息（L3）。
	 *
	 * `keepOnFinish`（默认 true，对齐 hermes `cleanup_progress: false`）时**保留**并写一次终态
	 * 页脚（✅/⏹/⚠️ + 总耗时）—— 「这轮做了什么」可回看；为 false 时维持旧行为（撤回）。
	 * 失败/中断同样保留（hermes：“Failed runs leave bubbles in place as breadcrumbs”）。
	 *
	 * 注意：被 final 复用的进度消息（非卡片模式下已吐出正文）不能撤回 —— 它就是答案本体。
	 */
	private async finishProgress(sess: BridgeSession, st: ProgressState, outcome: "ok" | "failed" | "stopped"): Promise<void> {
		try {
			this.liveChannel?.discard(sess.conversationKey);
			// 先标收尾：关掉心跳定时器与迟到回调对同一条消息的写入竞争（renderProgress 会早退）。
			st.finishedAt ??= Date.now();
			const messageId = st.messageId;
			if (!messageId) return;
			// 保留的前提是**真有步骤可看**：纯聊天（没调任何工具）的 run 不该每轮多留一条
			// 「执行过程 ✅ 完成 · 0.1s」—— 那只是噪声。
			if (this.progressKeepOnFinish && st.lines.length > 0) {
				// terminal=true：终态页脚拿到剩余编辑配额，配额也耗尽时 `writeProgressText`
				// 会新发一条把结果写进去 —— 长任务的「✅/⏹/⚠️ 结论」绝不允许被编辑上限吞掉。
				await this.writeProgressText(sess, st, true, { outcome });
				if (st.messageId) await this.progressWriter?.drain(st.messageId);
				return;
			}
			st.messageId = undefined;
			if (this.deps.recallMessage) {
				// P0-04：撤回前先 drain，避免迟到写入落在撤回之后（撤回后内容不可控）。
				await this.progressWriter?.drain(messageId);
				await this.deps.recallMessage(messageId);
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

/**
 * 命令脱敏已移至 `outbound/progress-render.ts`（与渲染同处一地）；
 * 这里用 re-export 保持对外导入路径不变。
 */
export { sanitizeCommand };

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
