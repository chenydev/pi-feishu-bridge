import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Outbox } from "../src/outbound/outbox.js";
import type { PreparedSend } from "../src/outbound/sender.js";
import type { PreparedMediaSend } from "../src/outbound/sender.js";
import type { SendResult } from "../src/types.js";

function prepared(chatId: string, content: string): PreparedSend[] {
	return [{
		chatId,
		msgType: "text",
		payload: JSON.stringify({ text: content }),
		plainTextPayload: JSON.stringify({ text: content }),
		opts: {},
		uuid: `uuid-${content}`,
		contentFallbackUuid: `content-${content}`,
		routeFallbackUuid: `route-${content}`,
	}];
}

function tempOutbox(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-outbox-"));
	return { dir, file: join(dir, "outbox.jsonl") };
}

test("outbox：enqueue 先持久化且 dedupeKey 幂等", () => {
	const { dir, file } = tempOutbox();
	try {
		const outbox = new Outbox({ file, prepare: prepared, send: async () => ({ success: true }) });
		const first = outbox.enqueue("oc_1", "answer", {}, { dedupeKey: "m1:final", laneKey: "lane-1", kind: "final" });
		const second = outbox.enqueue("oc_1", "answer", {}, { dedupeKey: "m1:final", laneKey: "lane-1", kind: "final" });
		assert.deepEqual(second, first);
		const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(rows.length, 1);
		assert.equal(rows[0].status, "pending");
		assert.equal(rows[0].request.uuid, "uuid-answer");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：retry 使用稳定 UUID，成功状态跨重启不重发", async () => {
	const { dir, file } = tempOutbox();
	let now = 1_000;
	const uuids: string[] = [];
	const results: SendResult[] = [
		{ success: false, retryable: true, error: "network" },
		{ success: true, messageId: "om_ok" },
	];
	try {
		const outbox = new Outbox({
			file,
			prepare: prepared,
			send: async (request) => { uuids.push(request.uuid); return results.shift() as SendResult; },
			now: () => now,
			backoffMs: 10,
			random: () => 0.5,
		});
		outbox.enqueue("oc_1", "stable", {}, { dedupeKey: "m2:final", laneKey: "lane-1", kind: "final" });
		await outbox.drainDue();
		assert.equal(outbox.stats().pending, 1);
		now += 10;
		await outbox.drainDue();
		assert.deepEqual(uuids, ["uuid-stable", "uuid-stable"]);
		assert.equal(outbox.stats().sent, 1);

		let restartedSends = 0;
		const restarted = new Outbox({
			file,
			prepare: prepared,
			send: async () => { restartedSends += 1; return { success: true }; },
			now: () => now,
		});
		await restarted.drainDue();
		assert.equal(restartedSends, 0);
		assert.equal(restarted.stats().sent, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：Retry-After 优先于抖动退避，容量超限明确失败", async () => {
	const { dir, file } = tempOutbox();
	let now = 10_000;
	let sends = 0;
	try {
		const outbox = new Outbox({
			file,
			prepare: prepared,
			send: async () => {
				sends += 1;
				return { success: false, retryable: true, retryAfterMs: 250, error: "429" };
			},
			now: () => now,
			backoffMs: 10,
			random: () => 0,
			maxActiveEntries: 1,
		});
		outbox.enqueue("oc_1", "limited", {}, { dedupeKey: "limited", laneKey: "lane", kind: "final" });
		assert.throws(() => outbox.enqueue("oc_1", "overflow", {}, { dedupeKey: "overflow", laneKey: "lane", kind: "final" }), /capacity exceeded/);
		await outbox.drainDue();
		now += 249;
		await outbox.drainDue();
		assert.equal(sends, 1);
		now += 1;
		await outbox.drainDue();
		assert.equal(sends, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：重启将 sending 恢复为 pending", async () => {
	const { dir, file } = tempOutbox();
	try {
		const first = new Outbox({ file, prepare: prepared, send: async () => ({ success: true }) });
		first.enqueue("oc_1", "recover", {}, { dedupeKey: "m3:final", laneKey: "lane-1", kind: "final" });
		const row = JSON.parse(readFileSync(file, "utf8"));
		row.status = "sending";
		writeFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
		let sends = 0;
		const restarted = new Outbox({
			file,
			prepare: prepared,
			send: async () => { sends += 1; return { success: true }; },
		});
		assert.equal(restarted.stats().pending, 1);
		await restarted.drainDue();
		assert.equal(sends, 1);
		assert.equal(restarted.stats().sent, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：fatal 直接终止；同 lane FIFO、不同 lane 并行", async () => {
	const { dir, file } = tempOutbox();
	const started: string[] = [];
	const resolvers = new Map<string, (result: SendResult) => void>();
	try {
		const outbox = new Outbox({
			file,
			prepare: prepared,
			send: async (request) => {
				if (!("payload" in request)) throw new Error("unexpected media request");
				const text = JSON.parse(request.payload).text as string;
				started.push(text);
				return new Promise((resolve) => resolvers.set(text, resolve));
			},
			concurrency: 4,
		});
		outbox.enqueue("oc_1", "a1", {}, { dedupeKey: "a1", laneKey: "a", kind: "final" });
		outbox.enqueue("oc_1", "a2", {}, { dedupeKey: "a2", laneKey: "a", kind: "final" });
		outbox.enqueue("oc_2", "b1", {}, { dedupeKey: "b1", laneKey: "b", kind: "final" });
		const firstDrain = outbox.drainDue();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(started, ["a1", "b1"]);
		resolvers.get("a1")?.({ success: false, retryable: false, error: "forbidden" });
		resolvers.get("b1")?.({ success: true });
		await firstDrain;
		assert.equal(outbox.stats().failed, 1);
		const secondDrain = outbox.drainDue();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(started, ["a1", "b1", "a2"]);
		resolvers.get("a2")?.({ success: true });
		await secondDrain;
		assert.equal(outbox.stats().pending, 0);
		assert.equal(outbox.stats().sent, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：terminal failed dedupe 不得伪装成已可靠接管", async () => {
	const { dir, file } = tempOutbox();
	try {
		const outbox = new Outbox({
			file, prepare: prepared,
			send: async () => ({ success: false, retryable: false, error: "forbidden" }),
		});
		outbox.enqueue("oc", "answer", {}, { dedupeKey: "failed-final", laneKey: "lane", kind: "final" });
		await outbox.drainDue();
		assert.equal(outbox.stats().failed, 1);
		assert.equal(outbox.hasDedupeKey("failed-final"), false);
		assert.throws(
			() => outbox.enqueue("oc", "answer", {}, { dedupeKey: "failed-final", laneKey: "lane", kind: "final" }),
			/terminally failed/,
		);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outbox：跳过损坏尾行并报告活动 lane/oldestAge", () => {
	const { dir, file } = tempOutbox();
	let now = 5_000;
	try {
		const first = new Outbox({ file, prepare: prepared, send: async () => ({ success: true }), now: () => now });
		first.enqueue("oc_1", "one", {}, { dedupeKey: "one", laneKey: "lane-1", kind: "notify" });
		writeFileSync(file, `${readFileSync(file, "utf8")}{broken\n`, "utf8");
		now += 25;
		const restarted = new Outbox({ file, prepare: prepared, send: async () => ({ success: true }), now: () => now });
		assert.deepEqual(restarted.stats(), { pending: 1, sending: 0, sent: 0, failed: 0, lanes: 1, oldestAgeMs: 25 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：媒体上传 key checkpoint 跨重启保留", async () => {
	const { dir, file } = tempOutbox();
	let now = 1_000;
	const media = (): PreparedMediaSend => ({
		type: "media", chatId: "oc_1", opts: {}, uuid: "media-uuid", routeFallbackUuid: "media-fallback",
		localPath: "/tmp/result.pdf", fileName: "result.pdf", mediaType: "file", byteLength: 1, sha256: "x",
	});
	try {
		const first = new Outbox({
			file, prepare: prepared, prepareMedia: media,
			send: async (_request, checkpoint) => { checkpoint({ uploadKey: "file_key_1" }); return { success: false, retryable: true, error: "network" }; },
			now: () => now, backoffMs: 10, random: () => 0.5,
		});
		first.enqueueMedia("oc_1", media(), {}, { dedupeKey: "tool:media", laneKey: "lane", kind: "media" });
		await first.drainDue();
		assert.equal(JSON.parse(readFileSync(file, "utf8")).request.uploadKey, "file_key_1");
		now += 10;
		let restoredKey: string | undefined;
		const restarted = new Outbox({
			file, prepare: prepared, prepareMedia: media,
			send: async (request) => { restoredKey = "uploadKey" in request ? request.uploadKey : undefined; return { success: true }; },
			now: () => now,
		});
		await restarted.drainDue();
		assert.equal(restoredKey, "file_key_1");
		assert.equal(restarted.stats().sent, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("outbox：真实子进程在发送前/服务端接收后 SIGKILL，重启沿用 UUID 并恢复", async () => {
	const fixture = fileURLToPath(new URL("./fixtures/outbox-crash-child.ts", import.meta.url));
	for (const mode of ["before-send", "accepted-kill"]) {
		const { dir, file } = tempOutbox();
		const marker = join(dir, "server.log");
		try {
			const child = spawnSync(process.execPath, ["--import", "tsx", fixture, file, marker, mode], {
				cwd: process.cwd(), stdio: "pipe",
			});
			assert.equal(child.signal, "SIGKILL");
			const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(rows[0].request.uuid, "stable-crash-uuid");
			assert.ok(rows[0].status === "pending" || rows[0].status === "sending");
			const restarted = new Outbox({
				file, prepare: prepared,
				send: async (request) => {
					appendFileSync(marker, `${request.uuid}\n`);
					return { success: true, messageId: "om_recovered" };
				},
			});
			await restarted.drainDue();
			assert.equal(restarted.stats().sent, 1);
			const attempts = readFileSync(marker, "utf8").trim().split("\n").filter(Boolean);
			assert.equal(new Set(attempts).size, 1);
			assert.equal(attempts[0], "stable-crash-uuid");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	}
});
