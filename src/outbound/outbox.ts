/**
 * outbox：发送失败重试（指数退避 + 持久化 jsonl）。
 * 设计依据：docs/DESIGN.md §3.6（复刻 pi-feishu-link outbox 错误分类）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SendOptions, SendResult } from "../types.js";

export interface OutboxEntry {
	id: string;
	chatId: string;
	content: string;
	opts: SendOptions;
	attempts: number;
	nextAt: number;
	createdAt: number;
	lastError?: string;
}

export interface OutboxDeps {
	file: string;
	/** 实际发送器；返回 success=false 视为可重试失败。 */
	send: (chatId: string, content: string, opts: SendOptions) => Promise<SendResult>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	maxAttempts?: number;
	backoffMs?: number; // 基数
	now?: () => number;
}

export class Outbox {
	private entries = new Map<string, OutboxEntry>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly maxAttempts: number;
	private readonly backoffMs: number;
	private readonly now: () => number;

	constructor(private deps: OutboxDeps) {
		this.maxAttempts = deps.maxAttempts ?? 5;
		this.backoffMs = deps.backoffMs ?? 10_000;
		this.now = deps.now ?? Date.now;
		this.load();
	}

	/** 入队一条失败消息。 */
	push(chatId: string, content: string, opts: SendOptions, error: string): void {
		const id = `${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.entries.set(id, { id, chatId, content, opts, attempts: 0, nextAt: this.now(), createdAt: this.now(), lastError: error });
		this.persist();
		this.schedule();
	}

	depth(): number {
		return this.entries.size;
	}

	/** 处理到期的条目（backoff 到达）。 */
	private async pump(): Promise<void> {
		const due = [...this.entries.values()].filter((e) => e.nextAt <= this.now());
		for (const entry of due) {
			if (!this.entries.has(entry.id)) continue;
			entry.attempts += 1;
			try {
				const res = await this.deps.send(entry.chatId, entry.content, entry.opts);
				if (res.success) {
					this.entries.delete(entry.id);
					this.deps.log?.("info", "feishu.outbox.delivered", { id: entry.id, attempts: entry.attempts });
					continue;
				}
				entry.lastError = res.error;
			} catch (err) {
				entry.lastError = err instanceof Error ? err.message : String(err);
			}
			if (entry.attempts >= this.maxAttempts) {
				this.entries.delete(entry.id);
				this.deps.log?.("error", "feishu.outbox.dropped_after_retries", { id: entry.id, attempts: entry.attempts, lastError: entry.lastError });
			} else {
				entry.nextAt = this.now() + this.backoffMs * 2 ** (entry.attempts - 1);
			}
		}
		this.persist();
		this.schedule();
	}

	private schedule(): void {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.pump();
		}, 1_000);
	}

	// ------------------------------------------------------------ 持久化 ----

	private load(): void {
		try {
			if (!existsSync(this.deps.file)) return;
			const lines = readFileSync(this.deps.file, "utf8").split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const e = JSON.parse(line) as OutboxEntry;
					if (e && e.id && typeof e.chatId === "string") this.entries.set(e.id, e);
				} catch {
					/* 跳过损坏行 */
				}
			}
		} catch {
			/* 无权限等：内存模式 */
		}
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.deps.file), { recursive: true });
			// 全量重写（条目少，简单可靠）
			const out = [...this.entries.values()].map((e) => JSON.stringify(e)).join("\n") + "\n";
			const tmp = this.deps.file + ".tmp";
			writeFileSync(tmp, out, "utf8");
			renameSync(tmp, this.deps.file);
		} catch {
			/* 持久化失败不阻塞 */
		}
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
