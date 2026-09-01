/**
 * 去重（dedup）与文本批量合并（batch）。
 * 设计依据：docs/DESIGN.md §3.3；参考 hermes _is_duplicate / _text_batch_*。
 */
import type { FeishuInboundMessage } from "../types.js";

// ------------------------------------------------------------ 去重 ----

export class DedupCache {
	private seen = new Map<string, number>();
	constructor(private capacity: number) {}

	/** 返回 true 表示"首次见到"（应处理）；false 表示重复（应丢弃）。 */
	check(messageId: string): boolean {
		if (this.seen.has(messageId)) return false;
		this.seen.set(messageId, Date.now());
		if (this.seen.size > this.capacity) {
			// 淘汰最旧
			let oldest: string | undefined;
			let oldestTs = Infinity;
			for (const [k, v] of this.seen) {
				if (v < oldestTs) {
					oldestTs = v;
					oldest = k;
				}
			}
			if (oldest) this.seen.delete(oldest);
		}
		return true;
	}
}

// ------------------------------------------------------------ 批量 ----

export interface Batchable {
	chatId: string;
	text: string;
}

export interface BatchWindow {
	chatId: string;
	parts: string[];
	firstTs: number;
	lastTs: number;
}

/**
 * 文本批量合并器：同一 chat 在 windowMs 窗口内到达的 text 合并为一条。
 * 转发拆条（多条连续 text）自动合并，减少 agent 轮次与噪音。
 */
export class TextBatcher {
	private windows = new Map<string, BatchWindow>();
	constructor(private windowMs: number) {}

	/**
	 * 尝试把消息并入窗口。返回 true=已合并（调用方应丢弃单条）；false=作为窗口首条开启新窗口。
	 * 窗口 flush 由调用方通过定时器触发（pipeline 管理 timer）。
	 */
	offer(msg: FeishuInboundMessage): boolean {
		if (msg.msgType !== "text" || !msg.text) return false;
		const now = Date.now();
		const existing = this.windows.get(msg.chatId);
		if (existing && now - existing.lastTs <= this.windowMs) {
			existing.parts.push(msg.text);
			existing.lastTs = now;
			return true;
		}
		this.windows.set(msg.chatId, { chatId: msg.chatId, parts: [msg.text], firstTs: now, lastTs: now });
		return false;
	}

	/** 取出并清掉某 chat 的合并窗口（调用方保证已到窗口期；此处不检查时间，便于测试）。 */
	flush(chatId: string): BatchWindow | undefined {
		const w = this.windows.get(chatId);
		if (!w) return undefined;
		this.windows.delete(chatId);
		return w;
	}

	flushAll(): Array<BatchWindow> {
		const out: BatchWindow[] = [];
		for (const chatId of [...this.windows.keys()]) {
			const w = this.flush(chatId);
			if (w) out.push(w);
		}
		return out;
	}
}
