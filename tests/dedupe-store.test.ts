import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DedupeStore } from "../src/inbound/dedupe-store.js";

test("DedupeStore：TTL、容量、forget", () => {
	let now = 1_000;
	const store = new DedupeStore({ capacity: 2, ttlMs: 100, now: () => now });
	assert.equal(store.check("m1"), true);
	assert.equal(store.check("m1"), false);
	now += 101;
	assert.equal(store.check("m1"), true);
	assert.equal(store.check("m2"), true);
	assert.equal(store.check("m3"), true);
	assert.equal(store.check("m1"), true, "最旧记录被容量淘汰");
	store.forget("m1");
	assert.equal(store.check("m1"), true);
});

test("DedupeStore：跨重启保留，损坏行不影响有效记录", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-dedupe-"));
	const file = join(dir, "dedupe.jsonl");
	try {
		const first = new DedupeStore({ file, capacity: 10, ttlMs: 1_000, now: () => 5_000 });
		assert.equal(first.check("m1"), true);
		writeFileSync(file, `{"messageId":"m1","seenAt":5000}\n{broken\n`, "utf8");
		const restarted = new DedupeStore({ file, capacity: 10, ttlMs: 1_000, now: () => 5_100 });
		assert.equal(restarted.check("m1"), false);
		assert.equal(restarted.check("m2"), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
