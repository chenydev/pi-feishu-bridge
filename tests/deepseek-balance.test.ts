/**
 * DeepSeek 余额客户端：解析、缓存、失败降级、快照与消耗速率。
 *
 * 重点不是"能调通"，而是**失败时不把整个命令带崩**：余额是增强信息，接口挂了
 * 也要给出可读原因（未配 key / 鉴权失败 / 超时 / 限流）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createBalanceClient,
	estimateBurnRate,
	formatRunway,
	parseBalance,
	type BalanceSnapshot,
} from "../src/outbound/deepseek-balance.js";

const OK_BODY = {
	is_available: true,
	balance_infos: [
		{ currency: "CNY", total_balance: "620.98", granted_balance: "0.00", topped_up_balance: "620.98" },
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("P1-03 余额：解析官方响应（字符串金额）", () => {
	assert.deepEqual(parseBalance(OK_BODY), { currency: "CNY", total: 620.98, granted: 0, toppedUp: 620.98 });
	// 数字金额也接受（接口未来改成 number 不该炸）
	assert.deepEqual(parseBalance({ balance_infos: [{ currency: "USD", total_balance: 12.5 }] }), {
		currency: "USD", total: 12.5, granted: 0, toppedUp: 0,
	});
	for (const bad of [null, {}, { balance_infos: [] }, { balance_infos: [{ currency: "CNY" }] }, "x"]) {
		assert.equal(parseBalance(bad), undefined, `畸形响应必须被判为无效：${JSON.stringify(bad)}`);
	}
});

test("P1-03 速率：样本数/跨度不足时不下结论", () => {
	assert.equal(estimateBurnRate([]), undefined);
	const hour = 3_600_000;
	assert.equal(estimateBurnRate([
		{ t: 0, currency: "CNY", total: 10 },
		{ t: hour, currency: "CNY", total: 9 },
	]), undefined, "只有 2 个样本时不估");
	assert.equal(estimateBurnRate([
		{ t: 0, currency: "CNY", total: 10 },
		{ t: 10 * 60_000, currency: "CNY", total: 9.9 },
		{ t: 20 * 60_000, currency: "CNY", total: 9.8 },
	]), undefined, "跨度 <1h 时不估");
});

test("P1-03 速率：只累计下降段，给出每小时消耗（充值被忽略）", () => {
	const hour = 3_600_000;
	const snapshots: BalanceSnapshot[] = [
		{ t: 0, currency: "CNY", total: 100 },
		{ t: hour, currency: "CNY", total: 98 },
		{ t: 2 * hour, currency: "CNY", total: 96 },
		{ t: 3 * hour, currency: "CNY", total: 94 },
	];
	const rate = estimateBurnRate(snapshots);
	assert.ok(rate, "4 个样本 / 3h 跨度应能估速率");
	assert.equal(rate?.currency, "CNY");
	assert.equal(rate?.samples, 4);
	assert.ok(Math.abs((rate?.perHour ?? 0) - 2) < 1e-9, `每小时应为 2，实际 ${rate?.perHour}`);
	// 充值导致的跳升不该被算成"负消耗"（下降量 1+1=2，跨度 3h → 0.67/h）
	const withTopUp = estimateBurnRate([
		{ t: 0, currency: "CNY", total: 10 },
		{ t: hour, currency: "CNY", total: 9 },
		{ t: 2 * hour, currency: "CNY", total: 109 },
		{ t: 3 * hour, currency: "CNY", total: 108 },
	]);
	assert.ok(withTopUp && withTopUp.perHour > 0, "跳升后仍应是正消耗");
});

test("P1-03 余额：未配置 key / 网络失败 / 鉴权失败都降级为可读原因", async () => {
	const noKey = createBalanceClient({ apiKey: undefined });
	assert.equal((await noKey.get()).status, "unavailable");

	const failing = createBalanceClient({
		apiKey: "k",
		fetchImpl: async () => { throw new Error("boom"); },
	});
	const failed = await failing.get();
	assert.equal(failed.status, "unavailable");
	assert.match(failed.status === "unavailable" ? failed.reason : "", /请求失败/);

	const unauthorized = createBalanceClient({ apiKey: "k", fetchImpl: async () => jsonResponse({}, 401) });
	const denied = await unauthorized.get();
	assert.match(denied.status === "unavailable" ? denied.reason : "", /鉴权失败/);

	const limited = createBalanceClient({ apiKey: "k", fetchImpl: async () => jsonResponse({}, 429) });
	assert.match((await limited.get()).status === "unavailable" ? ((await limited.get()) as { reason: string }).reason : "", /暂不可用/);
});

test("P1-03 余额：TTL 缓存命中不重复打接口，force 可绕过", async () => {
	let calls = 0;
	let clock = 1_000_000;
	const client = createBalanceClient({
		apiKey: "k",
		ttlMs: 5 * 60_000,
		now: () => clock,
		fetchImpl: async () => { calls += 1; return jsonResponse(OK_BODY); },
	});
	const first = await client.get();
	assert.equal(first.status, "ok");
	assert.equal(first.status === "ok" ? first.cached : undefined, false);
	clock += 60_000;
	const second = await client.get();
	assert.equal(second.status === "ok" ? second.cached : undefined, true, "TTL 内应命中缓存");
	assert.equal(calls, 1);
	await client.get({ force: true });
	assert.equal(calls, 2, "force 应穿透缓存");
	clock += 10 * 60_000;
	await client.get();
	assert.equal(calls, 3, "TTL 过期后应重新查询");
});

test("P1-03 余额：成功查询落快照文件，且能据此算出速率", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dma-balance-"));
	const snapshotPath = join(dir, "deepseek-balance-snapshots.jsonl");
	let clock = 1_000_000;
	let total = 100;
	const client = createBalanceClient({
		apiKey: "k",
		ttlMs: 0,
		now: () => clock,
		snapshotPath,
		fetchImpl: async () => jsonResponse({ balance_infos: [{ currency: "CNY", total_balance: String(total) }] }),
	});
	for (let i = 0; i < 4; i += 1) {
		await client.get({ force: true });
		clock += 3_600_000;
		total -= 2;
	}
	const lines = readFileSync(snapshotPath, "utf8").trim().split("\n");
	assert.equal(lines.length, 4, "每次成功查询落一行快照");
	const last = await client.get({ force: true });
	assert.ok(last.status === "ok" && last.burnRate, "快照足够后应给出速率");
	assert.ok(Math.abs((last.status === "ok" ? last.burnRate?.perHour ?? 0 : 0) - 2) < 1e-9);
});

test("P1-03 余额：损坏的快照行不影响其余样本", () => {
	const dir = mkdtempSync(join(tmpdir(), "dma-balance-bad-"));
	const snapshotPath = join(dir, "snapshots.jsonl");
	writeFileSync(snapshotPath, [
		"{not json",
		JSON.stringify({ t: 1, currency: "CNY", total: 10 }),
		JSON.stringify({ t: 3_600_001, currency: "CNY", total: 9 }),
		"",
	].join("\n"));
	const client = createBalanceClient({ apiKey: "k", snapshotPath });
	assert.equal(client.snapshots().length, 2);
});

test("P1-03 余额：预计可用时长的格式化", () => {
	assert.equal(formatRunway(0.5), "30min");
	assert.equal(formatRunway(6.4), "6.4h");
	assert.equal(formatRunway(48), "2.0d");
	assert.equal(formatRunway(0), "—");
	assert.equal(formatRunway(Number.NaN), "—");
});
