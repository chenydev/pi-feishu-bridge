/**
 * 去重（dedup）与文本批量合并（batch）。
 * 设计依据：docs/DESIGN.md §3.3；参考 hermes _is_duplicate / _text_batch_*。
 */
import type { FeishuInboundMessage } from "../types.js";
import { DedupeStore } from "./dedupe-store.js";

// ------------------------------------------------------------ 去重 ----

export class DedupCache extends DedupeStore {
	constructor(capacity: number) {
		super({ capacity, ttlMs: Number.POSITIVE_INFINITY });
	}
}

// ------------------------------------------------------------ 批量 ----

export interface Batchable {
	chatId: string;
	text: string;
}

export interface BatchWindow {
	key: string;
	chatId: string;
	parts: string[];
	messageIds: string[];
	carrier: FeishuInboundMessage;
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
	offer(key: string, msg: FeishuInboundMessage): boolean {
		if (msg.msgType !== "text" || !msg.text) return false;
		const now = Date.now();
		const existing = this.windows.get(key);
		if (existing && now - existing.lastTs <= this.windowMs) {
			existing.parts.push(msg.text);
			existing.messageIds.push(msg.messageId);
			existing.carrier = msg;
			existing.lastTs = now;
			return true;
		}
		this.windows.set(key, { key, chatId: msg.chatId, parts: [msg.text], messageIds: [msg.messageId], carrier: msg, firstTs: now, lastTs: now });
		return false;
	}

	peek(key: string): BatchWindow | undefined {
		return this.windows.get(key);
	}

	/** 取出并清掉某 chat 的合并窗口（调用方保证已到窗口期；此处不检查时间，便于测试）。 */
	flush(key: string): BatchWindow | undefined {
		const w = this.windows.get(key);
		if (!w) return undefined;
		this.windows.delete(key);
		return w;
	}

	flushAll(): Array<BatchWindow> {
		const out: BatchWindow[] = [];
		for (const key of [...this.windows.keys()]) {
			const w = this.flush(key);
			if (w) out.push(w);
		}
		return out;
	}
}

/** 只有消息上下文完全兼容时才能合并为同一个 Agent turn。 */
export function batchCompatible(existing: FeishuInboundMessage, incoming: FeishuInboundMessage): boolean {
	return existing.msgType === incoming.msgType
		&& existing.senderId === incoming.senderId
		&& existing.threadId === incoming.threadId
		&& existing.replyToMessageId === incoming.replyToMessageId
		&& existing.replyToText === incoming.replyToText;
}
