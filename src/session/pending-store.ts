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
	/** 最近一次状态变更时间（合并/刷新时更新）。 */
	updatedAt?: number;
	/** 本条记录覆盖的原始 sourceMessageId（batch 合并后为整个窗口）。 */
	sourceMessageIds?: string[];
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
			updatedAt: now,
			sourceMessageIds: [message.messageId],
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

	/**
	 * 是否仍有未完成的该消息记录。
	 * 除了直接命中记录，还要覆盖“已被 batch 合入主记录”的成员 id —— 否则重投
	 * 该成员会被误判为 orphan 而重新准入，造成重复执行。
	 */
	has(id: string): boolean {
		if (this.records.has(id)) return true;
		for (const record of this.records.values()) {
			if (record.sourceMessageIds?.includes(id)) return true;
		}
		return false;
	}

	/**
	 * batch 合并：把同一窗口内的成员记录并入主记录，并写入合并后的消息。
	 * 主记录不存在时不做任何事（可能已被 ack）；成员记录一律删除，避免恢复时重复重放。
	 */
	mergeInto(
		primaryId: string,
		memberIds: string[],
		merged: Omit<FeishuInboundMessage, "raw">,
		sourceMessageIds: string[],
	): void {
		const primary = this.records.get(primaryId);
		if (!primary) return;
		for (const id of memberIds) {
			if (id !== primaryId) this.records.delete(id);
		}
		primary.message = { ...merged, raw: undefined } as Omit<FeishuInboundMessage, "raw">;
		primary.sourceMessageIds = [...sourceMessageIds];
		primary.updatedAt = this.now();
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
