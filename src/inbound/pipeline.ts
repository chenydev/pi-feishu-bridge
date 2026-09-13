/**
 * 入站流水线（pipeline）：dedup → batch → admit → reply-resolve → dispatch。
 * 设计依据：docs/DESIGN.md §3.3。唯一丢弃点在 admit 与 dedup。
 */
import type { BridgeConfig, FeishuInboundMessage } from "../types.js";
import { LastSentCache, admit } from "./admit.js";
import { DedupCache, TextBatcher, batchCompatible, type BatchWindow } from "./pipeline-utils.js";
import type { FeishuTransport } from "./transport.js";
import { buildConversationKey } from "../session/conversation-key.js";
import { DedupeStore } from "./dedupe-store.js";

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
	/** 返回 true 表示命令已消费，不再进入 batch/Agent。 */
	onCommand?: (msg: FeishuInboundMessage) => Promise<boolean>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	dedupeStore?: DedupeStore;
}

export class InboundPipeline {
	private dedup: DedupeStore;
	private batcher: TextBatcher;
	private stats: PipelineStats = { total: 0, duplicate: 0, batched: 0, dropped: 0, dispatched: 0 };
	private quoteCache = new Map<string, { text: string; at: number }>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private inFlight = new Set<Promise<void>>();
	private stopping = false;

	constructor(private deps: PipelineDeps) {
		this.dedup = deps.dedupeStore ?? new DedupCache(deps.config.dedupCacheSize);
		this.batcher = new TextBatcher(deps.config.batch.textWindowMs);
	}

	getStats(): PipelineStats {
		return { ...this.stats };
	}

	/** 处理单条入站消息（transport 回调）。 */
	handle(msg: FeishuInboundMessage): Promise<void> {
		if (this.stopping) {
			this.stats.dropped += 1;
			this.deps.log?.("warn", "feishu.pipeline.drop_after_stop", { messageId: msg.messageId });
			return Promise.resolve();
		}
		const task = this.handleOne(msg);
		this.inFlight.add(task);
		return task.finally(() => this.inFlight.delete(task));
	}

	private async handleOne(msg: FeishuInboundMessage): Promise<void> {
		this.stats.total += 1;
		this.stats.lastMessageAt = Date.now();

		// 1. 去重
		if (!this.dedup.check(msg.messageId)) {
			this.stats.duplicate += 1;
			this.deps.log?.("debug", "feishu.pipeline.drop_duplicate", { messageId: msg.messageId });
			return;
		}

		// 2. 每条消息先独立通过准入与引用解析，再考虑合并，避免未授权消息
		// 借已 @ 消息进入同一个 turn。
		let prepared: FeishuInboundMessage | undefined;
		try {
			prepared = await this.prepareMsg(msg);
			if (!prepared) return;
		} catch (error) {
			this.dedup.forget(msg.messageId);
			throw error;
		}

		const key = buildConversationKey(prepared, this.deps.config);
		if (this.deps.onCommand) {
			if (this.batcher.peek(key)) await this.flushBatch(key);
			try {
				if (await this.deps.onCommand(prepared)) return;
			} catch (error) {
				this.dedup.forget(prepared.messageId);
				throw error;
			}
		}
		const batchable = this.deps.config.batch.enabled
			&& prepared.chatType !== "p2p"
			&& prepared.msgType === "text"
			&& Boolean(prepared.text);
		if (!batchable) {
			// 同一会话已有文本窗口时先发送旧文本，保持到达顺序。
			if (this.batcher.peek(key)) await this.flushBatch(key);
			await this.dispatchPrepared(prepared);
			return;
		}

		const maxMessages = Math.max(1, this.deps.config.batch.maxMessages ?? 8);
		const maxChars = Math.max(1, this.deps.config.batch.maxChars ?? 12_000);
		let existing = this.batcher.peek(key);
		if (existing && !batchCompatible(existing.carrier, prepared)) {
			await this.flushBatch(key);
			existing = undefined;
		}
		if (existing) {
			const nextChars = existing.parts.reduce((n, part) => n + part.length, 0) + prepared.text.length + 1;
			if (existing.parts.length >= maxMessages || nextChars > maxChars) {
				await this.flushBatch(key);
				existing = undefined;
			}
		}
		if (prepared.text.length > maxChars) {
			await this.dispatchPrepared(prepared);
			return;
		}

		const joined = this.batcher.offer(key, prepared);
		if (joined) {
			this.stats.batched += 1;
			this.deps.log?.("debug", "feishu.pipeline.batched", { messageId: prepared.messageId, conversationKey: key });
		}
		const window = this.batcher.peek(key);
		if (window && (window.parts.length >= maxMessages || this.windowChars(window) >= maxChars)) {
			await this.flushBatch(key);
			return;
		}
		this.scheduleFlush(key);
	}

	/** batcher 窗口到期：合并 parts 后 dispatch。 */
	async flushBatch(key: string): Promise<void> {
		this.clearFlushTimer(key);
		const win = this.batcher.flush(key);
		if (!win) return;
		const merged: FeishuInboundMessage = {
			...win.carrier,
			text: win.parts.join("\n"),
			sourceMessageIds: win.messageIds,
			ts: Date.now(),
		};
		await this.dispatchPrepared(merged);
	}

	private async prepareMsg(msg: FeishuInboundMessage): Promise<FeishuInboundMessage | undefined> {
		// 3. 准入
		const mentioned = msg.mentions.some((m) => m.isSelf) || msg.text.includes("@_all") || msg.text.includes("@all");
		const replyToBot = Boolean(msg.replyToMessageId && this.deps.lastSent.has(msg.replyToMessageId));
		const verdict = admit(this.deps.config, msg, mentioned, replyToBot, this.deps.lastSent);
		if (!verdict.ok) {
			this.stats.dropped += 1;
			this.deps.log?.("debug", "feishu.pipeline.drop", { messageId: msg.messageId, reason: verdict.reason });
			return undefined;
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

		return { ...msg, replyToText };
	}

	private async dispatchPrepared(msg: FeishuInboundMessage): Promise<void> {
		// 5. dispatch
		this.stats.dispatched += 1;
		try {
			await this.deps.onDispatch(msg);
		} catch (error) {
			for (const messageId of msg.sourceMessageIds ?? [msg.messageId]) this.dedup.forget(messageId);
			throw error;
		}
	}

	private windowChars(win: BatchWindow): number {
		return win.parts.reduce((n, part) => n + part.length, 0) + Math.max(0, win.parts.length - 1);
	}

	private scheduleFlush(key: string): void {
		this.clearFlushTimer(key);
		const timer = setTimeout(() => {
			this.timers.delete(key);
			void this.flushBatch(key).catch((err) => {
				this.deps.log?.("error", "feishu.pipeline.flush_failed", {
					conversationKey: key,
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, this.deps.config.batch.textWindowMs + 50);
		timer.unref?.();
		this.timers.set(key, timer);
	}

	private clearFlushTimer(key: string): void {
		const timer = this.timers.get(key);
		if (timer) clearTimeout(timer);
		this.timers.delete(key);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const inFlight = await Promise.allSettled([...this.inFlight]);
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		const pending = this.batcher.flushAll();
		const results = await Promise.allSettled(pending.map((win) => this.dispatchPrepared({
			...win.carrier, text: win.parts.join("\n"), sourceMessageIds: win.messageIds, ts: Date.now(),
		})));
		const errors = [...inFlight, ...results]
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "failed to flush inbound batches");
	}
}
