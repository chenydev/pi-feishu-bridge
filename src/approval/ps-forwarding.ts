/**
 * pi-permission-system「父会话转发」的桥侧应答方。
 *
 * 背景：桥把策略让给了 @gotgenes/pi-permission-system（approval.policyEngine），
 * 该扩展在子会话里先于桥的闸门执行 —— 它判 deny 时桥收不到调用，判 **ask** 时会做
 * 「父会话转发」：把请求写进文件信箱，等父会话应答。应答方**不必是 pi 进程**，
 * PS 只按心跳文件判断「这个 id 有没有人在收」，不看对方是什么。
 *
 * 于是桥可以自己当这个父会话 —— 只要在进程环境里声明「本进程的会话把 ask 转发给 <id>」，
 * 并发布心跳让人相信这个 id 确实有人在收。PS 官方文档（docs/subagent-integration.md，
 * Out-of-process implementations）明确支持这种用法：
 * 「Setting the variable in the implementation's own root process, so that children inherit
 *   it rather than receiving it per spawn, is supported.」
 *
 *   1. 声明父子关系：把桥侧父会话 id 写进进程环境（见 PS_FORWARDING_PARENT_ENV_KEYS）。
 *      变量是进程级的，效果是该进程内所有会话的 ask 都转发给我们 —— 正是我们要的：
 *      真正的发起会话从请求文件的 requesterSessionId 读，不靠环境变量区分。
 *      父会话 id 取固定值（而不是某个会话 id），任何会话都不会与它重合。
 *   2. 发布心跳 <root>/serving/<id>.json（内容带桥进程真实 pid）——
 *      PS 判目标是 dead_pid 是硬证据，不等 staleness；目标看起来没人服务时
 *      子会话只等 8 个轮询周期（2s）就 abandon 判拒绝。
 *   3. 轮询 <root>/sessions/<id>/requests/*.json → 弹飞书审批卡
 *   4. 用户点完 → 原子写 <root>/sessions/<id>/responses/<reqId>.json
 *
 * 协议形态对齐 PS 33.0.3（只读参考，未改动它）：
 *   - src/authority/permission-forwarding.ts（接口与常量）
 *   - src/authority/forwarding-io.ts（读写与容错读取）
 *   - src/authority/forwarding-liveness.ts（心跳与三态判定）
 *   - src/authority/forwarded-request-server.ts（应答方时序：先写响应再删请求）
 * 响应字段多一个少一个都会让子会话读不出来 → abandon 判拒绝，因此这里是**精确匹配**，
 * 且不 import 对方包（内部路径未导出；也用不着把桥的测试绑在对方的版本上）。
 */
import type { AlwaysApprovedStore } from "./always-approved-store.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalChoice, ApprovalVerdict } from "./permission-bridge.js";
import { redactParams } from "./permission-bridge.js";

// ------------------------------------------------------------ 协议常量 ----

/** PS 的转发轮询间隔（permission-forwarding.ts: PERMISSION_FORWARDING_POLL_INTERVAL_MS）。 */
export const PS_FORWARDING_POLL_INTERVAL_MS = 250;
/**
 * 心跳刷新周期：对齐 PS 的 SERVING_HEARTBEAT_REFRESH_MS（4 × 轮询 = 1s）。
 * 子会话的宽限期是 8 × 轮询 = 2s，刷新周期必须明显小于它 —— 所以这里不与
 * 轮询共用定时器：收件箱处理绝不能拖慢「我还在服务」这个信号。
 */
export const PS_FORWARDING_HEARTBEAT_REFRESH_MS = 4 * PS_FORWARDING_POLL_INTERVAL_MS;
/**
 * 父子关系的声明变量（PS docs/subagent-integration.md 的 subagent adapter convention）：
 *
 * - `PI_SUBAGENT_PARENT_SESSION` 是规范约定，文档写明「New implementations use
 *   PI_SUBAGENT_PARENT_SESSION only」，也是这里的主变量。
 * - `PI_AGENT_ROUTER_PARENT_SESSION_ID` 是历史兼容名（grandfathered），文档说明它
 *   「is still honored as a parent-session source, checked ahead of the convention name」
 *   —— 只是检查顺序在前，不是推荐用法。两个变量写同一个值，所以谁优先都不影响结果；
 *   两个都设是为了两头都成立：现在被优先采用的兼容名认，未来版本若移除兼容名也认。
 *
 * 另外：不要在这个进程里读这两个变量当作「桥自己也是个 subagent」的依据 —— 它们是桥
 * 主动设给子会话的；子会话与桥同进程，变量是进程级的，所以两边看到的是同一个值。
 */
export const PS_FORWARDING_PARENT_ENV_KEYS: readonly string[] = [
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_AGENT_ROUTER_PARENT_SESSION_ID",
];
/** 主变量（规范约定名）。 */
export const PS_FORWARDING_PARENT_ENV_KEY = PS_FORWARDING_PARENT_ENV_KEYS[0]!;
/** 桥侧父会话 id 默认值：稳定、且绝不可能等于任何真实 pi session id（UUID）。 */
export const DEFAULT_PS_FORWARDING_PARENT_ID = "feishu-bridge-parent";
/** PS 的转发超时上限（PERMISSION_FORWARDING_TIMEOUT_MS）——用于判断清理时机。 */
export const PS_FORWARDING_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * 记录（在途/已应答）的保留时长：超过后即使请求文件还在也不再重试。
 * 取 PS 转发总超时（10 分钟）的 1.5 倍 —— 保证不会在子会话还活着时把记录删掉后重复弹卡。
 */
export const PS_FORWARDING_RECORD_TTL_MS = PS_FORWARDING_UPSTREAM_TIMEOUT_MS * 1.5;

/** 请求 id 必须能安全地当文件名（PS 侧 approval-escalator.ts 的同名约束）。 */
const FILENAME_SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

// ------------------------------------------------------------ 目录布局 ----

/** 转发根目录：<agentDir>/sessions/permission-forwarding（PS 的 computeExtensionPaths）。 */
export function psForwardingRootDir(agentDir: string): string {
	return join(agentDir, "sessions", "permission-forwarding");
}

/** 心跳目录（与 sessions/ 平级，绝不放进去 —— 否则会话根目录永不空，清理逻辑会纠缠）。 */
export function psForwardingServingDir(root: string): string {
	return join(root, "serving");
}

/** 某个父会话的转发目录（session id 两处都用 encodeURIComponent 编码，保证一致）。 */
export function psForwardingSessionDir(root: string, sessionId: string): string {
	return join(root, "sessions", encodeURIComponent(sessionId));
}

export function psForwardingRequestsDir(root: string, sessionId: string): string {
	return join(psForwardingSessionDir(root, sessionId), "requests");
}

export function psForwardingResponsesDir(root: string, sessionId: string): string {
	return join(psForwardingSessionDir(root, sessionId), "responses");
}

export function psForwardingHeartbeatPath(root: string, sessionId: string): string {
	return join(psForwardingServingDir(root), `${encodeURIComponent(sessionId)}.json`);
}

// ------------------------------------------------------------ 线上格式 ----

/** 子会话请求里我们**会读**的字段（其余字段原样忽略，容忍版本漂移）。 */
export interface ForwardedRequestFile {
	id: string;
	createdAt: number;
	requesterSessionId: string;
	targetSessionId: string;
	requesterAgentName: string;
	payload?: {
		request?: {
			surface?: string;
			toolName?: string | null;
			value?: string;
			matchedPattern?: string | null;
			executedUnit?: string | null;
			commandContext?: unknown;
		};
	};
	surface?: string | null;
	value?: string | null;
	accessIntent?: { surface?: string; matchValues?: string[]; requesterCwd?: string };
}

/** PS 的判定状态里我们会用到的三个（其余值对转发路径没有意义）。 */
export type ForwardedResponseState = "approved" | "approved_for_session" | "denied";

/**
 * 父会话写回的响应文件：字段名与取值必须精确匹配 PS 的
 * `ForwardedPermissionResponse`（readForwardedPermissionResponse 会把
 * approved/state/responderSessionId 任一不合格的响应整体丢弃 → 子会话判为拒绝）。
 */
export interface ForwardedResponseFile {
	approved: boolean;
	state: ForwardedResponseState;
	denialReason?: string;
	responderSessionId: string;
	respondedAt: number;
	/** 谁决定的（PS 的 DecisionSource；`unavailable` = 没有真人拍板）。 */
	decidedBy: { kind: "user"; via: "dialog" } | { kind: "unavailable"; reason: string };
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * 容错读取：必需字段缺失即判无效（PS 自己也是这个尺度）。
 * 无效文件由调用方删除 —— 留着会每轮重复读。
 */
export function parseForwardedRequest(value: unknown): ForwardedRequestFile | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const id = asNonEmptyString(raw.id);
	const requesterSessionId = asNonEmptyString(raw.requesterSessionId);
	const targetSessionId = asNonEmptyString(raw.targetSessionId);
	const requesterAgentName = asNonEmptyString(raw.requesterAgentName);
	if (!id || !requesterSessionId || !targetSessionId || !requesterAgentName) return null;
	if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return null;

	const payloadRaw = asRecord(raw.payload);
	const factsRaw = asRecord(payloadRaw?.request);
	const intentRaw = asRecord(raw.accessIntent);
	const matchValues = Array.isArray(intentRaw?.matchValues)
		? intentRaw.matchValues.filter((entry): entry is string => typeof entry === "string")
		: undefined;

	return {
		id,
		createdAt: raw.createdAt,
		requesterSessionId,
		targetSessionId,
		requesterAgentName,
		payload: payloadRaw
			? {
				request: factsRaw
					? {
						surface: asNonEmptyString(factsRaw.surface),
						toolName: asNullableString(factsRaw.toolName) ?? undefined,
						value: typeof factsRaw.value === "string" ? factsRaw.value : undefined,
						matchedPattern: asNullableString(factsRaw.matchedPattern),
						executedUnit: asNullableString(factsRaw.executedUnit),
						commandContext: factsRaw.commandContext,
					}
					: undefined,
			}
			: undefined,
		surface: asNullableString(raw.surface),
		value: asNullableString(raw.value),
		accessIntent: intentRaw
			? {
				surface: asNonEmptyString(intentRaw.surface),
				matchValues,
				requesterCwd: asNonEmptyString(intentRaw.requesterCwd),
			}
			: undefined,
	};
}

/** 审批卡要显示的一条转发请求（从请求文件的多个来源里挑最准的那个字段）。 */
export interface ForwardedRequestView {
	requestId: string;
	requesterSessionId: string;
	requesterAgentName: string;
	/** PS 判定的闸门（bash / path / external_directory / 工具名…）。 */
	surface: string;
	toolName: string;
	/** 审批人真正要看的东西：bash 是命令原文，path 是路径。 */
	paramsText: string;
	/** 为什么弹这张卡（来源 + 命中规则 + 工作目录）。 */
	reason: string;
	/**
	 * PS 的规则名（请求 facts.matchedPattern）。「始终批准」按它记忆 ——
	 * 规则名由 PS 自己给出，与它的策略语义天然一致，桥不需要自造一套模式语言。
	 */
	matchedPattern?: string;
}

function isPathSurface(surface: string): boolean {
	return surface === "path" || surface === "external_directory";
}

/** 把请求文件折成卡片要的展示字段（正文预算由卡片自己截断，这里不截）。 */
export function describeForwardedRequest(request: ForwardedRequestFile): ForwardedRequestView {
	const facts = request.payload?.request;
	const surface = facts?.surface ?? request.surface ?? request.accessIntent?.surface ?? "unknown";
	const toolName = facts?.toolName ?? (surface === "bash" ? "bash" : surface);
	const value = facts?.value ?? request.value ?? request.accessIntent?.matchValues?.[0] ?? "";

	// PS 在拿不到 agent 名时会写 "unknown"（getActiveAgentName 的回退值）—— 别把它当人名展示
	const agent = request.requesterAgentName && request.requesterAgentName !== "unknown"
		? `「${request.requesterAgentName}」`
		: "";
	const reasons = [`来自子代理会话${agent}的转发审批`];
	if (facts?.matchedPattern) reasons.push(`命中规则：${facts.matchedPattern}`);
	if (facts?.executedUnit && facts.executedUnit !== value) reasons.push(`实际执行：${facts.executedUnit}`);
	if (validCommandContext(facts?.commandContext)) reasons.push(`命令位置：${facts.commandContext}`);
	const cwd = validCwd(request.accessIntent?.requesterCwd);
	if (cwd) reasons.push(`工作目录：${cwd}`);

	// bash 显示命令原文（不是 JSON 包装）；路径类显示 path 字段；其余按工具名序列化。
	// 三者都过 redactParams：卡片是发到飞书群里的，命令里的凭据不该跟着走。
	let paramsText: string;
	if (!value) {
		paramsText = `(${surface} 请求，未附带具体值)`;
	} else if (toolName === "bash") {
		paramsText = redactParams({ command: value }, "bash");
	} else if (isPathSurface(surface)) {
		paramsText = redactParams({ path: value });
	} else {
		paramsText = redactParams({ [toolName]: value });
	}

	return {
		requestId: request.id,
		requesterSessionId: request.requesterSessionId,
		requesterAgentName: request.requesterAgentName,
		surface,
		toolName,
		paramsText,
		reason: reasons.join("；"),
		matchedPattern: facts?.matchedPattern ?? undefined,
	};
}

function validCommandContext(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validCwd(value: string | undefined): string | undefined {
	return value && value.trim() ? value : undefined;
}

// ------------------------------------------------------------ 应答方 ----

/**
 * 配置 → 转发是否真的生效（纯函数，便于单测）：
 *
 * 开关打开还不够 —— 转发存在的唯一目的是把 PS 的 `ask` 送到飞书卡片上。
 * 策略引擎仍是桥自研时，PS 的 ask 和桥自己的命令策略会各自弹一张卡（同一次调用两张），
 * 所以那种组合下转发不生效，并在启动日志里说清原因。
 */
export function resolvePsForwardingConfig(approval: {
	forwarding?: { enabled?: boolean; parentSessionId?: string };
	policyEngine?: "bridge" | "pi-permission-system";
} | undefined): { enabled: boolean; parentSessionId: string; blockedBy?: "policyEngine" } {
	const enabled = Boolean(approval?.forwarding?.enabled);
	const blockedBy = enabled && approval?.policyEngine !== "pi-permission-system" ? "policyEngine" as const : undefined;
	return {
		enabled: enabled && !blockedBy,
		parentSessionId: approval?.forwarding?.parentSessionId?.trim() || DEFAULT_PS_FORWARDING_PARENT_ID,
		blockedBy,
	};
}

/** 飞书会话路由（与 BridgeRoute 同形；这里不 import 会话层，避免反向依赖）。 */
export interface PsForwardingRoute {
	conversationKey: string;
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
	runId?: string;
	senderId?: string;
}

/** 交给桥弹卡的一条转发请求（字段对齐 PermissionBridge.requestExternal 的输入）。 */
export interface PsForwardingApprovalInput {
	conversationKey: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	paramsText: string;
	reason: string;
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
	allowedOperatorIds: string[];
	/**
	 * 可选项。默认三档；桥侧维护了「始终批准」规则表时加第四档 always。
	 *
	 * 注意 always 的语义与 PS 原生对话框**不同**：PS 把它记进父会话的 SessionRules
	 * （`approved_for_serving_session`），桥走不到那条路，改为在桥侧规则表里记一条
	 * `matchedPattern`。效果对用户一致（同类不再询问），实现位置不同。
	 */
	choices: ApprovalChoice[];
}

/** 转发的默认可选项（无「始终批准」规则表时）。 */
export const PS_FORWARDING_CHOICES: ApprovalChoice[] = ["once", "session", "deny"];

/** 带「始终批准」的可选项（桥侧有规则表时使用）。 */
export const PS_FORWARDING_CHOICES_WITH_ALWAYS: ApprovalChoice[] = ["once", "session", "always", "deny"];

export type PsForwardingLog = (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;

export interface PsForwardingDeps {
	/**
	 * 「始终批准」规则表。存在时审批卡多一个 always 按钮，且命中规则的请求直接放行。
	 * 不传 = 该能力关闭（只保留 once/session/deny）。
	 */
	alwaysApproved?: AlwaysApprovedStore;
	/** 转发根目录（<agentDir>/sessions/permission-forwarding）。 */
	forwardingDir: string;
	/** 桥侧父会话 id（心跳与收件箱目录都用它）。 */
	parentSessionId: string;
	/** PS 的请求只带 session id，飞书路由由桥反查；取不到 = 无法归属 → 直接拒绝。 */
	routeForSessionId(sessionId: string): PsForwardingRoute | undefined;
	/** 允许的操作者（管理员快照）。 */
	allowedOperatorIds(): string[];
	/** 弹卡并等用户选择（复用 PermissionBridge.requestExternal）。 */
	requestDecision(input: PsForwardingApprovalInput): Promise<{ verdict: ApprovalVerdict; choice?: ApprovalChoice; operatorId?: string }>;
	onAudit?(event: Record<string, unknown>): void;
	log?: PsForwardingLog;
	now?(): number;
	/** 心跳里写的 pid（测试注入；默认真实进程 pid）。 */
	pid?: number;
	pollIntervalMs?: number;
	heartbeatRefreshMs?: number;
	recordTtlMs?: number;
	/** 停止时等待在途应答落盘的上限（SIGTERM 路径不能挂住进程）。 */
	stopDrainMs?: number;
}

export class PsForwardingServer {
	private readonly deps: PsForwardingDeps;
	private readonly root: string;
	private readonly parentSessionId: string;
	private readonly requestsDir: string;
	private readonly responsesDir: string;
	private readonly now: () => number;
	private readonly pid: number;
	private readonly pollIntervalMs: number;
	private readonly heartbeatRefreshMs: number;
	private readonly recordTtlMs: number;
	private readonly stopDrainMs: number;

	private started = false;
	/** 最近一次心跳写入成功的时间；doctor 用它判断"父会话是否真的在服务"。 */
	private lastHeartbeatAt: number | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	/** 已发起、尚未收尾的请求 id（防止每轮重复弹卡）。 */
	private readonly inflight = new Map<string, number>();
	/** 已得出的响应（响应写入失败时下轮重试；请求文件被清后按 TTL 回收）。 */
	private readonly answered = new Map<string, { response: ForwardedResponseFile; at: number }>();
	/** 在途应答任务（stop 时等它们落盘）。 */
	private readonly work = new Set<Promise<void>>();

	constructor(deps: PsForwardingDeps) {
		this.deps = deps;
		this.root = deps.forwardingDir;
		this.parentSessionId = deps.parentSessionId;
		this.requestsDir = psForwardingRequestsDir(this.root, this.parentSessionId);
		this.responsesDir = psForwardingResponsesDir(this.root, this.parentSessionId);
		this.now = deps.now ?? Date.now;
		this.pid = deps.pid ?? process.pid;
		this.pollIntervalMs = deps.pollIntervalMs ?? PS_FORWARDING_POLL_INTERVAL_MS;
		this.heartbeatRefreshMs = deps.heartbeatRefreshMs ?? PS_FORWARDING_HEARTBEAT_REFRESH_MS;
		this.recordTtlMs = deps.recordTtlMs ?? PS_FORWARDING_RECORD_TTL_MS;
		this.stopDrainMs = deps.stopDrainMs ?? 1_500;
	}

	/** 是否在跑（诊断/状态用）。 */
	isStarted(): boolean { return this.started; }

	/** 未决转发请求数（状态展示用）。 */
	pendingCount(): number { return this.inflight.size; }

	/**
	 * 开始服务：建目录 → 立刻发心跳 → 立即排空一次收件箱 → 起两个定时器。
	 * 心跳与轮询分开定时：收件箱处理再慢也不能让「我还在服务」这个信号迟到。
	 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.ensureDirs();
		this.publishHeartbeat();
		this.pollTimer = setInterval(() => this.drain(), this.pollIntervalMs);
		this.pollTimer.unref?.();
		this.heartbeatTimer = setInterval(() => this.publishHeartbeat(), this.heartbeatRefreshMs);
		this.heartbeatTimer.unref?.();
		// 立即排空：子会话的宽限期只有 2s，不能等第一个轮询周期
		this.drain();
		this.log("info", "feishu.approval.ps_forwarding_started", { parentSessionId: this.parentSessionId });
	}

	/**
	 * 停止服务：先撤心跳（让子会话尽快判「没人服务」而不是等满 10 分钟），
	 * 再等最多 stopDrainMs 让在途响应落盘（关停时被撤销的审批要如实答复为拒绝）。
	 */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.pollTimer = undefined;
		this.heartbeatTimer = undefined;
		this.withdrawHeartbeat();
		const drain = Promise.allSettled([...this.work]).then(() => undefined);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, this.stopDrainMs);
			timer.unref?.();
		});
		try {
			await Promise.race([drain, timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		this.log("info", "feishu.approval.ps_forwarding_stopped", { parentSessionId: this.parentSessionId });
	}

	/** 收发件箱一次（同步扫盘 + 异步应答；绝不在扫描里 await 用户点击）。 */
	private drain(): void {
		if (!this.started) return;
		this.reapRecords();
		this.sweepOrphanResponses();
		for (const fileName of this.listRequestFiles()) {
			const requestPath = join(this.requestsDir, fileName);
			const request = this.readRequestFile(requestPath);
			if (!request) {
				// 无效文件留着会每轮重复读；内容也没人能应答 → 直接清掉并留痕。
				this.log("warn", "feishu.approval.ps_forwarding_invalid_request", { file: fileName });
				this.deleteFile(requestPath);
				continue;
			}
			// 请求文件名必须是 <id>.json：否则 id 可以指到目录外（请求文件是别的进程写的，
			// 不校验就等于把路径穿越的口子交出去）。
			if (`${request.id}.json` !== fileName || !FILENAME_SAFE_REQUEST_ID.test(request.id)) {
				this.log("warn", "feishu.approval.ps_forwarding_request_id_mismatch", { file: fileName, id: request.id });
				this.deleteFile(requestPath);
				continue;
			}
			if (request.targetSessionId !== this.parentSessionId) {
				// 别人收件箱里的东西跑到我们目录了：不答，也不删（可能是 relay hop 写错的）。
				this.log("warn", "feishu.approval.ps_forwarding_foreign_target", {
					requestId: request.id, targetSessionId: request.targetSessionId,
				});
				continue;
			}
			this.handle(request, requestPath);
		}
	}

	private handle(request: ForwardedRequestFile, requestPath: string): void {
		// 已应答：请求文件还在，说明响应没写成或没被读走 → 幂等补写（不重复弹卡）。
		const done = this.answered.get(request.id);
		if (done) {
			if (this.writeResponseFile(request.id, done.response)) this.deleteFile(requestPath);
			return;
		}
		if (this.inflight.has(request.id)) return;
		this.inflight.set(request.id, this.now());
		this.deps.onAudit?.({ event: "ps_forwarding.request_seen", requestId: request.id, requesterSessionId: request.requesterSessionId });
		const task = this.run(request, requestPath)
			.catch((error) => {
				this.log("warn", "feishu.approval.ps_forwarding_answer_failed", {
					requestId: request.id, error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => { this.inflight.delete(request.id); });
		this.work.add(task);
		void task.finally(() => { this.work.delete(task); });
	}

	/** 一条请求的收尾：弹卡等选择 → 记响应 → 写响应文件 → 清请求文件。 */
	private async run(request: ForwardedRequestFile, requestPath: string): Promise<void> {
		const response = await this.answer(request);
		this.answered.set(request.id, { response, at: this.now() });
		// 请求文件没了 = 子会话已经放弃（它只会在读到响应后或超时后才清）→
		// 再写回去就是没人读的孤儿响应，不如不写。
		if (!existsSync(requestPath)) {
			this.log("warn", "feishu.approval.ps_forwarding_request_gone", { requestId: request.id });
			return;
		}
		// 写成功才删请求文件；写失败保留请求文件，下轮重试（子会话仍在轮询）。
		if (this.writeResponseFile(request.id, response)) this.deleteFile(requestPath);
	}

	/** 把一条请求折算成响应（不落盘）。 */
	private async answer(request: ForwardedRequestFile): Promise<ForwardedResponseFile> {
		const view = describeForwardedRequest(request);
		const route = this.deps.routeForSessionId(request.requesterSessionId);
		let response: ForwardedResponseFile;

		// 「始终批准」规则命中 → 直接放行，不再弹卡。
		//
		// 与 PS 原生语义对齐：它把 whole-session grant 翻译成**普通 approved**，让子会话
		// 什么都不记（子会话下次重新转发、由父会话按已记规则直接批准）。桥作为父会话，
		// 把规则记在自己的表里，同样**不给子会话留会话级授权** —— 这样撤销规则后能立刻
		// 恢复询问，不会被子会话残留的 `approved_for_session` 挡住。
		if (this.deps.alwaysApproved?.has(view.matchedPattern)) {
			this.deps.onAudit?.({
				event: "ps_forwarding.always_approved",
				requestId: request.id,
				requesterSessionId: request.requesterSessionId,
				pattern: view.matchedPattern,
			});
			this.log("info", "feishu.approval.ps_forwarding_always_approved", {
				requestId: request.id, pattern: view.matchedPattern,
			});
			return this.responseFor("approved", "once");
		}

		if (!route) {
			// 无法归属到任何飞书会话（会话已结束/不是桥管的会话）：不能装作问过用户。
			const reason = "该请求所属的飞书会话不存在或已结束，无法提交人工审批";
			response = this.deny(reason);
			this.deps.onAudit?.({
				event: "ps_forwarding.no_route", requestId: request.id, requesterSessionId: request.requesterSessionId, reason,
			});
			this.log("warn", "feishu.approval.ps_forwarding_no_route", {
				requestId: request.id, requesterSessionId: request.requesterSessionId,
			});
		} else {
			const decision = await this.deps.requestDecision({
				conversationKey: route.conversationKey,
				sessionId: request.requesterSessionId,
				runId: route.runId ?? request.id,
				// toolCallId 用请求 id：PS 的请求 id 就是它自己的 tool call 派生值，
				// 用它做审计关联，跨进程也能对上。
				toolCallId: request.id,
				toolName: view.toolName,
				paramsText: view.paramsText,
				reason: view.reason,
				chatId: route.chatId,
				threadId: route.threadId,
				sourceMessageId: route.sourceMessageId,
				allowedOperatorIds: this.deps.allowedOperatorIds(),
				choices: this.deps.alwaysApproved
					? [...PS_FORWARDING_CHOICES_WITH_ALWAYS]
					: [...PS_FORWARDING_CHOICES],
			});
			// 用户选了「始终批准」→ 把规则记进桥侧规则表（下次同规则直接放行）。
			// 没有 matchedPattern 时不记：没有判定依据就"永久放行"会把整个闸门挖空，
			// 这时 always 退化为 session（responseFor 的既有映射），并留一条告警。
			if (decision.verdict === "approved" && decision.choice === "always") {
				if (view.matchedPattern && this.deps.alwaysApproved) {
					const record = this.deps.alwaysApproved.add({
						pattern: view.matchedPattern,
						approvedBy: decision.operatorId,
						conversationKey: route.conversationKey,
					});
					this.deps.onAudit?.({
						event: "ps_forwarding.always_recorded", requestId: request.id,
						pattern: record.pattern, approvedBy: record.approvedBy ?? null,
						conversationKey: route.conversationKey,
					});
					this.log("info", "feishu.approval.ps_forwarding_always_recorded", {
						requestId: request.id, pattern: record.pattern, approvedBy: record.approvedBy ?? null,
					});
				} else {
					this.deps.onAudit?.({
						event: "ps_forwarding.always_degraded", requestId: request.id,
						reason: view.matchedPattern ? "规则表未启用" : "请求未带规则名（matchedPattern）",
					});
					this.log("warn", "feishu.approval.ps_forwarding_always_degraded", {
						requestId: request.id, pattern: view.matchedPattern ?? null,
					});
				}
			}
			response = this.responseFor(decision.verdict, decision.choice);
			this.deps.onAudit?.({
				event: "ps_forwarding.answered", requestId: request.id, requesterSessionId: request.requesterSessionId,
				verdict: decision.verdict, choice: decision.choice ?? null, state: response.state,
			});
		}
		return response;
	}

	/**
	 * 父会话是否"在服务"：已启动且心跳新鲜（两个周期内有成功写入）。
	 *
	 * PS 的子会话会等父会话的宽限期；心跳停了但进程还活着时，子会话会判
	 * `stale` 并提前放弃 —— 表现在日志里只是"等到超时"，很难定位，
	 * 所以 doctor 要能看到这个信号。
	 */
	isServing(): boolean {
		if (!this.started) return false;
		if (this.lastHeartbeatAt === undefined) return false;
		return this.now() - this.lastHeartbeatAt <= this.heartbeatRefreshMs * 2;
	}

	/**
	 * 判定 → 响应文件。转发路径的「本会话批准」（以及退化的 always）映射为
	 * `approved_for_session`：PS 的子会话收到该状态会自己记一条会话级授权
	 * （gate 的 `decision.state === "approved_for_session"` 分支），不会因为过了一次跳窄成一次性。
	 *
	 * 注意「始终批准」**命中规则表时走的不是这里**：那条路径返回普通 `approved`，
	 * 让子会话什么都不记（由桥的规则表持续放行）—— 两者语义不同，见 `answer()`。
	 */
	responseFor(verdict: ApprovalVerdict, choice?: ApprovalChoice): ForwardedResponseFile {
		const respondedAt = this.now();
		if (verdict === "approved") {
			return {
				approved: true,
				state: choice === "session" || choice === "always" ? "approved_for_session" : "approved",
				responderSessionId: this.parentSessionId,
				respondedAt,
				decidedBy: { kind: "user", via: "dialog" },
			};
		}
		return this.deny(verdict === "timeout"
			? "飞书审批超时（无人处理），本次请求未获批准"
			: "飞书审批被拒绝");
	}

	/** 拒绝响应（`unavailable` = 没有真人拍板，PS 据此报 confirmation_unavailable）。 */
	private deny(reason: string): ForwardedResponseFile {
		return {
			approved: false,
			state: "denied",
			denialReason: reason,
			responderSessionId: this.parentSessionId,
			respondedAt: this.now(),
			decidedBy: { kind: "unavailable", reason },
		};
	}

	// ------------------------------------------------------------ 文件 IO ----

	private ensureDirs(): void {
		// 目录由 PS 的子会话在写请求时创建；这里也建一遍，保证心跳与响应写入的父目录存在。
		for (const dir of [psForwardingServingDir(this.root), this.requestsDir, this.responsesDir]) {
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			} catch (error) {
				this.log("warn", "feishu.approval.ps_forwarding_mkdir_failed", {
					dir, error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** 发布/刷新心跳（PS 判「有人在服务」的唯一跨进程信号）。失败不抛：退化成等待超时即可。 */
	private publishHeartbeat(): void {
		try {
			mkdirSync(psForwardingServingDir(this.root), { recursive: true, mode: 0o700 });
			this.writeJsonAtomic(psForwardingHeartbeatPath(this.root, this.parentSessionId), {
				sessionId: this.parentSessionId,
				// PS 判 dead_pid 是硬证据（不等 staleness），所以必须是真实存活进程的 pid
				pid: this.pid,
				updatedAt: this.now(),
			});
			this.lastHeartbeatAt = this.now();
		} catch (error) {
			this.log("warn", "feishu.approval.ps_forwarding_heartbeat_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private withdrawHeartbeat(): void {
		this.deleteFile(psForwardingHeartbeatPath(this.root, this.parentSessionId));
	}

	private listRequestFiles(): string[] {
		try {
			return readdirSync(this.requestsDir).filter((name) => name.endsWith(".json")).sort();
		} catch {
			// 目录不存在是常态（PS 清空后会 rmdir）—— 空收件箱，不是错误。
			return [];
		}
	}

	private readRequestFile(path: string): ForwardedRequestFile | null {
		try {
			return parseForwardedRequest(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			return null;
		}
	}

	/** 原子写响应文件（tmp + rename），返回是否成功。 */
	private writeResponseFile(requestId: string, response: ForwardedResponseFile): boolean {
		if (!FILENAME_SAFE_REQUEST_ID.test(requestId)) return false;
		try {
			mkdirSync(this.responsesDir, { recursive: true, mode: 0o700 });
			this.writeJsonAtomic(join(this.responsesDir, `${requestId}.json`), response);
			return true;
		} catch (error) {
			this.log("warn", "feishu.approval.ps_forwarding_response_write_failed", {
				requestId, error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	private writeJsonAtomic(path: string, value: unknown): void {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, path);
	}

	private deleteFile(path: string): void {
		try {
			unlinkSync(path);
		} catch {
			// ENOENT 是常态（子会话先读过就删了）
		}
	}

	/**
	 * 回收内存记录：只按 TTL。
	 * 还没到期的记录要留着 —— 一是响应写入失败时下轮还能重试，
	 * 二是请求文件先消失时（子会话放弃）那条没人读的响应要等 TTL 到期才能清。
	 */
	private reapRecords(): void {
		const at = this.now();
		for (const [requestId, entry] of this.answered) {
			if (at - entry.at >= this.recordTtlMs) this.answered.delete(requestId);
		}
		for (const [requestId, startedAt] of this.inflight) {
			if (at - startedAt >= this.recordTtlMs) this.inflight.delete(requestId);
		}
	}

	/**
	 * 清掉没人读的响应文件：请求文件已不存在（子会话放弃或已读过），且响应已超过 TTL。
	 *
	 * 判据用文件 mtime 而不是内存记录：进程重启后内存记录就没了，而目录里的孤儿文件还在。
	 * TTL（15 分钟）大于 PS 的转发总超时（10 分钟），所以不可能抢掉一个还在轮询的子会话的文件。
	 */
	private sweepOrphanResponses(): void {
		let names: string[];
		try {
			names = readdirSync(this.responsesDir).filter((name) => name.endsWith(".json"));
		} catch {
			return;
		}
		for (const name of names) {
			const responsePath = join(this.responsesDir, name);
			try {
				if (this.now() - statSync(responsePath).mtimeMs < this.recordTtlMs) continue;
			} catch {
				continue;
			}
			if (existsSync(join(this.requestsDir, name))) continue;
			this.log("warn", "feishu.approval.ps_forwarding_orphan_response", { file: name });
			this.deleteFile(responsePath);
		}
	}

	private log(level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown): void {
		this.deps.log?.(level, msg, meta);
	}
}

/**
 * 声明/撤销本进程的父子关系。
 *
 * 为什么要显式撤销：变量是进程级的，关掉转发后若还留着，PS 会把 ask 转发到一个
 * 没人收的收件箱 → 子会话等满超时才判拒绝（而正确的行为是回落到它自己的判定）。
 * 只删自己设过的值（环境变量可能是外层 spawner 设的，别人的声明不能动）。
 */
export function applyPsForwardingParentEnv(options: {
	enabled: boolean;
	parentSessionId: string;
	/** 本进程此前自己声明过的值；只有它能被撤回，外层 spawner 的声明不动。 */
	previousApplied?: string;
	env?: NodeJS.ProcessEnv;
}): { appliedValue?: string; overridden: Array<{ key: string; value: string }> } {
	const env = options.env ?? process.env;
	const overridden = PS_FORWARDING_PARENT_ENV_KEYS
		.filter((key) => typeof env[key] === "string" && env[key] !== options.parentSessionId)
		.map((key) => ({ key, value: String(env[key]) }));
	if (options.enabled) {
		for (const key of PS_FORWARDING_PARENT_ENV_KEYS) env[key] = options.parentSessionId;
		return { appliedValue: options.parentSessionId, overridden };
	}
	for (const key of PS_FORWARDING_PARENT_ENV_KEYS) {
		// 只删自己设过的值：别的 spawner 写进来的声明不能动。
		if (options.previousApplied !== undefined && env[key] === options.previousApplied) delete env[key];
	}
	return { overridden: [] };
}
