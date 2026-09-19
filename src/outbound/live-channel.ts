/**
 * 易失流式通道 + 单目标串行写入器（P0-04）。
 *
 * 修复的缺陷（R2）：旧实现用单个 `flushing` Promise 表示在途写入，
 * 第二次写入会**覆盖**第一次的引用 —— `claimFinalTarget()` 只等到最后一次写入，
 * 第一次（更早、内容更旧）的 edit 可能迟到并在 durable final 之后落地，覆盖最终内容。
 *
 * 现在的保证：
 *   1. 同一 messageId 的 edit **严格串行**（链式队列，永不并发）；
 *   2. `claimFinalTarget()` 先关闭入口，再 drain **全部**在途写入，最后才交给 durable；
 *   3. 写入有截止时间；超时无法取消 HTTP，因此该消息被标记为**不可信**，
 *      final 不再复用它（改发新消息），避免被迟到写入污染。
 */
import type { RateBudget } from "../runtime/rate-budget.js";

const DEFAULT_MAX_CHARS = 15_000;
const DEFAULT_WRITE_TIMEOUT_MS = 20_000;

interface ChainState {
	/** 队尾 Promise：新写入挂在其后，保证串行。 */
	tail: Promise<void>;
	/** 已入队但未完成的写入数。 */
	pending: number;
	/** 存在超时未确认的写入：该 messageId 内容不可信，不得作为 final 目标复用。 */
	uncertain: boolean;
	/** drain 等待者（pending 归零时统一唤醒）。 */
	waiters: Array<(value: { ok: boolean }) => void>;
}

export interface SerialWriterDeps {
	edit: (messageId: string, text: string) => Promise<boolean>;
	/** 单次写入截止时间（默认 20s）。 */
	timeoutMs?: number;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

/**
 * 单目标串行写入器：同一 messageId 的 edit 严格串行，可 drain，超时标记不可信。
 * 供流式消息与工具进度消息共用（两者可能是不同 messageId，各自独立串行）。
 */
export class SerialWriter {
	private chains = new Map<string, ChainState>();
	private readonly timeoutMs: number;

	constructor(private deps: SerialWriterDeps) {
		this.timeoutMs = deps.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
	}

	/** 排入一次写入；onResult 在该次写入落定后回调（成功/失败/超时）。 */
	enqueue(messageId: string, text: string, hooks: { onResult?: (ok: boolean) => void } = {}): void {
		const chain = this.chains.get(messageId) ?? { tail: Promise.resolve(), pending: 0, uncertain: false, waiters: [] };
		this.chains.set(messageId, chain);
		chain.pending += 1;
		chain.tail = chain.tail.then(async () => {
			// 已 discard 的状态（重启/撤回）不再写入。
			if (this.chains.get(messageId) !== chain) {
				chain.pending -= 1;
				this.settle(chain);
				return;
			}
			let ok = false;
			let timedOut = false;
			try {
				const raced = await this.withTimeout(this.deps.edit(messageId, text));
				ok = raced.ok;
				timedOut = raced.timedOut;
			} catch {
				ok = false;
			}
			if (timedOut) {
				// HTTP 无法真正取消：服务器可能仍迟到落地，故该消息不得再被复用为 final 目标。
				chain.uncertain = true;
				this.deps.log?.("warn", "feishu.live.write_timeout", { messageId, timeoutMs: this.timeoutMs });
			}
			chain.pending -= 1;
			hooks.onResult?.(ok);
			this.settle(chain);
		});
	}

	/** 等待该 messageId 的全部在途写入结束；ok=false 表示存在超时未确认写入。 */
	async drain(messageId: string): Promise<{ ok: boolean }> {
		const chain = this.chains.get(messageId);
		if (!chain || chain.pending === 0) return { ok: !(chain?.uncertain ?? false) };
		return await new Promise<{ ok: boolean }>((resolve) => { chain.waiters.push(resolve); });
	}

	/** 是否存在未确认（超时）写入。 */
	isUncertain(messageId: string): boolean {
		return this.chains.get(messageId)?.uncertain ?? false;
	}

	/** 丢弃某目标的写入状态（撤回消息、重置会话后调用）。 */
	discard(messageId: string): void {
		const chain = this.chains.get(messageId);
		if (!chain) return;
		this.chains.delete(messageId);
		for (const waiter of chain.waiters.splice(0)) waiter({ ok: false });
	}

	private settle(chain: ChainState): void {
		if (chain.pending > 0) return;
		for (const waiter of chain.waiters.splice(0)) waiter({ ok: !chain.uncertain });
	}

	private async withTimeout(promise: Promise<boolean>): Promise<{ ok: boolean; timedOut: boolean }> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
			timer.unref?.();
		});
		try {
			const result = await Promise.race([promise, timeout]);
			if (result === "timeout") return { ok: false, timedOut: true };
			return { ok: result === true, timedOut: false };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

interface LiveState {
	messageId: string;
	text: string;
	timer?: ReturnType<typeof setTimeout>;
	lastFlushAt: number;
	failures: number;
	closed: boolean;
}

function renderLiveText(text: string, maxChars: number): string {
	let output = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…（完整内容将在最终消息中发送）` : text;
	const fences = output.match(/```/g)?.length ?? 0;
	if (fences % 2 === 1) output += "\n```";
	return output;
}

export interface LiveChannelDeps {
	edit: (messageId: string, text: string) => Promise<boolean>;
	throttleMs?: number;
	maxChars?: number;
	maxFailures?: number;
	now?: () => number;
	/** 写入截止时间（默认 20s）。 */
	writeTimeoutMs?: number;
	/** P1-07：共享请求预算 —— 预算不足或限流冷却时跳过本次易失更新（不丢内容）。 */
	budget?: RateBudget;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

/** 易失流式通道：只改善首 token 体验，正确性始终由 durable final 保证。 */
export class LiveChannel {
	private states = new Map<string, LiveState>();
	private readonly writer: SerialWriter;
	private readonly throttleMs: number;
	private readonly maxChars: number;
	private readonly maxFailures: number;
	private readonly now: () => number;

	constructor(private deps: LiveChannelDeps) {
		this.throttleMs = deps.throttleMs ?? 350;
		this.maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
		this.maxFailures = deps.maxFailures ?? 3;
		this.now = deps.now ?? Date.now;
		this.writer = new SerialWriter({
			edit: deps.edit,
			timeoutMs: deps.writeTimeoutMs,
			log: deps.log,
		});
	}

	open(key: string, messageId: string): void {
		this.discard(key);
		this.states.set(key, { messageId, text: "", lastFlushAt: 0, failures: 0, closed: false });
	}

	append(key: string, delta: string): void {
		const state = this.states.get(key);
		if (!state || state.closed || state.failures >= this.maxFailures || !delta) return;
		state.text += delta;
		this.schedule(key, state);
	}

	hasContent(key: string): boolean {
		return Boolean(this.states.get(key)?.text);
	}

	/**
	 * 停止易失更新，把现有消息交给 durable final 编辑。
	 * 返回 undefined 表示不应复用该消息（无内容 / 已熔断 / 存在超时未确认写入）。
	 */
	async claimFinalTarget(key: string): Promise<string | undefined> {
		const state = this.states.get(key);
		if (!state) return undefined;
		// ① 先关闭入口：此后的 append 与定时写入都不再排入。
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		state.closed = true;
		// ② drain 全部在途写入（不只是最后一次）。
		const drained = await this.writer.drain(state.messageId);
		if (this.states.get(key) === state) this.states.delete(key);
		// ③ 只有内容存在、未熔断、且无超时未确认写入时才复用该消息。
		const reusable = Boolean(state.text) && state.failures < this.maxFailures && drained.ok;
		return reusable ? state.messageId : undefined;
	}

	discard(key: string): void {
		const state = this.states.get(key);
		if (!state) return;
		if (state.timer) clearTimeout(state.timer);
		this.states.delete(key);
		this.writer.discard(state.messageId);
	}

	private schedule(key: string, state: LiveState): void {
		if (state.timer) return;
		const delay = Math.max(0, this.throttleMs - (this.now() - state.lastFlushAt));
		state.timer = setTimeout(() => {
			state.timer = undefined;
			if (state.closed || this.states.get(key) !== state) return;
			// P1-07：易失通道让路给最终交付/审批；预算不足只是「这次不发」，文本仍留在 state.text
			if (this.deps.budget) {
				const lease = this.deps.budget.tryAcquire("live");
				if (!lease.ok) {
					this.deps.log?.("debug", "feishu.live.budget_skip", { reason: lease.reason, retryAfterMs: lease.retryAfterMs });
					return;
				}
			}
			state.lastFlushAt = this.now();
			this.writer.enqueue(state.messageId, renderLiveText(state.text, this.maxChars), {
				onResult: (ok) => {
					if (ok) state.failures = 0;
					else state.failures += 1;
					if (state.failures >= this.maxFailures) state.closed = true;
				},
			});
		}, delay);
		state.timer.unref?.();
	}
}
