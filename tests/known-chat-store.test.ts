import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnownChatStore } from "../src/runtime/known-chat-store.js";

test("KnownChatStore：跨重启保留、LRU 容量、0600 且损坏文件可恢复", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-known-chat-"));
	const file = join(dir, "known.json");
	try {
		const first = new KnownChatStore(file, 2);
		first.add("a"); first.add("b"); first.add("a"); first.add("c");
		assert.deepEqual(new KnownChatStore(file, 2).values(), ["a", "c"]);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		writeFileSync(file, "broken");
		const recovered = new KnownChatStore(file, 2);
		recovered.add("fresh");
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["fresh"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
