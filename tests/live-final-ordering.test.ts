/**
 * P0-04 final 与易失写入的顺序保证（R2 回归）：
 * - 同一 messageId 的 edit 严格串行，final 交接必须 drain 全部在途写入；
 * - 写入超时的消息不得再被复用为 final 目标（HTTP 无法取消，迟到写入可能覆盖）；
 * - 业务失败（返回 false）不标记不可信，但计入熔断；
 * - 进度写入与流式写入共用串行语义。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveChannel, SerialWriter } from "../src/outbound/live-channel.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到条件成立（避免固定 sleep 造成的偶发失败）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await tick(2);
	assert.ok(predicate(), "等待条件超时");
}

test("P0-04/R2：final 交接等待全部在途写入，旧写入不再迟到覆盖", async () => {
	const calls: string[] = [];
	let releaseFirst!: (ok: boolean) => void;
	const live = new LiveChannel({
		edit: async (_messageId, text) => {
			calls.push(text);
			if (calls.length === 1) return await new Promise<boolean>((resolve) => { releaseFirst = resolve; });
			return true;
		},
		throttleMs: 0,
	});

	live.open("k", "om_live");
	live.append("k", "A");
	await waitFor(() => calls.length === 1);
	assert.deepEqual(calls, ["A"]);

	live.append("k", "B");
	await tick(20);
	assert.deepEqual(calls, ["A"], "第二次写入必须等第一次落定，不得并发（R2 根因）");

	let settled = false;
	let claimed: string | undefined;
	void live.claimFinalTarget("k").then((id) => { claimed = id; settled = true; });
	await tick(20);
	assert.equal(settled, false, "final 不得在在途写入结束前接管");

	releaseFirst(true);
	await waitFor(() => settled);
	assert.equal(claimed, "om_live", "内容可信时 final 复用原消息");
	assert.deepEqual(calls, ["A", "AB"], "两次写入严格串行且顺序确定");
});

test("P0-04：写入超时的消息不再作为 final 目标", async () => {
	const live = new LiveChannel({
		edit: async () => await new Promise<boolean>(() => { /* 永不返回：模拟网络挂起 */ }),
		throttleMs: 0,
		writeTimeoutMs: 20,
	});
	live.open("k", "om_live");
	live.append("k", "内容");
	await tick(5);
	const messageId = await live.claimFinalTarget("k");
	assert.equal(messageId, undefined, "超时消息不可复用：迟到写入可能覆盖 final，改发新消息");
});

test("P0-04：连续编辑失败熔断后 final 改走新消息", async () => {
	let attempts = 0;
	const live = new LiveChannel({
		edit: async () => { attempts += 1; return false; },
		throttleMs: 0,
		maxFailures: 3,
	});
	live.open("k", "om_live");
	for (let i = 0; i < 5; i += 1) { live.append("k", "x"); await tick(5); }
	assert.ok(attempts >= 3, `应至少尝试 3 次，实际 ${attempts}`);
	assert.equal(await live.claimFinalTarget("k"), undefined);
});

test("P0-04：业务失败（未超时）不标记不可信，消息仍可复用", async () => {
	const live = new LiveChannel({
		edit: async () => false,
		throttleMs: 0,
		maxFailures: 9,
	});
	live.open("k", "om_live");
	live.append("k", "A");
	await tick(10);
	live.append("k", "B");
	await tick(10);
	assert.equal(await live.claimFinalTarget("k"), "om_live", "明确失败 = 内容未变，不算不可信");
});

test("P0-04：discard 作废在队写入（撤回后不再落地）", async () => {
	const written: string[] = [];
	let release!: (ok: boolean) => void;
	const writer = new SerialWriter({
		edit: async (_messageId, text) => {
			written.push(text);
			if (written.length === 1) return await new Promise<boolean>((resolve) => { release = resolve; });
			return true;
		},
	});

	writer.enqueue("m1", "inflight");
	await waitFor(() => written.length === 1);
	writer.enqueue("m1", "queued");
	writer.discard("m1");
	release(true);
	await tick(20);
	assert.deepEqual(written, ["inflight"], "已发出无法取消，但排在队里的写入必须被作废");
});

test("P0-04：SerialWriter 同目标串行、不同目标并行", async () => {
	const order: string[] = [];
	let concurrent = 0;
	let maxConcurrent = 0;
	const writer = new SerialWriter({
		edit: async (messageId, text) => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push(`${messageId}:${text}`);
			concurrent -= 1;
			return true;
		},
	});

	writer.enqueue("m1", "1");
	writer.enqueue("m1", "2");
	writer.enqueue("m2", "a");
	await Promise.all([writer.drain("m1"), writer.drain("m2")]);

	assert.deepEqual(order.filter((entry) => entry.startsWith("m1")), ["m1:1", "m1:2"], "同目标严格串行且保序");
	assert.ok(maxConcurrent >= 2, "不同目标应能并行（不互相阻塞）");
});

test("P0-04：drain 等待全部在队写入，不含未入队的后续更新", async () => {
	const written: string[] = [];
	const writer = new SerialWriter({
		edit: async (_messageId, text) => { written.push(text); await new Promise((r) => setTimeout(r, 5)); return true; },
	});
	writer.enqueue("m1", "a");
	writer.enqueue("m1", "b");
	const drained = await writer.drain("m1");
	assert.deepEqual(written, ["a", "b"]);
	assert.equal(drained.ok, true);
	assert.equal(writer.isUncertain("m1"), false);
});
