/**
 * `/feishu usage` 渲染：卡与文本回退必须同口径。
 *
 * 卡 2.0 的 `header` 是对象本身、**不接受 `tag`**（带上会被飞书拒卡：
 * 230099 → 200621 unknown property, property: tag, path: ROOT -> header）——
 * 那是个已经踩过一次的坑，这里用断言钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	accountSectionLines,
	buildUsageCard,
	formatUsageReport,
	sessionSectionLines,
	usageReportLines,
	type UsageReportInput,
} from "../src/commands/usage-card.js";
import type { BalanceResult } from "../src/outbound/deepseek-balance.js";

const balanceOk: BalanceResult = {
	status: "ok",
	cached: false,
	balance: { currency: "CNY", total: 620.98, granted: 0, toppedUp: 620.98 },
	burnRate: { currency: "CNY", perHour: 2, samples: 12, spanMs: 3 * 3_600_000 },
};

const fullInput: UsageReportInput = {
	modelLabel: "deepseek/deepseek-flash",
	tier: "offPeak",
	balance: balanceOk,
	session: {
		tokens: { input: 64_000, output: 35_000, cacheRead: 4_300_000, cacheWrite: 0 },
		cost: 0.043,
		contextUsage: { tokens: 95_100, contextWindow: 1_000_000, percent: 9.5 },
		userMessages: 5,
		assistantMessages: 5,
		toolCalls: 12,
	},
	run: {
		model: "deepseek-flash",
		tokens: { input: 238, output: 11, cacheRead: 20_480, cacheWrite: 0 },
		cost: 0.0002,
		hasCost: true,
		elapsedMs: 1800,
	},
	localTimeLabel: "2026-09-21 01:10:00",
};

test("P1-03 报告：本会话 + 账户两段齐全，输入/输出/缓存/命中率同源", () => {
	const text = formatUsageReport(fullInput);
	assert.match(text, /本会话 · 模型 deepseek\/deepseek-flash/);
	assert.match(text, /⚡ 最近一轮耗时 1\.8s/);
	assert.match(text, /🧠 上下文 9\.5%（95\.1k \/ 1\.0M）/);
	// 输入 = 未命中 + 缓存命中，括号里是命中率；输出单列
	assert.match(text, /📊 输入 4\.4M = 未命中 64\.0k \+ 缓存命中 4\.3M（98\.5%） \| 输出 35\.0k/);
	assert.match(text, /💰 累计 \$0\.04 \/ ¥0\.29（估算/);
	assert.match(text, /🧾 消息 用户 5 \/ 助手 5 \/ 工具 12/);
	assert.match(text, /账户（DeepSeek）/);
	assert.match(text, /💳 余额 ¥620\.98（充值 ¥620\.98 \+ 赠送 ¥0\.00）/);
	assert.match(text, /📉 消耗 ¥2\.00\/h（12 快照 \/ 3\.0h） · 预计可用 ≈ 12\.9d/);
	assert.match(text, /🕒 off-peak（低谷） · 2026-09-21 01:10:00 · 数据源 GET \/user\/balance/);
});

test("P1-03 报告：卡片把两段分开（会话 + 分割线 + 小号账户段）", () => {
	const card = buildUsageCard(fullInput) as { schema: string; body: { elements: Array<Record<string, unknown>> } };
	assert.equal(card.schema, "2.0");
	assert.equal(card.body.elements.length, 3);
	assert.equal(card.body.elements[0]?.content, sessionSectionLines(fullInput).join("\n"));
	assert.equal(card.body.elements[1]?.tag, "hr");
	assert.equal(card.body.elements[2]?.text_size, "notation", "账户段用小号字（次要信息）");
	assert.equal(card.body.elements[2]?.content, accountSectionLines(fullInput).join("\n"));
	// 文本回退 = 两段拼起来（同一份行，不会两处口径漂移）
	assert.equal(usageReportLines(fullInput).join("\n"), [
		...sessionSectionLines(fullInput), "", ...accountSectionLines(fullInput),
	].join("\n"));
});

test("P1-03 报告：余额不可用只降级该段，不隐藏整张卡", () => {
	const input: UsageReportInput = {
		...fullInput,
		balance: { status: "unavailable", reason: "未配置 DEEPSEEK_API_KEY，无法查询账户余额" },
	};
	const text = formatUsageReport(input);
	assert.match(text, /⚠️ 余额不可用：未配置 DEEPSEEK_API_KEY/);
	assert.match(text, /📊 输入 4\.4M/, "会话用量仍要显示");
	assert.match(text, /🧠 上下文/, "上下文不依赖余额接口");
	assert.ok(!text.includes("数据源 GET"), "拿不到余额就不写数据源");
});

test("P1-03 报告：非 DeepSeek 模型不显示 ¥（宁缺勿错）", () => {
	const input: UsageReportInput = {
		...fullInput,
		modelLabel: "openai/gpt-5",
		session: { ...fullInput.session, cost: 0.5 },
		run: undefined,
	};
	const text = formatUsageReport(input);
	assert.match(text, /💰 累计 \$0\.50（估算/);
	// 余额段是账户级信息，本来就有 ¥；关键是**费用行**不能被折算
	assert.ok(!/💰 累计 \$[^\n]*¥/.test(text), `费用行不该出现 ¥：${text}`);
});

test("P1-03 报告：拿不到费用时不编造金额", () => {
	const input: UsageReportInput = {
		...fullInput,
		session: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
		run: undefined,
	};
	const text = formatUsageReport(input);
	assert.match(text, /💰 累计 费用未知/, `拿不到费用要写明未知：${text}`);
	assert.ok(!/💰 累计 \$0\.00/.test(text));
	// 余额仍显示（那是账户级信息，与会话费用无关）
	assert.match(text, /💳 余额 ¥620\.98/);
});

test("P1-03 报告：卡片是 card 2.0，header 不带 tag", () => {
	const card = buildUsageCard(fullInput) as Record<string, unknown>;
	assert.equal(card.schema, "2.0");
	const header = card.header as Record<string, unknown>;
	assert.equal("tag" in header, false, "header 带 tag 会被飞书拒卡");
	assert.deepEqual(header.title, { tag: "plain_text", content: "用量与余额" });
});
