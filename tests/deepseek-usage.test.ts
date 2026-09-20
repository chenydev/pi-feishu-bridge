/**
 * DeepSeek 费率/档位/¥ 折算（页脚与 usage 卡共用）。
 *
 * 最关键的一条：官方 USD 与 CNY 价表**同比**（peak 都是 off-peak 的两倍），
 * 所以 `usd × 比值` 与逐项按 CNY 价算等价。这组断言就是那个前提的守卫 ——
 * 价表抄错一位小数，这里立刻红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canonicalDeepSeekModel,
	cnyFromUsd,
	cnyPerUsdForModel,
	deepSeekRates,
	formatCny,
	formatUsd,
	pricingTierAt,
	tierLabel,
} from "../src/outbound/deepseek-usage.js";

/** UTC 的某个时刻（星期用 dayOffset 表达，避免测试依赖运行机时区）。 */
function utcAt(hour: number, weekday = 3): Date {
	// 2026-09-16 是周三；weekday 参数是 UTC 星期几。
	const base = Date.UTC(2026, 8, 14); // 周一
	return new Date(base + (weekday - 1) * 86_400_000 + hour * 3_600_000);
}

test("P1-03 费率：官方 USD/CNY 两套价必须在同一比例上（比值法成立的前提）", () => {
	for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
		const rates = deepSeekRates(id);
		assert.ok(rates, `${id} 应有官方价表`);
		if (!rates) continue;
		const ratios = [
			rates.cny.input / rates.usd.input,
			rates.cny.cacheRead / rates.usd.cacheRead,
			rates.cny.output / rates.usd.output,
		];
		for (const ratio of ratios) {
			assert.ok(Math.abs(ratio - ratios[0]!) < 1e-9, `${id} 三档比值应一致：${ratios.join(", ")}`);
		}
	}
});

test("P1-03 费率：比值等于官方双币定价（Flash 20/3，Pro 75/11）", () => {
	assert.ok(Math.abs((cnyPerUsdForModel("deepseek-flash") ?? 0) - 20 / 3) < 1e-9);
	assert.ok(Math.abs((cnyPerUsdForModel("deepseek-v4-pro") ?? 0) - 75 / 11) < 1e-9);
});

test("P1-03 费率：旧 id 归一到同一价表，未知模型不给 ¥（宁缺勿错）", () => {
	assert.equal(canonicalDeepSeekModel("deepseek-v4-flash"), "deepseek-flash");
	assert.equal(canonicalDeepSeekModel("deepseek-v4-flash-vision-exp"), "deepseek-flash");
	// 大小写不敏感（provider 层可能给大写）
	assert.equal(canonicalDeepSeekModel("DeepSeek-Flash"), "deepseek-flash");
	// deepseek-chat/reasoner 是另一套旧价，故意不映射
	for (const unknown of ["deepseek-chat", "deepseek-reasoner", "", undefined]) {
		assert.equal(canonicalDeepSeekModel(unknown as string | undefined), undefined);
		assert.equal(cnyPerUsdForModel(unknown as string | undefined), undefined);
		assert.equal(cnyFromUsd(1, unknown as string | undefined), undefined);
	}
});

test("P1-03 折算：金额显示 2 位小数，不足一分钱用 <0.01（不显示假 0）", () => {
	// Flash 比值 20/3：$0.0011 → ¥0.007333…
	const cny = cnyFromUsd(0.0011, "deepseek-flash");
	assert.ok(cny !== undefined && Math.abs(cny - 0.0011 * (20 / 3)) < 1e-12);
	assert.equal(formatCny(cny ?? 0), "<¥0.01", "不足一分钱：说「不到一分」而不是 0");
	assert.equal(formatUsd(0.0011), "<$0.01");
	// 常规金额：2 位小数
	assert.equal(formatCny(620.98), "¥620.98");
	assert.equal(formatCny(0.2867), "¥0.29");
	assert.equal(formatUsd(0.043), "$0.04");
	assert.equal(formatUsd(1.235), "$1.24");
	// 恰好 0（真的没花钱）才显示 0.00
	assert.equal(formatCny(0), "¥0.00");
	assert.equal(formatUsd(0), "$0.00");
});

test("P1-03 档位：peak = UTC [01,04)∪[06,10) 工作日，其余（含周末）off-peak", () => {
	assert.equal(pricingTierAt(utcAt(2)), "peak");
	assert.equal(pricingTierAt(utcAt(3, 5)), "peak"); // 周五
	assert.equal(pricingTierAt(utcAt(1)), "peak"); // 左闭
	assert.equal(pricingTierAt(utcAt(4)), "offPeak"); // 右开
	assert.equal(pricingTierAt(utcAt(6)), "peak");
	assert.equal(pricingTierAt(utcAt(9)), "peak");
	assert.equal(pricingTierAt(utcAt(10)), "offPeak");
	assert.equal(pricingTierAt(utcAt(5)), "offPeak");
	// 周末全天 off-peak
	assert.equal(pricingTierAt(utcAt(2, 6)), "offPeak");
	assert.equal(pricingTierAt(utcAt(2, 0)), "offPeak");
	assert.equal(tierLabel("offPeak"), "off-peak（低谷）");
	assert.equal(tierLabel("peak"), "peak（高峰）");
});
