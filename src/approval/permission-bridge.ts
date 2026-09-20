import { randomUUID } from "node:crypto";

export type ToolDecision = "allow" | "ask" | "deny";
export type ApprovalChoice = "once" | "session" | "always" | "deny";
/** 卡片/校验的选项顺序（四档全开时的默认集合）。 */
export const ALL_APPROVAL_CHOICES: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];
/** 卡片终态（用于把已发出的卡片置灰）。 */
export type ApprovalCardTerminal = "timeout" | "approved" | "denied" | "invalidated";

export type ApprovalVerdict = "approved" | "denied" | "timeout";

const SAFE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["bash", "powershell", "edit", "write"]);

export interface PendingApproval {
	id: string;
	token: string;
	conversationKey: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	paramsText: string;
	/**
	 * 为什么需要审批（来自命令级策略的判定，如"不在只读白名单"）。
	 * 参考 hermes 的 `Reason: {description}` —— 让审批人知道自己在批什么，
	 * 而不是看到一个孤零零的命令就凭感觉点。
	 */
	reason?: string;
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
	allowedOperatorIds: string[];
	/**
	 * 本审批允许的选项。外部审批源（如 pi-permission-system 转发）可收窄。
	 * 转发路径现在**提供** always：桥侧用规则表实现等价语义（PS 原生把它记在
	 * 父会话的 SessionRules 里，桥走不到那条路，改为记 matchedPattern）。
	 * 缺省为四档全开。
	 */
	choices?: ApprovalChoice[];
	/**
	 * 用户实际点的选项（超时/失效/被撤销时没有）。
	 * 转发响应必须区分「仅本次」与「本会话」（对应 PS 的 approved / approved_for_session）。
	 */
	resolvedChoice?: ApprovalChoice;
	/**
	 * 实际点卡片的操作者 open_id（已通过 allowedOperatorIds 校验）。
	 * 外部审批源用它做持久化审计 —— 比如转发路径的「始终批准」要记下是谁放行的。
	 */
	operatorOpenId?: string;
	cardMessageId?: string;
	expiresAt: number;
	verdict: Promise<ApprovalVerdict>;
	resolve: (verdict: ApprovalVerdict) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/** 未决审批的调用方输入（id/token/cardMessageId/expiresAt/verdict/resolve/timer 由 bridge 生成）。 */
export type PendingApprovalInput = Omit<
	PendingApproval,
	"id" | "token" | "cardMessageId" | "expiresAt" | "verdict" | "resolve" | "timer" | "resolvedChoice"
>;

export interface PermissionBridgeDeps {
	getConfig: () => { autoApprove: string[]; timeoutMs: number };
	onAsk: (pending: PendingApproval) => Promise<string | undefined>;
	onAlwaysAllow?: (toolName: string) => boolean | void;
	/** P0-03：run 存活探测（默认不限制；提供后旧卡在 run 结束后不得再授予权限）。 */
	/**
	 * 状态被非用户操作终结（超时/run 结束/关闭）时回调，用于把卡片改成不可点的终态。
	 * 用户主动点击的路径不触发：那条路径由飞书回调用返回的 card 原地更新。
	 */
	onCardResolve?: (pending: PendingApproval, outcome: { resultText: string; terminal: ApprovalCardTerminal }) => void;
	onAudit?: (event: {
		approvalId?: string; conversationKey: string; sessionId: string; runId: string; toolCallId: string;
		toolName: string; decision: string; paramsSummary: string; cardMessageId?: string; operatorOpenId?: string;
		/** 该审批实际提供的选项（排障用：能看出卡片该有几个按钮）。 */
		choices?: readonly ApprovalChoice[];
	}) => void;
	now?: () => number;
}

export function redactParams(value: unknown, toolName?: string): string {
	const scrub = (text: string) =>
		text
			.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
			.replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s"']+/gi, "$1***");

	// bash：人要看的是命令本身，不是 `{"command":"..."}` 这层 JSON 包装。
	// 而且 JSON 里换行会被转义成 \n，卡片上挤成一行后被截断 —— 审批时根本看不清在批什么。
	if (toolName === "bash") {
		const command = (value as { command?: unknown } | undefined)?.command;
		if (typeof command === "string" && command.trim()) {
			return scrub(command).slice(0, 1500);
		}
	}

	const serialized = scrub(
		JSON.stringify(value ?? {}, (key, child) =>
			/(?:token|secret|password|authorization|api[_-]?key)/i.test(key) ? "***" : child,
		),
	);
	return serialized.slice(0, 800);
}

export function classifyToolCall(toolName: string, autoApprove: string[], sessionAllow: Set<string>): ToolDecision {
	if (!toolName) return "deny";
	if (SAFE_TOOLS.has(toolName) || autoApprove.includes(toolName) || sessionAllow.has(toolName)) return "allow";
	if (MUTATING_TOOLS.has(toolName)) return "ask";
	return "ask";
}

export class PermissionBridge {
	private pending = new Map<string, PendingApproval>();
	private sessionAllow = new Map<string, Set<string>>();
	private readonly now: () => number;

	constructor(private deps: PermissionBridgeDeps) {
		this.now = deps.now ?? Date.now;
	}

	async gate(input: PendingApprovalInput): Promise<{ decision: ToolDecision; verdict?: Promise<ApprovalVerdict> }> {
		const config = this.deps.getConfig();
		const decision = classifyToolCall(input.toolName, config.autoApprove, this.sessionAllow.get(input.conversationKey) ?? new Set());
		this.deps.onAudit?.({
			conversationKey: input.conversationKey, sessionId: input.sessionId, runId: input.runId,
			toolCallId: input.toolCallId, toolName: input.toolName, decision, paramsSummary: input.paramsText,
		});
		if (decision !== "ask") return { decision };
		const pending = this.enqueue(input, config.timeoutMs);
		await this.announce(pending);
		return { decision, verdict: pending.verdict };
	}

	/**
	 * 外部审批源（pi-permission-system 父会话转发）：该请求已经由外部策略判定为
	 * 「需要人工批准」，因此不再走桥的分类器，直接登记 + 弹卡，并把用户的选择
	 * 一并带回（转发响应必须区分「仅本次」与「本会话」）。
	 */
	async requestExternal(
		input: PendingApprovalInput,
		options: { timeoutMs?: number; auditDecision?: string } = {},
	): Promise<{ pending: PendingApproval; verdict: ApprovalVerdict; choice?: ApprovalChoice; operatorId?: string }> {
		const pending = this.enqueue(input, options.timeoutMs ?? this.deps.getConfig().timeoutMs);
		this.deps.onAudit?.({
			conversationKey: pending.conversationKey, sessionId: pending.sessionId, runId: pending.runId,
			toolCallId: pending.toolCallId, toolName: pending.toolName,
			decision: options.auditDecision ?? "external_ask", paramsSummary: pending.paramsText,
			// 把实际可选项打进审计：排障时能一眼看出"这张卡该有几个按钮"，
			// 而不用去比对发卡时刻的配置状态（配置可能已经被改过）。
			choices: pending.choices ?? ALL_APPROVAL_CHOICES,
		});
		await this.announce(pending);
		const verdict = await pending.verdict;
		return { pending, verdict, choice: pending.resolvedChoice, operatorId: pending.operatorOpenId };
	}

	decide(input: { id: string; token: string; messageId: string; chatId?: string; operatorOpenId: string; choice: ApprovalChoice }): { ok: boolean; reason: string; pending?: PendingApproval } {
		const pending = this.pending.get(input.id);
		if (!pending) return { ok: false, reason: "审批已失效" };
		if (this.now() > pending.expiresAt) { this.consume(pending, "timeout"); return { ok: false, reason: "审批已超时" }; }
		if (!pending.allowedOperatorIds.includes(input.operatorOpenId)) return { ok: false, reason: "仅管理员可审批" };
		// 选项白名单：外部审批源可能只提供子集（例如转发路径不给「始终批准」）。
		// 必须在消费之前校验 —— 否则一张被重放/伪造的回调能把「不给的选项」变成授权。
		if (!(pending.choices ?? ALL_APPROVAL_CHOICES).includes(input.choice)) return { ok: false, reason: "该审批不支持此选项" };
		if (input.token !== pending.token || input.messageId !== pending.cardMessageId || input.chatId !== pending.chatId) return { ok: false, reason: "审批上下文不匹配" };

		// P0-03：“始终允许”必须先落盘成功才放行；落盘失败按拒绝处理，不得反馈持久授权成功。
		if (input.choice === "always") {
			let persisted: boolean | void = true;
			try {
				persisted = this.deps.onAlwaysAllow?.(pending.toolName);
			} catch {
				persisted = false;
			}
			if (persisted === false) {
				this.consume(pending, "denied");
				return { ok: false, reason: "授权配置写入失败，未生效" };
			}
		}

		pending.operatorOpenId = input.operatorOpenId;
		this.pending.delete(pending.id);
		if (pending.timer) clearTimeout(pending.timer);
		if (input.choice === "session") {
			const allowed = this.sessionAllow.get(pending.conversationKey) ?? new Set<string>();
			allowed.add(pending.toolName);
			this.sessionAllow.set(pending.conversationKey, allowed);
		}
		const approved = input.choice !== "deny";
		pending.resolvedChoice = input.choice;
		pending.resolve(approved ? "approved" : "denied");
		this.deps.onAudit?.({
			approvalId: pending.id, conversationKey: pending.conversationKey, sessionId: pending.sessionId,
			runId: pending.runId, toolCallId: pending.toolCallId, toolName: pending.toolName,
			decision: input.choice, paramsSummary: pending.paramsText, cardMessageId: pending.cardMessageId,
			operatorOpenId: input.operatorOpenId,
		});
		return { ok: true, reason: approved ? "已批准" : "已拒绝", pending };
	}

	resetSession(conversationKey: string): void {
		this.cancelConversation(conversationKey);
	}

	/**
	 * P0-03：按 run 失效未决审批 —— run 结束/超时/stop/被替换后，旧卡不得再授予权限。
	 * 返回被撤销的审批数。
	 */
	cancelRun(conversationKey: string, runId: string): number {
		let cancelled = 0;
		for (const pending of [...this.pending.values()]) {
			if (pending.conversationKey !== conversationKey || pending.runId !== runId) continue;
			this.consume(pending, "denied");
			cancelled += 1;
		}
		return cancelled;
	}

	/**
	 * P0-03：按会话失效（/new、reset、dispose）—— 撤销该会话全部未决审批，
	 * 并按需清空会话级授权（默认清空）。返回被撤销的审批数。
	 */
	cancelConversation(conversationKey: string, options: { clearSessionAllow?: boolean } = {}): number {
		if (options.clearSessionAllow !== false) this.sessionAllow.delete(conversationKey);
		let cancelled = 0;
		for (const pending of [...this.pending.values()]) {
			if (pending.conversationKey !== conversationKey) continue;
			this.consume(pending, "denied");
			cancelled += 1;
		}
		return cancelled;
	}

	/** P1-08：该会话未决审批数（有未决审批时不允许回收会话句柄）。 */
	pendingForConversation(conversationKey: string): number {
		let count = 0;
		for (const pending of this.pending.values()) {
			if (pending.conversationKey === conversationKey) count += 1;
		}
		return count;
	}

	/** 该会话当前的会话级授权工具集（诊断/测试用）。 */
	sessionAllowList(conversationKey: string): string[] {
		return [...(this.sessionAllow.get(conversationKey) ?? new Set<string>())];
	}

	pendingCount(): number { return this.pending.size; }

	shutdown(): void {
		for (const pending of [...this.pending.values()]) this.consume(pending, "denied");
		this.sessionAllow.clear();
	}

	private expire(id: string): void {
		const pending = this.pending.get(id);
		if (pending) this.consume(pending, "timeout");
	}

	/** 登记一条未决审批并起超时定时器（gate 与外部审批源共用）。 */
	private enqueue(input: PendingApprovalInput, timeoutMs: number): PendingApproval {
		let resolveVerdict: (value: ApprovalVerdict) => void = () => {};
		const verdict = new Promise<ApprovalVerdict>((resolve) => { resolveVerdict = resolve; });
		const pending: PendingApproval = {
			...input, id: randomUUID(), token: randomUUID(), expiresAt: this.now() + timeoutMs,
			// 缺省四档全开：桥自研路径的选项集合不变。
			choices: input.choices ?? [...ALL_APPROVAL_CHOICES],
			verdict, resolve: resolveVerdict,
		};
		this.pending.set(pending.id, pending);
		pending.timer = setTimeout(() => this.expire(pending.id), timeoutMs);
		pending.timer.unref?.();
		return pending;
	}

	/**
	 * 弹卡并等卡片结果落位：timeout/shutdown 已消费 pending 时，
	 * 迟到的卡片结果不得复活审批（因此这里不复用返回的卡 id）。
	 */
	private async announce(pending: PendingApproval): Promise<void> {
		try {
			const cardMessageId = await Promise.race([
				this.deps.onAsk(pending),
				pending.verdict.then(() => undefined),
			]);
			if (!this.pending.has(pending.id)) return;
			pending.cardMessageId = cardMessageId;
			if (!pending.cardMessageId) throw new Error("approval card send failed");
		} catch (error) {
			// 卡片发送失败必须留痕：早期版本这里静默吞错，导致「审批直接被拒」无法定位。
			this.deps.onAudit?.({
				conversationKey: pending.conversationKey, sessionId: pending.sessionId, runId: pending.runId,
				toolCallId: pending.toolCallId, toolName: pending.toolName, decision: "card_failed",
				paramsSummary: error instanceof Error ? error.message : String(error),
			});
			this.consume(pending, "denied");
		}
	}

	private consume(pending: PendingApproval, verdict: ApprovalVerdict): void {
		if (!this.pending.delete(pending.id)) return; // 幂等：重复消耗不重复通知卡片
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(verdict);
		// 非用户点击的终结路径：把卡片改成终态并禁用按钮（否则卡片会一直看起来能点）
		const terminal: ApprovalCardTerminal = verdict === "timeout" ? "timeout"
			: verdict === "approved" ? "approved" : verdict === "denied" ? "denied" : "invalidated";
		this.deps.onCardResolve?.(pending, {
			resultText: terminal === "timeout" ? "已超时（未处理）"
				: terminal === "approved" ? "已批准"
				: terminal === "denied" ? "已失效" : "已失效",
			terminal,
		});
		this.deps.onAudit?.({
			approvalId: pending.id, conversationKey: pending.conversationKey, sessionId: pending.sessionId,
			runId: pending.runId, toolCallId: pending.toolCallId, toolName: pending.toolName,
			decision: verdict, paramsSummary: pending.paramsText, cardMessageId: pending.cardMessageId,
		});
	}
}
