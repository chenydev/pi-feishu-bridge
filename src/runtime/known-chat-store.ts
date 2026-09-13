import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 重启后仍可用于短时断线补收的已知 chat 集合。 */
export class KnownChatStore {
	private chats = new Set<string>();

	constructor(private file: string, private capacity = 5_000) {
		if (!existsSync(file)) return;
		try {
			const values = JSON.parse(readFileSync(file, "utf8"));
			if (Array.isArray(values)) for (const value of values) if (typeof value === "string" && value) this.chats.add(value);
		} catch { /* 损坏文件降级为空，下一次 add 会重写 */ }
	}

	add(chatId: string): void {
		if (!chatId) return;
		this.chats.delete(chatId);
		this.chats.add(chatId);
		while (this.chats.size > this.capacity) this.chats.delete(this.chats.values().next().value as string);
		this.persist();
	}

	values(): string[] { return [...this.chats]; }

	private persist(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.values()), { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.file);
	}
}
