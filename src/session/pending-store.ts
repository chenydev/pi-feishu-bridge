import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { FeishuInboundMessage } from "../types.js";

export interface PendingRecord {
	id: string;
	conversationKey: string;
	message: Omit<FeishuInboundMessage, "raw">;
	state: "claimed";
	owner: string;
	claimedAt: number;
	leaseUntil: number;
	attempts: number;
	/** auto 允许重放纯推理 turn；manual 表示已越过工具边界，重放可能重复副作用。 */
	replayPolicy?: "auto" | "manual";
}

export class PendingStore {
	private records = new Map<string, PendingRecord>();
	private readonly owner = `${process.pid}:${randomUUID()}`;
	private readonly now: () => number;
	private readonly leaseMs: number;

	constructor(private file: string, options: { now?: () => number; leaseMs?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.leaseMs = options.leaseMs ?? 5 * 60_000;
		this.load();
	}

	claim(message: FeishuInboundMessage, conversationKey: string): string {
		const existing = this.records.get(message.messageId);
		if (existing) return existing.id;
		const now = this.now();
		const record: PendingRecord = {
			id: message.messageId,
			conversationKey,
			message: { ...message, raw: undefined } as Omit<FeishuInboundMessage, "raw">,
			state: "claimed",
			owner: this.owner,
			claimedAt: now,
			leaseUntil: now + this.leaseMs,
			attempts: 1,
			replayPolicy: "auto",
		};
		this.records.set(record.id, record);
		try {
			this.persist();
		} catch (error) {
			this.records.delete(record.id);
			throw error;
		}
		return record.id;
	}

	/** 新进程可立即接管旧 owner；同进程仅接管 lease 已过期项。 */
	recoverable(): PendingRecord[] {
		const now = this.now();
		const result = [...this.records.values()].filter((record) => record.owner !== this.owner || record.leaseUntil <= now);
		for (const record of result) {
			record.owner = this.owner;
			record.claimedAt = now;
			record.leaseUntil = now + this.leaseMs;
			record.attempts += 1;
		}
		if (result.length > 0) this.persist();
		return result.map((record) => structuredClone(record));
	}

	ack(id: string): void {
		if (!this.records.delete(id)) return;
		this.persist();
	}

	markManual(id: string): void {
		const record = this.records.get(id);
		if (!record || record.replayPolicy === "manual") return;
		record.replayPolicy = "manual";
		this.persist();
	}

	depth(): number {
		return this.records.size;
	}

	private load(): void {
		if (!this.file || !existsSync(this.file)) return;
		for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
			try {
				const record = JSON.parse(line) as PendingRecord;
				if (record?.id && record.message?.messageId && record.conversationKey) this.records.set(record.id, record);
			} catch { /* skip corrupt line */ }
		}
	}

	private persist(): void {
		if (!this.file) return;
		mkdirSync(dirname(this.file), { recursive: true });
		const output = [...this.records.values()].map((record) => JSON.stringify(record)).join("\n");
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.file);
	}
}
