/**
 * P1-03 页脚指标：模型/耗时/token/费用估算。
 * - 拿不到 usage 时不显示 token 段；缺价显示"未知"，绝不显示假 0；
 * - 同一 messageId 只累加一次（durable 重投不重复）；
 * - 多轮工具累加；费用标注"估算"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptAgentEvent } from "../src/outbound/agent-event-adapter.js";
import { createRunMetrics, recordUsage, renderFooter } from "../src/outbound/run-metrics.js";

test("P1-03：adapter 透传 provider/model/usage，reasoning 不计入独立字段", () => {
	const adapted = adaptAgentEvent({
		type: "message_end",
		message: {
			id: "msg-1",
			role: "assistant",
			provider: "deepseek",
			model: "deepseek-flash",
			content: "回答",
			usage: { input: 1200, output: 345, cacheRead: 8900, cacheWrite: 0, cost: 0.0012, reasoning: 100 },
		},
	});
	assert.equal(adapted?.type, "message_end");
	if (adapted?.type !== "message_end") return;
	assert.equal(adapted.provider, "deepseek");
	assert.equal(adapted.model, "deepseek-flash");
	assert.deepEqual(adapted.usage, { input: 1200, output: 345, cacheRead: 8900, cacheWrite: 0, cost: 0.0012 });
	assert.equal("reasoning" in (adapted.usage ?? {}), false, "reasoning 是 output 子集，不单列");
});

test("P1-03：无 usage 的事件不产生 token 段（不显示假 0）", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "gpt-x" }); // 无 usage
	const footer = renderFooter(metrics, { elapsedMs: 1500, showCost: true });
	assert.ok(footer.includes("gpt-x"));
	assert.ok(footer.includes("1.5s"));
	assert.ok(!footer.includes("in "), "无用量数据时不得显示 token 段");
	assert.ok(!footer.includes("$"), "无用量数据时不得显示费用");
});

test("P1-03：缺价显示“费用未知”，不显示 $0.0000", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, {
		messageId: "m1", model: "gpt-x",
		usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
	});
	const footer = renderFooter(metrics, { elapsedMs: 800, showCost: true });
	assert.ok(footer.includes("in 100 / out 20"));
	assert.ok(footer.includes("费用未知"), "缺价必须是“未知”，不能是 0");
	assert.ok(!footer.includes("$0.0000"));
});

test("P1-03：重复 messageId 只累加一次（durable 重投不重复）", () => {
	const metrics = createRunMetrics();
	const payload = { messageId: "dup-1", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } };
	assert.equal(recordUsage(metrics, payload), true);
	assert.equal(recordUsage(metrics, payload), false, "同一 messageId 必须被去重");
	assert.equal(recordUsage(metrics, { ...payload }), false);
	assert.equal(metrics.usage.input, 10);
	assert.equal(metrics.usage.output, 5);
	assert.ok(Math.abs(metrics.cost - 0.01) < 1e-9);
});

test("P1-03：多轮工具累加，模型取最新", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "r1", model: "m-a", usage: { input: 1000, output: 100, cacheRead: 2000, cacheWrite: 0, cost: 0.001 } });
	recordUsage(metrics, { messageId: "r2", model: "m-a", usage: { input: 500, output: 50, cacheRead: 3000, cacheWrite: 10, cost: 0.002 } });
	assert.equal(metrics.usage.input, 1500);
	assert.equal(metrics.usage.output, 150);
	assert.equal(metrics.usage.cacheRead, 5000);
	assert.equal(metrics.usage.cacheWrite, 10);
	const footer = renderFooter(metrics, { elapsedMs: 65_000, showCost: true });
	assert.ok(footer.includes("in 1.5k / out 150"), footer);
	assert.ok(footer.includes("cache 5.0k"), footer);
	assert.ok(footer.includes("1m05s"), footer);
	assert.ok(footer.includes("（估算）"), "费用必须标注估算");
});

test("P1-03：showCost=false 时不显示费用段，其余照常", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5 } });
	const footer = renderFooter(metrics, { elapsedMs: 500, showCost: false });
	assert.ok(footer.includes("in 10 / out 5"));
	assert.ok(!footer.includes("$"), "关闭费用展示时不得出现金额");
	assert.ok(!footer.includes("费用未知"), "关闭时连“未知”也不显示");
});

test("P1-03：耗时格式化覆盖毫秒/秒/分钟", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
	assert.ok(renderFooter(metrics, { elapsedMs: 250, showCost: false }).includes("250ms"));
	assert.ok(renderFooter(metrics, { elapsedMs: 12_300, showCost: false }).includes("12.3s"));
	assert.ok(renderFooter(metrics, { elapsedMs: 125_000, showCost: false }).includes("2m05s"));
});

test("P1-03：匿名（无 messageId）用量每次都计，并有计数便于诊断", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { model: "m", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } });
	recordUsage(metrics, { model: "m", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } });
	assert.equal(metrics.usage.input, 20);
	assert.equal(metrics.anonymousCounted, 2);
	assert.equal(metrics.countedMessages.size, 0);
});

test("P1-03：完全没有可用信息时不产生页脚", () => {
	const metrics = createRunMetrics();
	assert.equal(renderFooter(metrics, { elapsedMs: 0, showCost: true }), "", "无模型无用量时不显示空页脚");
});
