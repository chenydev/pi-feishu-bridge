import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface DedupeRecord {
	messageId: string;
	seenAt: number;
}

export interface DedupeStoreOptions {
	capacity: number;
	ttlMs: number;
	file?: string;
	now?: () => number;
}

/** 带 TTL、容量上限和原子快照的入站 message_id 去重。 */
export class DedupeStore {
	private seen = new Map<string, number>();
	private readonly now: () => number;

	constructor(private options: DedupeStoreOptions) {
		this.now = options.now ?? Date.now;
		this.load();
	}

	/** 返回 true 表示首次见到；成功返回前已持久化。 */
	check(messageId: string): boolean {
		const now = this.now();
		this.prune(now);
		const seenAt = this.seen.get(messageId);
		if (seenAt !== undefined && now - seenAt <= this.options.ttlMs) return false;
		this.seen.set(messageId, now);
		this.prune(now);
		this.persist();
		return true;
	}

	/** 下游接管失败时撤销 reservation，使平台重投可再次处理。 */
	forget(messageId: string): void {
		if (!this.seen.delete(messageId)) return;
		this.persist();
	}

	private prune(now: number): void {
		for (const [messageId, seenAt] of this.seen) {
			if (now - seenAt > this.options.ttlMs) this.seen.delete(messageId);
		}
		const overflow = this.seen.size - Math.max(1, this.options.capacity);
		if (overflow <= 0) return;
		const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, overflow);
		for (const [messageId] of oldest) this.seen.delete(messageId);
	}

	private load(): void {
		if (!this.options.file || !existsSync(this.options.file)) return;
		try {
			for (const line of readFileSync(this.options.file, "utf8").split("\n").filter(Boolean)) {
				try {
					const record = JSON.parse(line) as DedupeRecord;
					if (record.messageId && Number.isFinite(record.seenAt)) this.seen.set(record.messageId, record.seenAt);
				} catch { /* skip corrupt line */ }
			}
			this.prune(this.now());
		} catch { /* unreadable snapshot starts empty */ }
	}

	private persist(): void {
		if (!this.options.file) return;
		mkdirSync(dirname(this.options.file), { recursive: true });
		const output = [...this.seen].map(([messageId, seenAt]) => JSON.stringify({ messageId, seenAt })).join("\n");
		const tmp = `${this.options.file}.tmp`;
		writeFileSync(tmp, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.options.file);
	}
}
