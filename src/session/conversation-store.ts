/**
 * 会话指针持久化（P0-05）：conversationKey → 当前活动会话文件与世代。
 *
 * 修复的缺陷（R4）：`/new` 只在内存 Map（nextSessionSuffix）里记后缀，
 * 进程重启后丢失 —— 同一会话又回到最初的确定性文件，把应该翻篇的旧上下文带回来。
 *
 * 约定：
 * - 每个会话最多一条当前指针，全量快照 + tmp+rename 原子落盘（0600）；
 * - `generation` 每次 /new 递增，用于隔离旧队列/审批/outbox；
 * - 索引缺失 → 调用方用确定性路径并写入 generation=1；
 * - 索引损坏或写入失败 → 由调用方显式报错，**不得静默回退到旧会话**。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ConversationHistoryEntry {
	/** 已退役的会话文件（绝对路径）。 */
	sessionFile: string;
	generation: number;
	retiredAt: number;
}

export interface ConversationPointer {
	conversationKey: string;
	/** 当前活动会话文件（绝对路径）。 */
	sessionFile: string;
	/** 会话世代：每次 /new 递增。 */
	generation: number;
	updatedAt: number;
	/** P1-04/P1-05：历史会话（最近在前，最多保留 MAX_HISTORY 条）。 */
	history?: ConversationHistoryEntry[];
	/** P2-02：该会话的工作区别名（未设置 = 默认工作区）。 */
	workspace?: string;
}

/** 每个会话保留的历史条数上限（避免索引无界增长）。 */
const MAX_HISTORY = 20;

export class ConversationStore {
	private records = new Map<string, ConversationPointer>();
	private readonly now: () => number;

	constructor(private file: string, options: { now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
		this.load();
	}

	get(conversationKey: string): ConversationPointer | undefined {
		return this.records.get(conversationKey);
	}

	/**
	 * 原子写入当前指针；失败抛错（调用方必须在切换运行态之前完成写入）。
	 * P1-04：切换时把旧指针推入 history（最近的在前，最多 MAX_HISTORY 条）。
	 */
	set(pointer: Omit<ConversationPointer, "updatedAt">): ConversationPointer {
		const previous = this.records.get(pointer.conversationKey);
		const history = previous
			? [{ sessionFile: previous.sessionFile, generation: previous.generation, retiredAt: this.now() }, ...(previous.history ?? [])]
				.filter((entry, index, all) => all.findIndex((item) => item.sessionFile === entry.sessionFile) === index)
				.slice(0, MAX_HISTORY)
			: pointer.history ?? [];
		const record: ConversationPointer = { ...pointer, history, updatedAt: this.now() };
		this.records.set(pointer.conversationKey, record);
		try {
			this.persist();
		} catch (error) {
			if (previous) this.records.set(pointer.conversationKey, previous);
			else this.records.delete(pointer.conversationKey);
			throw error;
		}
		return record;
	}

	list(): ConversationPointer[] {
		return [...this.records.values()];
	}

	depth(): number {
		return this.records.size;
	}

	private load(): void {
		if (!this.file || !existsSync(this.file)) return;
		for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
			try {
				const record = JSON.parse(line) as ConversationPointer;
				if (
					record?.conversationKey
					&& typeof record.sessionFile === "string"
					&& record.sessionFile.length > 0
					&& Number.isFinite(record.generation)
				) {
					this.records.set(record.conversationKey, record);
				}
			} catch { /* 跳过损坏行：不得因此回退到其他会话 */ }
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const output = [...this.records.values()].map((record) => JSON.stringify(record)).join("\n");
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, output ? `${output}\n` : "", { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.file);
	}
}
