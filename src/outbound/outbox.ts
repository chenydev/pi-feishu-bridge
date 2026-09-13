/**
 * 最终消息 durable outbox：先原子落盘，再按 conversation lane FIFO 投递。
 * sending 状态在重启时恢复为 pending；稳定 API UUID 使发送中崩溃可安全重试。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { SendOptions, SendResult } from "../types.js";
import { feishuMessageTypeForMedia, isPreparedMedia, type PreparedDelivery, type PreparedMediaSend, type PreparedSend } from "./sender.js";
import type { ValidatedArtifact } from "./artifact.js";

export type OutboxKind = "final" | "error" | "notify" | "media";
export type OutboxStatus = "pending" | "sending" | "sent" | "failed";
export type OutboxErrorClass = "retryable" | "fatal";

export interface OutboxEntry {
	id: string;
	dedupeKey: string;
	laneKey: string;
	kind: OutboxKind;
	route: { chatId: string; replyTo?: string; threadId?: string };
	payload: { msgType: "text" | "post" | "image" | "file" | "media" | "audio"; content: string };
	request: PreparedDelivery;
	status: OutboxStatus;
	attempts: number;
	nextRetryAt: number;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
	errorClass?: OutboxErrorClass;
}

export interface OutboxStats {
	pending: number;
	sending: number;
	sent: number;
	failed: number;
	lanes: number;
	oldestAgeMs: number;
}

export interface EnqueueOptions {
	dedupeKey: string;
	laneKey: string;
	kind: OutboxKind;
}

export interface OutboxDeps {
	file: string;
	prepare: (chatId: string, content: string, opts: SendOptions) => PreparedSend[];
	prepareMedia?: (chatId: string, artifact: ValidatedArtifact, opts: SendOptions) => PreparedMediaSend;
	send: (request: PreparedDelivery, checkpoint: (patch: Partial<PreparedMediaSend>) => void) => Promise<SendResult>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	maxAttempts?: number;
	backoffMs?: number;
	maxActiveEntries?: number;
	maxTerminalEntries?: number;
	concurrency?: number;
	maxEnvelopeBytes?: number;
	maxFileBytes?: number;
	maxTerminalAgeMs?: number;
	now?: () => number;
	random?: () => number;
	onChange?: () => void;
}

export class Outbox {
	private entries = new Map<string, OutboxEntry>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | undefined;
	private started = false;
	private readonly maxAttempts: number;
	private readonly backoffMs: number;
	private readonly maxActiveEntries: number;
	private readonly maxTerminalEntries: number;
	private readonly concurrency: number;
	private readonly maxEnvelopeBytes: number;
	private readonly maxFileBytes: number;
	private readonly maxTerminalAgeMs: number;
	private readonly now: () => number;
	private readonly random: () => number;

	constructor(private deps: OutboxDeps) {
		this.maxAttempts = deps.maxAttempts ?? 8;
		this.backoffMs = deps.backoffMs ?? 1_000;
		this.maxActiveEntries = deps.maxActiveEntries ?? 1_000;
		this.maxTerminalEntries = deps.maxTerminalEntries ?? 500;
		this.concurrency = Math.max(1, deps.concurrency ?? 4);
		this.maxEnvelopeBytes = deps.maxEnvelopeBytes ?? 256 * 1024;
		this.maxFileBytes = deps.maxFileBytes ?? 64 * 1024 * 1024;
		this.maxTerminalAgeMs = deps.maxTerminalAgeMs ?? 7 * 24 * 60 * 60_000;
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.load();
	}

	/** transport ready 后显式启动；构造阶段绝不发网络请求。 */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.schedule(0);
	}

	/** 先将所有 chunk 原子写入，再允许调用方确认本轮已可靠接管。 */
	enqueue(chatId: string, content: string, opts: SendOptions, meta: EnqueueOptions): string[] {
		const prepared = this.deps.prepare(chatId, content, opts);
		if (prepared.length === 0) return [];
		const existing = [...this.entries.values()]
			.filter((entry) => entry.dedupeKey === meta.dedupeKey)
			.sort((a, b) => a.createdAt - b.createdAt);
		if (existing.some((entry) => entry.status === "failed")) throw new Error("outbox dedupe key is terminally failed");
		if (existing.length > 0) return existing.map((entry) => entry.id);

		const active = [...this.entries.values()].filter((entry) => entry.status === "pending" || entry.status === "sending").length;
		if (active + prepared.length > this.maxActiveEntries) throw new Error("outbox capacity exceeded");
		const now = this.now();
		for (const request of prepared) {
			if (Buffer.byteLength(JSON.stringify(request), "utf8") > this.maxEnvelopeBytes) throw new Error("outbox envelope too large");
		}
		const added = prepared.map((request, index): OutboxEntry => ({
			id: randomUUID(),
			dedupeKey: meta.dedupeKey,
			laneKey: meta.laneKey,
			kind: meta.kind,
			route: { chatId: request.chatId, replyTo: request.opts.replyTo, threadId: request.opts.threadId },
			payload: { msgType: request.msgType, content: request.payload },
			request,
			status: "pending",
			attempts: 0,
			nextRetryAt: now,
			createdAt: now + index / 1_000,
			updatedAt: now,
		}));
		for (const entry of added) this.entries.set(entry.id, entry);
		try {
			this.compactTerminalEntries();
			this.persist();
		} catch (error) {
			for (const entry of added) this.entries.delete(entry.id);
			throw error;
		}
		if (this.started) this.schedule(0);
		this.deps.onChange?.();
		return added.map((entry) => entry.id);
	}

	enqueueMedia(chatId: string, artifact: ValidatedArtifact, opts: SendOptions, meta: EnqueueOptions): string {
		if (!this.deps.prepareMedia) throw new Error("media outbox unavailable");
		const existing = [...this.entries.values()].find((entry) => entry.dedupeKey === meta.dedupeKey);
		if (existing?.status === "failed") throw new Error("outbox dedupe key is terminally failed");
		if (existing) return existing.id;
		const active = [...this.entries.values()].filter((entry) => entry.status === "pending" || entry.status === "sending").length;
		if (active >= this.maxActiveEntries) throw new Error("outbox capacity exceeded");
		const request = this.deps.prepareMedia(chatId, artifact, opts);
		if (Buffer.byteLength(JSON.stringify(request), "utf8") > this.maxEnvelopeBytes) throw new Error("outbox envelope too large");
		const now = this.now();
		const entry: OutboxEntry = {
			id: randomUUID(), dedupeKey: meta.dedupeKey, laneKey: meta.laneKey, kind: "media",
			route: { chatId, replyTo: opts.replyTo, threadId: opts.threadId },
			payload: { msgType: feishuMessageTypeForMedia(artifact.mediaType), content: artifact.localPath }, request,
			status: "pending", attempts: 0, nextRetryAt: now, createdAt: now, updatedAt: now,
		};
		this.entries.set(entry.id, entry);
		try { this.compactTerminalEntries(); this.persist(); } catch (error) { this.entries.delete(entry.id); throw error; }
		if (this.started) this.schedule(0);
		this.deps.onChange?.();
		return entry.id;
	}

	depth(): number {
		const current = this.stats();
		return current.pending + current.sending;
	}

	hasDedupeKey(dedupeKey: string): boolean {
		return [...this.entries.values()].some((entry) => entry.dedupeKey === dedupeKey && entry.status !== "failed");
	}

	stats(): OutboxStats {
		const values = [...this.entries.values()];
		const active = values.filter((entry) => entry.status === "pending" || entry.status === "sending");
		const oldest = active.reduce((min, entry) => Math.min(min, entry.createdAt), Number.POSITIVE_INFINITY);
		return {
			pending: values.filter((entry) => entry.status === "pending").length,
			sending: values.filter((entry) => entry.status === "sending").length,
			sent: values.filter((entry) => entry.status === "sent").length,
			failed: values.filter((entry) => entry.status === "failed").length,
			lanes: new Set(active.map((entry) => entry.laneKey)).size,
			oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, this.now() - oldest) : 0,
		};
	}

	/** 测试和调度器共用的单次到期处理。 */
	async drainDue(): Promise<void> {
		if (this.running) return this.running;
		this.running = this.doDrainDue();
		try {
			await this.running;
		} finally {
			this.running = undefined;
			if (this.started) this.schedule();
		}
	}

	private async doDrainDue(): Promise<void> {
		const now = this.now();
		const active = [...this.entries.values()]
			.filter((entry) => entry.status === "pending" || entry.status === "sending")
			.sort((a, b) => a.createdAt - b.createdAt);
		const laneHeads = new Map<string, OutboxEntry>();
		for (const entry of active) {
			if (!laneHeads.has(entry.laneKey)) laneHeads.set(entry.laneKey, entry);
		}
		const due = [...laneHeads.values()]
			.filter((entry) => entry.nextRetryAt <= now)
			.slice(0, this.concurrency);
		if (due.length === 0) return;

		for (const entry of due) {
			entry.status = "sending";
			entry.attempts += 1;
			entry.updatedAt = now;
		}
		this.persist();

		await Promise.all(due.map(async (entry) => {
			let result: SendResult;
			try {
				result = await this.deps.send(entry.request, (patch) => {
					Object.assign(entry.request, patch);
					entry.updatedAt = this.now();
					this.persist();
					this.deps.onChange?.();
				});
			} catch (error) {
				result = { success: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
			}
			entry.updatedAt = this.now();
			if (result.success) {
				entry.status = "sent";
				entry.lastError = undefined;
				entry.errorClass = undefined;
				this.deps.log?.("info", "feishu.outbox.delivered", { envelopeId: entry.id, conversationKey: entry.laneKey, attempts: entry.attempts });
				if (isPreparedMedia(entry.request) && entry.request.deleteAfterSend) {
					try { unlinkSync(entry.request.localPath); } catch { /* 已删除或只读，不影响投递结果 */ }
				}
				return;
			}
			entry.lastError = result.error ?? "unknown delivery error";
			entry.errorClass = result.retryable === false ? "fatal" : "retryable";
			if (entry.errorClass === "fatal" || entry.attempts >= this.maxAttempts) {
				entry.status = "failed";
				this.deps.log?.("error", "feishu.outbox.failed", { envelopeId: entry.id, conversationKey: entry.laneKey, attempts: entry.attempts, errorClass: entry.errorClass, lastError: entry.lastError });
				return;
			}
			entry.status = "pending";
			const exponential = this.backoffMs * 2 ** (entry.attempts - 1);
			const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
			entry.nextRetryAt = this.now() + Math.max(jittered, result.retryAfterMs ?? 0);
		}));
		this.compactTerminalEntries();
		this.persist();
		this.deps.onChange?.();
	}

	private schedule(delay?: number): void {
		if (!this.started || this.timer || this.running) return;
		const pending = [...this.entries.values()].filter((entry) => entry.status === "pending");
		if (pending.length === 0) return;
		const nextAt = Math.min(...pending.map((entry) => entry.nextRetryAt));
		const wait = delay ?? Math.max(0, Math.min(60_000, nextAt - this.now()));
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.drainDue();
		}, wait);
		this.timer.unref?.();
	}

	private load(): void {
		if (!existsSync(this.deps.file)) return;
		const lines = readFileSync(this.deps.file, "utf8").split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as OutboxEntry;
				if (!entry?.id || !entry.request?.uuid || !entry.laneKey) continue;
				if (entry.status === "sending") entry.status = "pending";
				this.entries.set(entry.id, entry);
			} catch {
				this.deps.log?.("warn", "feishu.outbox.corrupt_line_skipped");
			}
		}
	}

	private compactTerminalEntries(): void {
		const cutoff = this.now() - this.maxTerminalAgeMs;
		for (const entry of [...this.entries.values()]) {
			if ((entry.status === "sent" || entry.status === "failed") && entry.updatedAt < cutoff) this.deleteEntry(entry);
		}
		const terminal = [...this.entries.values()]
			.filter((entry) => entry.status === "sent" || entry.status === "failed")
			.sort((a, b) => b.updatedAt - a.updatedAt);
		for (const entry of terminal.slice(this.maxTerminalEntries)) this.deleteEntry(entry);
	}

	private deleteEntry(entry: OutboxEntry): void {
		this.entries.delete(entry.id);
		if (isPreparedMedia(entry.request) && entry.request.deleteAfterSend) {
			try { unlinkSync(entry.request.localPath); } catch { /* best effort */ }
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.deps.file), { recursive: true });
		const output = [...this.entries.values()].map((entry) => JSON.stringify(entry)).join("\n");
		if (Buffer.byteLength(output, "utf8") > this.maxFileBytes) throw new Error("outbox file capacity exceeded");
		const tmp = `${this.deps.file}.tmp`;
		writeFileSync(tmp, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.deps.file);
	}

	async stop(): Promise<void> {
		this.started = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.running;
	}
}
