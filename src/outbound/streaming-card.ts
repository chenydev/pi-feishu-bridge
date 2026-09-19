/**
 * CardKit 流式卡片（P1-01，默认关闭，配置 `streamingCard.enabled` 才启用）。
 *
 * 设计取舍 —— **卡片承载最终答案，可靠性仍由文本通道兜底**：
 * - 卡片负责「边想边显示」，收尾写入最终正文；成功即视为该 turn 的 final 已交付（同时 ack 接管账本）。
 * - 卡片创建/更新任一失败都降级：记录日志、停掉更新，调用方改走既有 durable outbox 文本路径。
 * - 更新节流（默认 800ms）+ 只发累积文本，避免每个 token 都打 API。
 *
 * 已实测可用的最小 API 集（2026-09-19 用真实租户验证）：
 * - `POST /open-apis/cardkit/v1/cards`                         创建卡片实体 → card_id
 * - `PUT  /open-apis/cardkit/v1/cards/{id}/elements/{eid}/content`  全量设置元素内容
 * - `POST /open-apis/im/v1/messages`（msg_type=interactive，content 里引用 card_id）发到会话
 * 注：`GET /cards/{id}`、`DELETE /cards/{id}`、`PATCH /cards/{id}/settings` 均返回 404/失败，
 * 因此不依赖它们做清理或关闭 streaming_mode。
 */

import { randomUUID } from "node:crypto";

export const STREAM_ELEMENT_ID = "stream";

export interface StreamingCardDeps {
	rawRequest: (opts: { url: string; method: string; params?: unknown; data?: unknown }) => Promise<unknown>;
	log?: (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
	/** 更新节流（毫秒），默认 800。 */
	throttleMs?: number;
	/** 单次发送的文本上限，超出截断（避免卡片体积过大）。 */
	maxChars?: number;
	now?: () => number;
}

export interface StreamingCardTarget {
	chatId: string;
	replyTo?: string;
	threadId?: string;
}

export class StreamingCard {
	private cardId?: string;
	private messageId?: string;
	private sequence = 0;
	private target?: StreamingCardTarget;
	private timer?: ReturnType<typeof setTimeout>;
	private pendingText?: string;
	private lastFlushAt = 0;
	private broken = false;
	/** 写入串行链：保证同一卡片上的 PUT 不会并发。 */
	/** 写入链：保证同一卡片的 PUT 严格顺序（并发会导致空白卡片）。 */
	private writeChain: Promise<void> = Promise.resolve();
	// 埋点：卡片 API 累计耗时（判断卡片是不是瓶颈）
	private totalWriteMs = 0;
	private writeCount = 0;
	private finished = false;
	private readonly throttleMs: number;
	private readonly maxChars: number;
	private readonly now: () => number;
	private readonly startedAt: number;

	constructor(private deps: StreamingCardDeps) {
		// 默认 200ms：实测飞书 CardKit 在 200ms 间隔下连续 8 次更新全部落地
		// （真正限制吞吐的是 HTTP 往返，不是平台频率），因此这个值可以按体感调。
		// 显式传入时按传入值走 —— 调用方（config/测试）知道自己要什么。
		this.throttleMs = Math.max(0, deps.throttleMs ?? 100);
		this.maxChars = Math.max(200, deps.maxChars ?? 8_000);
		this.now = deps.now ?? Date.now;
		this.startedAt = this.now();
	}

	/** 是否处于可用状态（启用且未失败）。 */
	get available(): boolean { return Boolean(this.cardId) && !this.broken && !this.finished; }
	get id(): string | undefined { return this.cardId; }
	get sentMessageId(): string | undefined { return this.messageId; }

	/** 创建卡片实体并作为回复发出；任一步失败返回 false（调用方应降级到文本通道）。 */
	async start(target: StreamingCardTarget, initialText = "正在处理…"): Promise<boolean> {
		this.target = target;
		try {
			const created = await this.deps.rawRequest({
				url: "/open-apis/cardkit/v1/cards",
				method: "POST",
				data: {
					type: "card_json",
					data: JSON.stringify(this.cardJson(initialText.slice(0, this.maxChars))),
				},
			}) as { data?: { card_id?: string } };
			const cardId = created?.data?.card_id;
			if (!cardId) throw new Error("cardkit create returned no card_id");
			this.cardId = cardId;

			const sent = await this.deps.rawRequest(target.replyTo ? {
				url: `/open-apis/im/v1/messages/${target.replyTo}/reply`,
				method: "POST",
				data: {
					msg_type: "interactive",
					content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
					reply_in_thread: Boolean(target.threadId),
				},
			} : {
				url: "/open-apis/im/v1/messages",
				method: "POST",
				params: target.threadId ? { receive_id_type: "thread_id" } : { receive_id_type: "chat_id" },
				data: {
					receive_id: target.threadId ?? target.chatId,
					msg_type: "interactive",
					content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
				},
			}) as { data?: { message_id?: string } };
			this.messageId = sent?.data?.message_id;
			this.lastFlushAt = this.now();
			this.deps.log?.("info", "feishu.stream_card.started", { cardId, hasMessageId: Boolean(this.messageId) });
			return true;
		} catch (error) {
			this.broken = true;
			this.deps.log?.("warn", "feishu.stream_card.start_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/** 节流提交增量文本（累积态，非增量片段）。 */
	update(text: string): void {
		if (!this.available) return;
		this.pendingText = text;
		const elapsed = this.now() - this.lastFlushAt;
		if (elapsed >= this.throttleMs) {
			void this.flush();
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.throttleMs - elapsed);
		this.timer.unref?.();
	}

	/** 收尾：写入最终正文并停止更新。返回是否成功（失败则由调用方按文本通道兜底）。 */
	async finish(finalText: string): Promise<boolean> {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		if (!this.available) { this.finished = true; return false; }
		// writeChain 保证最终内容一定排在所有在途写入之后落地
		const ok = await this.flushText(finalText);
		this.finished = true;
		// 汇总可用于判断"吐字"流畅度：写入次数 / 内容长度 / 实际节流
		this.deps.log?.(ok ? "info" : "warn", "feishu.stream_card.finished", {
			cardId: this.cardId,
			ok,
			writes: this.sequence,
			contentLen: finalText.length,
			throttleMs: this.throttleMs,
			elapsedMs: this.now() - this.startedAt,
			apiTotalMs: this.totalWriteMs,
			apiAvgMs: this.writeCount > 0 ? Math.round(this.totalWriteMs / this.writeCount) : 0,
		});
		return ok;
	}

	/** 放弃卡片（run 失败/中止）：尽量写一句状态，之后不再更新。 */
	async abandon(reason: string): Promise<void> {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		if (!this.available) { this.finished = true; return; }
		await this.flushText(reason);
		this.finished = true;
	}

	private async flush(): Promise<void> {
		// 清掉挂起的定时器：否则「达到节流间隔」与「定时器到期」会各触发一次写入
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		if (!this.pendingText || !this.available) return;
		// 立即记账（不是等 API 回来才记）：写入是串行的，若等回来再记，
		// 排队期间的每个 delta 都会重新满足节流条件，导致节流形同虚设
		// （实测 throttleMs=1000 仍然写了 66 次）。
		this.lastFlushAt = this.now();
		await this.flushText(this.pendingText);
	}

	/**
	 * 串行化写入：同一卡片的 PUT 必须**顺序**执行。
	 *
	 * 实测教训（2026-09-19）：并发/高频写入时飞书只应用了第一次内容，
	 * 后面每次都返回 `ok: true` 但群里始终停在最初的几行 —— 卡片看着"卡住"，
	 * 而 API 全是成功，无法靠返回值发现。因此这里用 promise 链强制串行，
	 * 并把等待期间的新内容合并成一次写入。
	 */
	private flushText(text: string): Promise<boolean> {
		// 串行写入：并发会让 sequence 乱序，飞书侧最终**渲染成空白卡片**（2026-09-19 实测）。
		// 串行本身没问题 —— 真正的问题是"请求次数太多导致延迟累加"，
		// 所以解法是**提高节流减少次数**（throttleMs >= API 单次延迟），而不是并发。
		const chained = this.writeChain.then(() => this.doWrite(text), () => this.doWrite(text));
		this.writeChain = chained.then(() => undefined, () => undefined);
		return chained;
	}

	private async doWrite(text: string): Promise<boolean> {
		if (!this.cardId || this.broken) return false;
		// 排队期间用户又产出了新内容：直接用最新的，中间态没有发送价值（每次推的都是全量）
		const latest = this.pendingText ?? text;
		if (latest.length > text.length) text = latest;
		const writeStart = this.now();
		try {
			this.sequence += 1;
			await this.deps.rawRequest({
				url: `/open-apis/cardkit/v1/cards/${this.cardId}/elements/${STREAM_ELEMENT_ID}/content`,
				method: "PUT",
				// uuid 幂等键：飞书 cardkit 要求，且网络重试时不会重复应用同一段
				data: { content: this.window(text), sequence: this.sequence, uuid: randomUUID() },
			});
			this.lastFlushAt = this.now();
			this.totalWriteMs += this.lastFlushAt - writeStart;
			this.writeCount += 1;
			return true;
		} catch (error) {
			// 卡片链路故障不影响最终交付：标记损坏后调用方仍走文本通道
			this.broken = true;
			this.deps.log?.("warn", "feishu.stream_card.update_failed", {
				cardId: this.cardId,
				error: error instanceof Error ? error.message : String(error),
				// 只记 message 定位不了 400：把服务端返回体一起带上
				detail: extractErrorDetail(error),
				sequence: this.sequence,
				contentLen: text.length,
			});
			return false;
		}
	}

	/** 超出上限时保留开头 + 尾部截断标记（答题场景开头是结论，比取尾部更有用）。 */
	private window(text: string): string {
		if (text.length <= this.maxChars) return text;
		return `${text.slice(0, this.maxChars)}\n\n…（内容过长，卡片已省略 ${text.length - this.maxChars} 字）`;
	}

	private cardJson(text: string): unknown {
		return {
			schema: "2.0",
			config: { streaming_mode: true },   // 必须为 true：否则元素的动态更新不生效（实测卡片会一直停在初始文案）
			body: {
				elements: [
					{ tag: "markdown", element_id: STREAM_ELEMENT_ID, content: text },
				],
			},
		};
	}
}

/** 从 axios/SDK 错误里挖出服务端返回体（飞书的 code/msg 在 response.data 里）。 */
function extractErrorDetail(error: unknown): unknown {
	const response = (error as { response?: { status?: number; data?: unknown } })?.response;
	if (!response) return undefined;
	return { status: response.status, data: response.data };
}
