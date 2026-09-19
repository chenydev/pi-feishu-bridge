/**
 * 澄清/选择提问的生命周期（P2-01）。
 *
 * 与工具审批**完全独立**：
 * - 选择只恢复对应的等待点，**绝不**写入 PermissionBridge 的 sessionAllow/autoApprove；
 * - 每条等待绑定 request/token/会话/run/卡片/chat/允许回答者/TTL；
 * - 跨群、错误用户、重复点击、过期、stop/重置后点击一律拒绝；
 * - 重启不假装能恢复内存 Promise：启动时把历史未决等待标记为失效并通知。
 */
import { randomUUID } from "node:crypto";

export type ClarificationDecision =
	| { status: "answered"; choice: string; operatorOpenId: string }
	| { status: "timeout" }
	| { status: "cancelled"; reason: string };

export interface ClarificationPending {
	id: string;
	token: string;
	conversationKey: string;
	chatId: string;
	threadId?: string;
	runId: string;
	toolCallId: string;
	question: string;
	options: string[];
	/** 允许作答者（通常等于管理员名单；空数组表示不限制）。 */
	allowedResponderIds: string[];
	cardMessageId?: string;
	expiresAt: number;
	createdAt: number;
	verdict: Promise<ClarificationDecision>;
	resolve: (decision: ClarificationDecision) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ClarificationStoreDeps {
	/** 允许作答者名单（每次查询以支持配置变更）。 */
	allowedResponderIds: () => string[];
	/** 默认超时（毫秒）。 */
	timeoutMs?: number;
	onAudit?: (event: {
		clarificationId: string; conversationKey: string; runId: string; question: string;
		decision: string; choice?: string; operatorOpenId?: string;
	}) => void;
	now?: () => number;
}

export interface ClarificationRequest {
	conversationKey: string;
	chatId: string;
	threadId?: string;
	runId: string;
	toolCallId: string;
	question: string;
	options: string[];
	timeoutMs?: number;
}

const MAX_OPTIONS = 4;

export class ClarificationStore {
	private pending = new Map<string, ClarificationPending>();
	private readonly now: () => number;
	private readonly defaultTimeoutMs: number;
	private shuttingDown = false;

	constructor(private deps: ClarificationStoreDeps) {
		this.now = deps.now ?? Date.now;
		this.defaultTimeoutMs = Math.max(1_000, deps.timeoutMs ?? 120_000);
	}

	/** 新建一次提问：返回 pending 与其 verdict（调用方等待选择/超时/取消）。 */
	create(input: ClarificationRequest): ClarificationPending {
		const options = input.options.map((option) => option.trim()).filter(Boolean).slice(0, MAX_OPTIONS);
		if (options.length < 2) throw new Error("澄清提问至少需要 2 个选项");
		let resolveDecision: (decision: ClarificationDecision) => void = () => {};
		const verdict = new Promise<ClarificationDecision>((resolve) => { resolveDecision = resolve; });
		const timeoutMs = Math.max(1_000, input.timeoutMs ?? this.defaultTimeoutMs);
		const pending: ClarificationPending = {
			id: randomUUID(), token: randomUUID(),
			conversationKey: input.conversationKey, chatId: input.chatId, threadId: input.threadId,
			runId: input.runId, toolCallId: input.toolCallId,
			question: input.question.slice(0, 500), options,
			allowedResponderIds: this.deps.allowedResponderIds(),
			expiresAt: this.now() + timeoutMs, createdAt: this.now(),
			verdict, resolve: resolveDecision,
		};
		this.pending.set(pending.id, pending);
		pending.timer = setTimeout(() => this.consume(pending, { status: "timeout" }, "timeout"), timeoutMs);
		pending.timer.unref?.();
		// 关闭期间创建的等待立即失效，避免留下永远没人回答的卡片
		if (this.shuttingDown) this.consume(pending, { status: "cancelled", reason: "shutdown" }, "shutdown");
		return pending;
	}

	/** 记录卡片消息 id（卡片发送成功后调用；失败路径由调用方取消）。 */
	attachCard(id: string, cardMessageId: string | undefined): boolean {
		const pending = this.pending.get(id);
		if (!pending) return false;
		pending.cardMessageId = cardMessageId;
		return Boolean(cardMessageId);
	}

	/** 处理一次点击：跨群/错误用户/重复/过期一律拒绝，正确选项只消费一次。 */
	decide(input: {
		id: string; token: string; messageId: string; chatId: string; operatorOpenId: string; choice: string;
	}): { ok: boolean; reason: string; pending?: ClarificationPending } {
		const pending = this.pending.get(input.id);
		if (!pending) return { ok: false, reason: "该提问已失效" };
		if (this.now() > pending.expiresAt) {
			this.consume(pending, { status: "timeout" }, "timeout");
			return { ok: false, reason: "该提问已超时" };
		}
		if (input.token !== pending.token) return { ok: false, reason: "提问上下文不匹配" };
		if (pending.cardMessageId && input.messageId !== pending.cardMessageId) return { ok: false, reason: "提问上下文不匹配" };
		if (input.chatId !== pending.chatId) return { ok: false, reason: "该提问不属于当前会话" };
		if (pending.allowedResponderIds.length > 0 && !pending.allowedResponderIds.includes(input.operatorOpenId)) {
			return { ok: false, reason: "你没有作答权限" };
		}
		if (!pending.options.includes(input.choice)) return { ok: false, reason: "无效选项" };
		this.pending.delete(pending.id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve({ status: "answered", choice: input.choice, operatorOpenId: input.operatorOpenId });
		this.deps.onAudit?.({
			clarificationId: pending.id, conversationKey: pending.conversationKey, runId: pending.runId,
			question: pending.question, decision: "answered", choice: input.choice, operatorOpenId: input.operatorOpenId,
		});
		return { ok: true, reason: `已选择：${input.choice}`, pending };
	}

	/** run 结束/超时/被替换 → 撤销该 run 的未决提问。 */
	cancelRun(conversationKey: string, runId: string): number {
		let cancelled = 0;
		for (const pending of [...this.pending.values()]) {
			if (pending.conversationKey !== conversationKey || pending.runId !== runId) continue;
			this.consume(pending, { status: "cancelled", reason: "run-ended" }, "run_ended");
			cancelled += 1;
		}
		return cancelled;
	}

	/** 会话重置/恢复 → 撤销该会话全部未决提问。 */
	cancelConversation(conversationKey: string): number {
		let cancelled = 0;
		for (const pending of [...this.pending.values()]) {
			if (pending.conversationKey !== conversationKey) continue;
			this.consume(pending, { status: "cancelled", reason: "conversation-reset" }, "conversation_reset");
			cancelled += 1;
		}
		return cancelled;
	}

	/** 进程关闭：全部失效（不假装可恢复）。 */
	shutdown(): number {
		this.shuttingDown = true;
		let cancelled = 0;
		for (const pending of [...this.pending.values()]) {
			this.consume(pending, { status: "cancelled", reason: "shutdown" }, "shutdown");
			cancelled += 1;
		}
		return cancelled;
	}

	pendingCount(): number { return this.pending.size; }

	/** 该会话是否有未决提问（P1-08 回收判定用）。 */
	pendingForConversation(conversationKey: string): number {
		let count = 0;
		for (const pending of this.pending.values()) {
			if (pending.conversationKey === conversationKey) count += 1;
		}
		return count;
	}

	/** 诊断快照（不含 token/question 全文）。 */
	snapshot(): Array<{ id: string; conversationKey: string; runId: string; options: number; expiresAt: number }> {
		return [...this.pending.values()].map((pending) => ({
			id: pending.id, conversationKey: pending.conversationKey, runId: pending.runId,
			options: pending.options.length, expiresAt: pending.expiresAt,
		}));
	}

	private consume(pending: ClarificationPending, decision: ClarificationDecision, auditDecision: string): void {
		this.pending.delete(pending.id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(decision);
		this.deps.onAudit?.({
			clarificationId: pending.id, conversationKey: pending.conversationKey, runId: pending.runId,
			question: pending.question, decision: auditDecision,
		});
	}
}

/** 澄清卡片（纯文本选项回退用同一份选项文案）。 */
export function buildClarificationCard(pending: ClarificationPending): unknown {
	const buttons = pending.options.map((option, index) => ({
		tag: "button",
		text: { tag: "plain_text", content: option.slice(0, 20) },
		type: index === 0 ? "primary" : "default",
		value: { op: "clarify", clarificationId: pending.id, token: pending.token, choice: option },
	}));
	return {
		schema: "2.0",
		body: { elements: [
			{ tag: "markdown", content: `**需要你确认**\n\n${pending.question}` },
			...buttons,
		] },
	};
}

/** 无卡片权限时的文本回退文案（用户可直接回复选项文本）。 */
export function clarificationTextFallback(pending: ClarificationPending): string {
	const lines = pending.options.map((option, index) => `${index + 1}. ${option}`);
	return `**需要你确认**\n\n${pending.question}\n\n${lines.join("\n")}\n\n（直接回复上面的选项文本即可）`;
}

export function buildClarificationResultCard(choice: string, operatorOpenId: string): unknown {
	return { schema: "2.0", body: { elements: [{ tag: "markdown", content: `**已记录你的选择**\n\n${choice}\n\nby ${operatorOpenId}` }] } };
}
