/**
 * 入站流水线（pipeline）：dedup → batch → admit → reply-resolve → dispatch。
 * 设计依据：docs/DESIGN.md §3.3。唯一丢弃点在 admit 与 dedup。
 */
import type { BridgeConfig, FeishuInboundMessage } from "../types.js";
import { LastSentCache, admit } from "./admit.js";
import { DedupCache, TextBatcher } from "./pipeline-utils.js";
import type { FeishuTransport } from "./transport.js";

export interface PipelineStats {
	total: number;
	duplicate: number;
	batched: number;
	dropped: number;
	dispatched: number;
	lastMessageAt?: number;
}

export interface PipelineDeps {
	config: BridgeConfig;
	transport: FeishuTransport;
	lastSent: LastSentCache;
	onDispatch: (msg: FeishuInboundMessage) => Promise<void>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

export class InboundPipeline {
	private dedup: DedupCache;
	private batcher: TextBatcher;
	private stats: PipelineStats = { total: 0, duplicate: 0, batched: 0, dropped: 0, dispatched: 0 };
	private quoteCache = new Map<string, { text: string; at: number }>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private deps: PipelineDeps) {
		this.dedup = new DedupCache(deps.config.dedupCacheSize);
		this.batcher = new TextBatcher(deps.config.batch.textWindowMs);
	}

	getStats(): PipelineStats {
		return { ...this.stats };
	}

	/** 处理单条入站消息（transport 回调）。 */
	async handle(msg: FeishuInboundMessage): Promise<void> {
		this.stats.total += 1;
		this.stats.lastMessageAt = Date.now();

		// 1. 去重
		if (!this.dedup.check(msg.messageId)) {
			this.stats.duplicate += 1;
			this.deps.log?.("debug", "feishu.pipeline.drop_duplicate", { messageId: msg.messageId });
			return;
		}

		// 2. 批量合并（群 text 窗口；转发拆条自动合并）
		if (this.deps.config.batch.enabled && msg.chatType !== "p2p") {
			const joined = this.batcher.offer(msg);
			// 无论并入与否，最后一条消息是 flush 时的载体
			if (joined) {
				this.stats.batched += 1;
				this.deps.log?.("debug", "feishu.pipeline.batched", { messageId: msg.messageId, chatId: msg.chatId });
			} else {
				// 新窗口开启：注册 flush 定时器
				const chatId = msg.chatId;
				if (!this.timers.has(chatId)) {
					this.timers.set(
						chatId,
						setTimeout(() => {
							this.timers.delete(chatId);
							this.flushBatch(chatId);
						}, this.deps.config.batch.textWindowMs + 50),
					);
				}
			}
			this.pendingCarrier.set(msg.chatId, msg);
			return;
		}

		await this.dispatchMsg(msg);
	}

	/** batcher 窗口到期：合并 parts 后 dispatch。 */
	flushBatch(chatId: string): void {
		const win = this.batcher.flush(chatId);
		if (!win) return;
		const carrier = this.pendingCarrier.get(chatId);
		this.pendingCarrier.delete(chatId);
		if (!carrier) return;
		const merged: FeishuInboundMessage = {
			...carrier,
			text: win.parts.join("\n"),
			ts: Date.now(),
		};
		void this.dispatchMsg(merged);
	}

	private pendingCarrier = new Map<string, FeishuInboundMessage>();

	private async dispatchMsg(msg: FeishuInboundMessage): Promise<void> {
		// 3. 准入
		const mentioned = msg.mentions.some((m) => m.isSelf) || msg.text.includes("@_all");
		const replyToBot = Boolean(msg.replyToMessageId && this.deps.lastSent.has(msg.replyToMessageId));
		const verdict = admit(this.deps.config, msg, mentioned, replyToBot, this.deps.lastSent);
		if (!verdict.ok) {
			this.stats.dropped += 1;
			this.deps.log?.("debug", "feishu.pipeline.drop", { messageId: msg.messageId, reason: verdict.reason });
			return;
		}

		// 4. 回复解析（B1：拉取被回复原文）
		let replyToText = msg.replyToText;
		if (msg.replyToMessageId && !replyToText) {
			const cached = this.quoteCache.get(msg.replyToMessageId);
			if (cached && Date.now() - cached.at < this.deps.config.quotedFetchTtlMs) {
				replyToText = cached.text;
			} else {
				const text = await this.deps.transport.getMessageText(msg.replyToMessageId);
				replyToText = text ?? "[无法获取被回复消息原文]";
				if (text) this.quoteCache.set(msg.replyToMessageId, { text, at: Date.now() });
			}
		}

		// 5. dispatch
		this.stats.dispatched += 1;
		await this.deps.onDispatch({ ...msg, replyToText });
	}

	stop(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
	}
}
