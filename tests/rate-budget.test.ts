/**
 * P1-07 共享请求预算与熔断：
 * - 令牌桶按类别限速，易失通道（live）预算不足时跳过（不丢内容）；
 * - final/approval 是硬需求：熔断期间也不阻断；
 * - 连续限频/网络失败触发冷却；平台 retry-after 参与冷却时长；
 * - 熔断只影响易失展示，**不改动** durable 队列（不标记成功、不删除、UUID 不变）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RateBudget } from "../src/runtime/rate-budget.js";
import { LiveChannel } from "../src/outbound/live-channel.js";
import { Outbox } from "../src/outbound/outbox.js";
import type { PreparedSend } from "../src/outbound/sender.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-budget-"));
}

test("P1-07：令牌桶按突发与速率限速", () => {
	let now = 0;
	const budget = new RateBudget({ rates: { live: 2 }, bursts: { live: 2 }, now: () => now });
	assert.equal(budget.tryAcquire("live").ok, true);
	assert.equal(budget.tryAcquire("live").ok, true);
	const denied = budget.tryAcquire("live");
	assert.equal(denied.ok, false);
	assert.equal(denied.reason, "budget");
	assert.ok((denied.retryAfterMs ?? 0) > 0, "应给出建议等待时间");

	now += 500; // 补充 1 个令牌（2/s）
	assert.equal(budget.tryAcquire("live").ok, true);
	assert.equal(budget.tryAcquire("live").ok, false);
});

test("P1-07：final/approval 不受熔断影响", () => {
	let now = 0;
	const budget = new RateBudget({ failureThreshold: 1, cooldownMs: 60_000, now: () => now });
	budget.record({ errorClass: "rate_limited" });
	assert.equal(budget.snapshot().open, true, "应已熔断");

	// 易失通道：熔断 + 半开探测用尽后被拒
	assert.equal(budget.tryAcquire("live").ok, true, "半开探测放行一次");
	assert.equal(budget.tryAcquire("live").ok, false, "探测用尽后拒绝");
	// 硬需求通道：始终放行
	for (let i = 0; i < 5; i += 1) {
		assert.equal(budget.tryAcquire("final").ok, true);
		assert.equal(budget.tryAcquire("approval").ok, true);
	}
});

test("P1-07：连续限频触发冷却，成功清零；平台 retry-after 参与冷却", () => {
	let now = 0;
	const budget = new RateBudget({ failureThreshold: 3, cooldownMs: 5_000, now: () => now });
	budget.record({ errorClass: "network" });
	budget.record({ errorClass: "network" });
	assert.equal(budget.snapshot().open, false, "未达阈值不得熔断");
	budget.record({ errorClass: "network" });
	assert.equal(budget.snapshot().open, true);

	// 平台要求 60s → 冷却不得短于平台要求
	const budget2 = new RateBudget({ failureThreshold: 1, cooldownMs: 5_000, now: () => now });
	budget2.record({ errorClass: "rate_limited", retryAfterMs: 60_000 });
	assert.ok((budget2.snapshot().resumeAt ?? 0) - now >= 60_000, "冷却时长必须覆盖平台 retry-after");

	// 成功清零
	budget.record({ ok: true });
	assert.equal(budget.snapshot().open, false);
	assert.equal(budget.snapshot().failures, 0);
});

test("P1-07：非瞬时错误（权限/内容）不触发熔断", () => {
	const budget = new RateBudget({ failureThreshold: 2, now: () => 0 });
	budget.record({ errorClass: "permission" });
	budget.record({ errorClass: "content_rejected" });
	assert.equal(budget.snapshot().open, false, "权限/内容错误不应被当成限流");
});

test("P1-07：熔断期间 LiveChannel 跳过写入但保留内容（不丢）", async () => {
	const writes: string[] = [];
	let now = 0;
	const budget = new RateBudget({ failureThreshold: 1, cooldownMs: 60_000, now: () => now });
	budget.record({ errorClass: "rate_limited" });
	budget.tryAcquire("live"); // 用掉半开探测

	const channel = new LiveChannel({
		edit: async (_id, text) => { writes.push(text); return true; },
		throttleMs: 0,
		budget,
	});
	channel.open("k", "om_1");
	channel.append("k", "第一段");
	await tick(20);
	assert.equal(writes.length, 0, "冷却期间易失更新应被跳过");

	// 冷却结束：内容仍在，可继续写入（不丢字符）
	now += 60_000;
	channel.append("k", "第二段");
	await tick(20);
	assert.equal(writes.length, 1);
	assert.ok(writes[0].includes("第一段"), `跳过期间的内容不得丢失：${writes[0]}`);
	assert.ok(writes[0].includes("第二段"));
});

test("P1-07：熔断不改动 durable 队列（不标成功、不删除、UUID 不变）", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "outbox.jsonl");
		const budget = new RateBudget({ failureThreshold: 1, cooldownMs: 60_000, now: () => 0 });
		budget.record({ errorClass: "rate_limited" }); // 熔断打开

		const prepared = (chatId: string, content: string): PreparedSend[] => [{
			chatId, msgType: "text",
			payload: JSON.stringify({ text: content }),
			plainTextPayload: JSON.stringify({ text: content }),
			opts: {}, uuid: `uuid-${content}`,
			contentFallbackUuid: `c-${content}`, routeFallbackUuid: `r-${content}`,
		}];
		let sendCalls = 0;
		const outbox = new Outbox({
			file, prepare: prepared,
			send: async () => {
				sendCalls += 1;
				// 熔断期间上层仍应尝试投递（durable 不能被静默丢弃）
				return { success: false, error: "429: rate limited", retryable: true, retryAfterMs: 60_000, errorClass: "rate_limited" };
			},
		});
		outbox.enqueue("oc_1", "重要回答", {}, { dedupeKey: "b1:final", laneKey: "lane", kind: "final" });
		outbox.start();
		await tick(50);
		outbox.stop();

		assert.ok(sendCalls >= 1, "durable 队列必须仍然尝试投递");
		const stats = outbox.stats();
		assert.equal(stats.sent, 0, "失败不得被标记成已投递");
		assert.equal(stats.failed, 0, "限频是瞬时失败，应保持 pending 等待重试");
		assert.equal(stats.pending, 1, "条目必须保留在队列中");

		const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { request: { uuid: string } });
		assert.equal(rows[0].request.uuid, "uuid-重要回答", "UUID 必须保持不变（幂等）");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-07：状态快照与冷却提示可读", () => {
	let now = 1_000;
	const budget = new RateBudget({ failureThreshold: 1, cooldownMs: 30_000, now: () => now });
	assert.equal(budget.cooldownNotice(), undefined, "未熔断时没有提示");
	budget.record({ errorClass: "rate_limited" });
	const snapshot = budget.snapshot();
	assert.equal(snapshot.open, true);
	assert.ok((snapshot.resumeAt ?? 0) > now);
	const notice = budget.cooldownNotice();
	assert.ok(notice && notice.includes("秒后恢复"), notice);
	assert.ok(notice && notice.includes("最终交付不受影响"), "必须明确 final 不受影响");

	now += 31_000;
	// 冷却结束 → 自动恢复：清熔断状态并按正常预算放行
	assert.equal(budget.tryAcquire("live").ok, true, "冷却结束应自动恢复");
	assert.equal(budget.tryAcquire("live").ok, true);
	assert.equal(budget.snapshot().open, false, "恢复后熔断必须关闭");
	assert.equal(budget.snapshot().failures, 0, "恢复后失败计数清零");
});
