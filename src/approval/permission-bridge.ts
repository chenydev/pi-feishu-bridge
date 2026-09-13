import { randomUUID } from "node:crypto";

export type ToolDecision = "allow" | "ask" | "deny";
export type ApprovalChoice = "once" | "session" | "always" | "deny";
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
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
	allowedOperatorIds: string[];
	cardMessageId?: string;
	expiresAt: number;
	verdict: Promise<ApprovalVerdict>;
	resolve: (verdict: ApprovalVerdict) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface PermissionBridgeDeps {
	getConfig: () => { autoApprove: string[]; timeoutMs: number };
	onAsk: (pending: PendingApproval) => Promise<string | undefined>;
	onAlwaysAllow?: (toolName: string) => void;
	onAudit?: (event: {
		approvalId?: string; conversationKey: string; sessionId: string; runId: string; toolCallId: string;
		toolName: string; decision: string; paramsSummary: string; cardMessageId?: string; operatorOpenId?: string;
	}) => void;
	now?: () => number;
}

export function redactParams(value: unknown): string {
	const serialized = JSON.stringify(value ?? {}, (key, child) =>
		/(?:token|secret|password|authorization|api[_-]?key)/i.test(key) ? "***" : child,
	);
	return serialized
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***")
		.replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s"']+/gi, "$1***")
		.slice(0, 800);
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

	async gate(input: Omit<PendingApproval, "id" | "token" | "cardMessageId" | "expiresAt" | "verdict" | "resolve" | "timer">): Promise<{ decision: ToolDecision; verdict?: Promise<ApprovalVerdict> }> {
		const config = this.deps.getConfig();
		const decision = classifyToolCall(input.toolName, config.autoApprove, this.sessionAllow.get(input.conversationKey) ?? new Set());
		this.deps.onAudit?.({
			conversationKey: input.conversationKey, sessionId: input.sessionId, runId: input.runId,
			toolCallId: input.toolCallId, toolName: input.toolName, decision, paramsSummary: input.paramsText,
		});
		if (decision !== "ask") return { decision };
		let resolveVerdict: (value: ApprovalVerdict) => void = () => {};
		const verdict = new Promise<ApprovalVerdict>((resolve) => { resolveVerdict = resolve; });
		const pending: PendingApproval = {
			...input, id: randomUUID(), token: randomUUID(), expiresAt: this.now() + config.timeoutMs,
			verdict, resolve: resolveVerdict,
		};
		this.pending.set(pending.id, pending);
		pending.timer = setTimeout(() => this.expire(pending.id), config.timeoutMs);
		pending.timer.unref?.();
		try {
			const cardMessageId = await Promise.race([
				this.deps.onAsk(pending),
				verdict.then(() => undefined),
			]);
			// timeout/shutdown 已消费 pending；迟到的卡片结果不得复活审批。
			if (!this.pending.has(pending.id)) return { decision, verdict };
			pending.cardMessageId = cardMessageId;
			if (!pending.cardMessageId) throw new Error("approval card send failed");
		} catch {
			this.consume(pending, "denied");
		}
		return { decision, verdict };
	}

	decide(input: { id: string; token: string; messageId: string; chatId?: string; operatorOpenId: string; choice: ApprovalChoice }): { ok: boolean; reason: string; pending?: PendingApproval } {
		const pending = this.pending.get(input.id);
		if (!pending) return { ok: false, reason: "审批已失效" };
		if (this.now() > pending.expiresAt) { this.consume(pending, "timeout"); return { ok: false, reason: "审批已超时" }; }
		if (!pending.allowedOperatorIds.includes(input.operatorOpenId)) return { ok: false, reason: "仅管理员可审批" };
		if (input.token !== pending.token || input.messageId !== pending.cardMessageId || input.chatId !== pending.chatId) return { ok: false, reason: "审批上下文不匹配" };
		this.pending.delete(pending.id);
		if (pending.timer) clearTimeout(pending.timer);
		if (input.choice === "session") {
			const allowed = this.sessionAllow.get(pending.conversationKey) ?? new Set<string>();
			allowed.add(pending.toolName);
			this.sessionAllow.set(pending.conversationKey, allowed);
		}
		if (input.choice === "always") this.deps.onAlwaysAllow?.(pending.toolName);
		const approved = input.choice !== "deny";
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
		this.sessionAllow.delete(conversationKey);
		for (const pending of [...this.pending.values()]) {
			if (pending.conversationKey === conversationKey) this.consume(pending, "denied");
		}
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

	private consume(pending: PendingApproval, verdict: ApprovalVerdict): void {
		this.pending.delete(pending.id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(verdict);
		this.deps.onAudit?.({
			approvalId: pending.id, conversationKey: pending.conversationKey, sessionId: pending.sessionId,
			runId: pending.runId, toolCallId: pending.toolCallId, toolName: pending.toolName,
			decision: verdict, paramsSummary: pending.paramsText, cardMessageId: pending.cardMessageId,
		});
	}
}
