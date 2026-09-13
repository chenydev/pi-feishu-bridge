const DEFAULT_MAX_CHARS = 15_000;

interface LiveState {
	messageId: string;
	text: string;
	timer?: ReturnType<typeof setTimeout>;
	lastFlushAt: number;
	failures: number;
	closed: boolean;
	flushing?: Promise<void>;
}

export interface LiveChannelDeps {
	edit: (messageId: string, text: string) => Promise<boolean>;
	throttleMs?: number;
	maxChars?: number;
	maxFailures?: number;
	now?: () => number;
}

function renderLiveText(text: string, maxChars: number): string {
	let output = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n…（完整内容将在最终消息中发送）` : text;
	const fences = output.match(/```/g)?.length ?? 0;
	if (fences % 2 === 1) output += "\n```";
	return output;
}

/** 易失流式通道：只改善首 token 体验，正确性始终由 durable final 保证。 */
export class LiveChannel {
	private states = new Map<string, LiveState>();
	private readonly throttleMs: number;
	private readonly maxChars: number;
	private readonly maxFailures: number;
	private readonly now: () => number;

	constructor(private deps: LiveChannelDeps) {
		this.throttleMs = deps.throttleMs ?? 350;
		this.maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
		this.maxFailures = deps.maxFailures ?? 3;
		this.now = deps.now ?? Date.now;
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

	/** 停止易失更新，把现有消息交给 durable final 编辑；熔断时返回 undefined 以改走新消息。 */
	async claimFinalTarget(key: string): Promise<string | undefined> {
		const state = this.states.get(key);
		if (!state) return undefined;
		if (state.timer) clearTimeout(state.timer);
		state.timer = undefined;
		state.closed = true;
		await state.flushing;
		if (this.states.get(key) === state) this.states.delete(key);
		return state.text && state.failures < this.maxFailures ? state.messageId : undefined;
	}

	discard(key: string): void {
		const state = this.states.get(key);
		if (state?.timer) clearTimeout(state.timer);
		this.states.delete(key);
	}

	private schedule(key: string, state: LiveState): void {
		if (state.timer) return;
		const delay = Math.max(0, this.throttleMs - (this.now() - state.lastFlushAt));
		state.timer = setTimeout(() => {
			state.timer = undefined;
			state.flushing = this.flush(key, state).finally(() => { state.flushing = undefined; });
		}, delay);
		state.timer.unref?.();
	}

	private async flush(key: string, state: LiveState): Promise<void> {
		if (state.closed || this.states.get(key) !== state) return;
		state.lastFlushAt = this.now();
		let ok = false;
		try { ok = await this.deps.edit(state.messageId, renderLiveText(state.text, this.maxChars)); } catch { ok = false; }
		if (!ok) state.failures += 1;
		else state.failures = 0;
		if (state.failures >= this.maxFailures) state.closed = true;
	}
}
