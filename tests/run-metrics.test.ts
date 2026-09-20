/**
 * P1-03 页脚指标：模型/耗时/token/费用估算。
 * - 拿不到 usage 时不显示 token 段；缺价显示"未知"，绝不显示假 0；
 * - 同一 messageId 只累加一次（durable 重投不重复）；
 * - 多轮工具累加；费用标注"估算"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptAgentEvent } from "../src/outbound/agent-event-adapter.js";
import { createRunMetrics, recordUsage, renderFooter, stripFooterFromQuote, stripMarkdown } from "../src/outbound/run-metrics.js";

test("P1-03：adapter 透传 provider/model/usage，reasoning 不计入独立字段", () => {
	const adapted = adaptAgentEvent({
		type: "message_end",
		message: {
			id: "msg-1",
			role: "assistant",
			provider: "deepseek",
			model: "deepseek-flash",
			content: "回答",
			// 真实 Pi 形状：usage.cost 是对象而非数字（见 pi-ai types.d.ts 的 Usage）
			usage: {
				input: 1200, output: 345, cacheRead: 8900, cacheWrite: 0, reasoning: 100,
				cost: { input: 0.00036, output: 0.00041, cacheRead: 0.00005, cacheWrite: 0, total: 0.00082 },
			},
		},
	});
	assert.equal(adapted?.type, "message_end");
	if (adapted?.type !== "message_end") return;
	assert.equal(adapted.provider, "deepseek");
	assert.equal(adapted.model, "deepseek-flash");
	assert.deepEqual(adapted.usage, { input: 1200, output: 345, cacheRead: 8900, cacheWrite: 0, cost: 0.00082 });
	assert.equal("reasoning" in (adapted.usage ?? {}), false, "reasoning 是 output 子集，不单列");
});

test("P1-03：cost 对象缺 total 时按分项求和，非数字分项视为未知", () => {
	const key = "usage";
	const withParts = adaptAgentEvent({
		type: "message_end",
		message: { id: "m", role: "assistant", content: "x", [key]: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
		} },
	});
	assert.equal(withParts?.type === "message_end" ? withParts.usage?.cost : undefined, 0.003);

	for (const bad of [{ total: "0.01" }, { input: 0.1, output: Number.NaN, cacheRead: 0, cacheWrite: 0 }, "0.01", Number.NaN]) {
		const adapted = adaptAgentEvent({
			type: "message_end",
			message: { id: "m", role: "assistant", content: "x", [key]: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: bad } },
		});
		assert.equal(adapted?.type === "message_end" ? adapted.usage?.cost : "no-event", undefined, `畸形 cost 必须视为未知：${JSON.stringify(bad)}`);
	}
});

test("P1-03：兼容历史数字形状的 cost", () => {
	const adapted = adaptAgentEvent({
		type: "message_end",
		message: { id: "m", role: "assistant", content: "x",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
	});
	assert.equal(adapted?.type === "message_end" ? adapted.usage?.cost : undefined, 0.01);
});

test("P1-03：真实 Pi 形状的用法能出到页脚（回归：费用不再恒为未知）", () => {
	const adapted = adaptAgentEvent({
		type: "message_end",
		message: {
			id: "msg-real", role: "assistant", provider: "deepseek", model: "deepseek-flash", content: "hi",
			usage: {
				input: 238, output: 11, cacheRead: 20480, cacheWrite: 0, totalTokens: 20729,
				// 实测费率：input 0.3 / output 1.2 / cacheRead 0.006（美元每百万 token）
				cost: { input: 7.14e-5, output: 1.32e-5, cacheRead: 0.00012288, cacheWrite: 0, total: 0.00020742 },
			},
		},
	});
	if (adapted?.type !== "message_end") throw new Error("expected message_end");
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: adapted.messageId, model: adapted.model, usage: adapted.usage });
	const footer = renderFooter(metrics, {
		elapsedMs: 1800,
		showCost: true,
		// 页脚口径是会话级：token/费用都取会话累计（本轮只留模型+耗时）
		session: {
			tokens: { input: 67_400, output: 9_400, cacheRead: 514_700, cacheWrite: 0 },
			cost: 0.0201,
		},
		context: { tokens: 20_800, contextWindow: 1_000_000, percent: 2.1 },
	});
	assert.equal(footer, [
		"———",
		"⚡ deepseek-flash · **1.8s** · 上下文 **2.1%（20.8k / 1.0M）**",
		"📊 本会话 输入 **582.1k** = 未命中 **67.4k** + 缓存命中 **514.7k**（**88.4%**） | 输出 **9.4k**",
		"💰 本会话 **$0.02（估算）**",
	].join("\n"));
});

test("P1-03：没有会话统计时页脚只剩本轮（不显示假 0）", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, {
		messageId: "m1", model: "deepseek-flash",
		usage: { input: 251, output: 21, cacheRead: 20_480, cacheWrite: 0, cost: 0.0001 },
	});
	const footer = renderFooter(metrics, { elapsedMs: 1800, showCost: true });
	assert.equal(footer, "———\n⚡ deepseek-flash · **1.8s**");
	assert.ok(!footer.includes("$"), "没有会话累计就不给金额（本轮金额已不再显示）");
});

test("P1-03：缓存为 0 时 token 段不带未命中/命中拆分（无意义就别写）", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } });
	const footer = renderFooter(metrics, {
		elapsedMs: 500, showCost: true,
		session: { tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 } },
	});
	assert.ok(footer.includes("📊 本会话 输入 **1.0k** | 输出 **200**"), footer);
	assert.ok(!footer.includes("未命中"), footer);
});

test("P1-03：缺少会话费用时显示「费用未知」，不显示 $0.00", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "gpt-x", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
	const footer = renderFooter(metrics, {
		elapsedMs: 800, showCost: true,
		session: { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } },
	});
	assert.ok(footer.includes("💰 本会话 **费用未知**"), footer);
	assert.ok(!footer.includes("$0.00"));
});

test("P1-03：会话 cost 恰为 0（模型未配置费率）同样显示「未知」", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "unpriced", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 } });
	const footer = renderFooter(metrics, {
		elapsedMs: 800, showCost: true,
		session: { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
	});
	assert.ok(footer.includes("费用未知"), footer);
	assert.ok(!footer.includes("$0.00"), `零费率不能被渲染成免费：${footer}`);
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
	recordUsage(metrics, { messageId: "r2", model: "m-b", usage: { input: 500, output: 50, cacheRead: 3000, cacheWrite: 10, cost: 0.002 } });
	// run 指标仍按 messageId 去重累加（留作诊断用），但页脚只展示会话级口径
	assert.equal(metrics.usage.input, 1500);
	assert.equal(metrics.usage.output, 150);
	assert.equal(metrics.usage.cacheRead, 5000);
	assert.equal(metrics.usage.cacheWrite, 10);
	assert.equal(metrics.model, "m-b", "模型取最新一轮");
	const footer = renderFooter(metrics, {
		elapsedMs: 65_000, showCost: true,
		session: { tokens: { input: 1500, output: 150, cacheRead: 5000, cacheWrite: 10 }, cost: 0.003 },
	});
	assert.ok(footer.includes("**1m05s**"), footer);
	assert.ok(footer.includes("📊 本会话 输入 **6.5k** = 未命中 **1.5k** + 缓存命中 **5.0k**"), footer);
	assert.ok(footer.includes(" | 输出 **150**"), footer);
	assert.ok(footer.includes("（估算）"), "费用必须标注估算");
});

test("P1-03：showCost=false 时不显示费用段，其余照常", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5 } });
	const footer = renderFooter(metrics, {
		elapsedMs: 500, showCost: false,
		session: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.5 },
	});
	assert.ok(footer.includes("📊 本会话 输入 **10** | 输出 **5**"), footer);
	assert.ok(!footer.includes("$"), "关闭费用展示时不得出现金额");
	assert.ok(!footer.includes("费用未知"), "关闭时连「未知」也不显示");
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

test("P1-03：页脚 ¥ 双显 —— 提供比值时才显示，且与 $ 同源", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "deepseek-flash", usage: { input: 238, output: 11, cacheRead: 0, cacheWrite: 0, cost: 0.05 } });
	const session = { tokens: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0 }, cost: 0.05 };
	const withCny = renderFooter(metrics, { elapsedMs: 1800, showCost: true, showCny: true, cnyPerUsd: 20 / 3, session });
	assert.ok(withCny.includes("$0.05 / ¥0.33（估算）"), withCny);
	const withoutRatio = renderFooter(metrics, { elapsedMs: 1800, showCost: true, showCny: true, session });
	assert.ok(withoutRatio.includes("$0.05（估算）"), withoutRatio);
	assert.ok(!withoutRatio.includes("¥"), "没有比值就不显示 ¥（未知模型）");
	const off = renderFooter(metrics, { elapsedMs: 1800, showCost: true, showCny: false, cnyPerUsd: 20 / 3, session });
	assert.ok(!off.includes("¥"), "关掉 showCny 后不显示 ¥");
});

test("P1-03：页脚图标分区 —— 三行，token/费用都是会话级", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, {
		messageId: "m1", model: "deepseek-flash",
		usage: { input: 251, output: 21, cacheRead: 20_480, cacheWrite: 0, cost: 0.0001 },
	});
	const footer = renderFooter(metrics, {
		elapsedMs: 1800, showCost: true, showCny: true, cnyPerUsd: 20 / 3,
		session: {
			tokens: { input: 67_400, output: 9_400, cacheRead: 514_700, cacheWrite: 0 },
			cost: 0.0201,
		},
		context: { tokens: 20_800, contextWindow: 1_000_000, percent: 2.1 },
	});
	assert.equal(footer, [
		"———",
		"⚡ deepseek-flash · **1.8s** · 上下文 **2.1%（20.8k / 1.0M）**",
		"📊 本会话 输入 **582.1k** = 未命中 **67.4k** + 缓存命中 **514.7k**（**88.4%**） | 输出 **9.4k**",
		"💰 本会话 **$0.02 / ¥0.13（估算）**",
	].join("\n"));
	// 本轮金额不再出现（用户明确要求：只看本会话）
	assert.ok(!footer.includes("本轮 **"), footer);
});

test("P1-03：页脚上下文段 —— 有窗口信息才显示，压缩后的 null 直接跳过", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 } });
	const session = { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
	const withContext = renderFooter(metrics, {
		elapsedMs: 500, showCost: true, session,
		context: { tokens: 95_100, contextWindow: 1_000_000, percent: 9.5 },
	});
	assert.ok(withContext.includes("上下文 **9.5%（95.1k / 1.0M）**"), withContext);
	// 压缩后 pi 给 null —— 此时不显示该段，也不能显示 "null%"
	const compacted = renderFooter(metrics, {
		elapsedMs: 500, showCost: true, session,
		context: { tokens: null, contextWindow: 1_000_000, percent: null },
	});
	assert.ok(!compacted.includes("上下文"), compacted);
});

test("P1-03：耗时超 1 小时用小时表示", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
	assert.ok(renderFooter(metrics, { elapsedMs: 3 * 3_600_000, showCost: false }).includes("3.0h"));
	assert.ok(renderFooter(metrics, { elapsedMs: 125_000, showCost: false }).includes("2m05s"), "一小时以内仍是 m+s");
});

test("P1-03：文本通道的页脚不带 markdown 标记与分割线标记", () => {
	const metrics = createRunMetrics();
	recordUsage(metrics, { messageId: "m1", model: "deepseek-flash", usage: { input: 251, output: 21, cacheRead: 20_480, cacheWrite: 0, cost: 0.0001 } });
	const footer = renderFooter(metrics, {
		elapsedMs: 1500, showCost: true, showCny: true, cnyPerUsd: 20 / 3,
		session: { tokens: { input: 67_400, output: 9_400, cacheRead: 514_700, cacheWrite: 0 }, cost: 0.0201 },
		context: { tokens: 20_800, contextWindow: 1_000_000, percent: 2.1 },
	});
	// 卡片版：markdown + 内部分割线标记（卡片用 hr 元素，这块会被剥掉）
	assert.ok(footer.includes("**1.5s**"), footer);
	assert.ok(footer.startsWith("———\n"), footer);
	// 文本版：两者都要去掉，否则用户看到字面 `**` 和 `———`
	const plain = stripMarkdown(footer.replace(/^———\n/, ""));
	assert.ok(!plain.includes("**"), plain);
	assert.ok(!plain.includes("———"), plain);
	assert.ok(plain.includes("⚡ deepseek-flash · 1.5s · 上下文 2.1%（20.8k / 1.0M）"), plain);
});

test("P1-03：文本版页脚也能被引用剥离（没有分割线时的形态）", () => {
	const body = "答案是 42。";
	const plainFooter = [
		"⚡ deepseek-flash · 1.5s · 上下文 2.1%（20.8k / 1.0M）",
		"📊 本会话 输入 582.1k = 未命中 67.4k + 缓存命中 514.7k（88.4%） | 输出 9.4k",
		"💰 本会话 <$0.01 / <¥0.01（估算）",
	].join("\n");
	assert.equal(stripFooterFromQuote(`${body}\n\n${plainFooter}`), body);
	assert.equal(stripFooterFromQuote(`${body}\n\n${plainFooter}\n`), body, "尾部空行不影响");
	// 只有一行 ⚡（没有会话统计时的页脚）也要剥
	assert.equal(stripFooterFromQuote(`${body}\n\n⚡ m · 1.0s`), body);
	// 页脚行出现在中间也一样删（不让"边界猜错"成为漏洞）；正文其余部分原样保留
	const midText = `⚡ 这是页脚形态的行\n${body}`;
	assert.equal(stripFooterFromQuote(midText), body);
	// 整条都是页脚（用户引用了旧版的纯页脚消息）：结果为空，由调用方给占位提示
	assert.equal(stripFooterFromQuote("📊 本会话 输入 1.0k | 输出 10"), "");
});

test("P1-03：引用回复时剥掉页脚块（省 token，且不误删正文）", () => {
	const body = "答案是 42。";
	const footer = "———\n⚡ deepseek-flash · **1.8s** · **251→21** tok\n🧠 上下文 **2.1%（20.8k / 1.0M）**\n💰 本轮 **<$0.01（估算）**";
	assert.equal(stripFooterFromQuote(`${body}\n\n${footer}`), body);
	// 单行页脚（showSession=false）也要能剥
	assert.equal(stripFooterFromQuote(`${body}\n\n———\n⚡ m · **1.0s** · **1→1** tok`), body);
	// 旧版文字页脚也要能剥（历史消息）
	assert.equal(stripFooterFromQuote(`${body}\n\n———\n本轮 m · 1.0s · in 1 / out 1`), body);
	// 没有页脚：原样返回
	assert.equal(stripFooterFromQuote(body), body);
	// 分割线与页脚行都按"形态"删（超集判定）：代价是正文里恰好长得一样的行也会被删，
	// 换来的是"元信息一定进不去上下文"（引用块里这行也没有语义价值）
	const withDivider = `${body}\n———\n这是正文的一部分，不是页脚`;
	assert.equal(stripFooterFromQuote(withDivider), `${body}\n这是正文的一部分，不是页脚`);
	// 精确层优先：注册表里有原文时按整段后缀切，不误伤同类行
	const footerText = "本轮 m · 1.0s · in 1 / out 1";
	assert.equal(stripFooterFromQuote(`${body}\n${footerText}`, [footerText]), body);
	assert.equal(stripFooterFromQuote(`${body}\n${footerText}\n`, [footerText]), body, "尾随空行也能精确命中");
});
