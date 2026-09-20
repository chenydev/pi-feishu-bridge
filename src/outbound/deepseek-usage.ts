/**
 * DeepSeek 官方费率与分时档位（peak / off-peak）—— 页脚 ¥ 折算与 usage 报告共用。
 *
 * 为什么需要它：pi 的 `usage.cost` 只有 USD，而看账单用的是 CNY。DeepSeek 官方价
 * 页**同时给出 USD 与 CNY 两套价**（不是汇率折算），并且两套价里 peak 都恰好是
 * off-peak 的 2 倍（官方规则）。于是同一模型两套价的比值是常数，`usd × 比值`
 * 与「按 CNY 价表逐项算」结果完全一致（分时档位也一并正确，因为 peak/off-peak
 * 在两套价里同比放大）。比值由价表本身推导，不写死 —— 见 tests 里的一致性检查。
 *
 * 费率来源：https://api-docs.deepseek.com/quick_start/pricing（2026-09 口径，
 * 与宿主 pi-deepseek-cost / pi-deepseek-pricing-by-time 的价表一致）。下表记的是
 * **off-peak** 单价（USD / CNY，每 1M token）；peak 用不到（比值法自动覆盖）。
 */

export interface DeepSeekRateSet {
	/** cache-miss input，每 1M token。 */
	input: number;
	/** cache-hit input，每 1M token。 */
	cacheRead: number;
	/** output，每 1M token。 */
	output: number;
	/** cache write（DeepSeek 免费）。 */
	cacheWrite: number;
}

export interface DeepSeekModelRates {
	usd: DeepSeekRateSet;
	cny: DeepSeekRateSet;
}

/** 官方价表（off-peak）。模型 id 为 canonical id。 */
const MODEL_RATES: Readonly<Record<string, DeepSeekModelRates>> = {
	// DeepSeek-V4.1-Flash（2026-09-10 上线）。USD $0.15/$0.003/$0.60，CNY ¥1/¥0.02/¥4。
	"deepseek-flash": {
		usd: { input: 0.15, cacheRead: 0.003, output: 0.6, cacheWrite: 0 },
		cny: { input: 1, cacheRead: 0.02, output: 4, cacheWrite: 0 },
	},
	// DeepSeek-V4-Pro（0813）。USD $0.66/$0.022/$1.98，CNY ¥4.5/¥0.15/¥13.5。
	"deepseek-v4-pro": {
		usd: { input: 0.66, cacheRead: 0.022, output: 1.98, cacheWrite: 0 },
		cny: { input: 4.5, cacheRead: 0.15, output: 13.5, cacheWrite: 0 },
	},
};

/**
 * 仍在服务、但按 Flash 计费的旧 id（官方定价页注 1）。
 *
 * 只放「确认按同一价表计费」的别名：`deepseek-chat` / `deepseek-reasoner` 是另一套
 * 旧 Flash 价，故意不在此表 —— 宁可页脚不显示 ¥，也不显示错的 ¥。
 */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
	"deepseek-v4-flash": "deepseek-flash",
	"deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/** off-peak 时段（UTC 整点）：[01,04) ∪ [06,10)，周一至周五；其余时间含周末全程 off-peak。 */
export const PEAK_UTC_HOURS: ReadonlySet<number> = new Set([1, 2, 3, 6, 7, 8, 9]);

export type PricingTier = "peak" | "offPeak";

/** 某个时刻属于哪个计费档位（官方口径按 UTC 判定）。 */
export function pricingTierAt(date: Date): PricingTier {
	const day = date.getUTCDay(); // 0=周日, 6=周六
	if (day === 0 || day === 6) return "offPeak";
	return PEAK_UTC_HOURS.has(date.getUTCHours()) ? "peak" : "offPeak";
}

/** 解析到 canonical id；未知模型返回 undefined（调用方据此不显示 ¥）。 */
export function canonicalDeepSeekModel(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	const id = modelId.trim().toLowerCase();
	const canonical = MODEL_ALIASES[id] ?? id;
	return MODEL_RATES[canonical] ? canonical : undefined;
}

/** 取某模型的官方两套价（off-peak）；未知模型返回 undefined。 */
export function deepSeekRates(modelId: string | undefined): DeepSeekModelRates | undefined {
	const canonical = canonicalDeepSeekModel(modelId);
	return canonical ? MODEL_RATES[canonical] : undefined;
}

/**
 * CNY / USD 单价比值（官方两套价推导，见文件头）。未知模型返回 undefined。
 *
 * 用三个分项分别求比值并取输入项：三者在官方价表里必须一致，不一致说明价表抄错了
 * —— 这一点由 `tests/deepseek-usage.test.ts` 断言。
 */
export function cnyPerUsdForModel(modelId: string | undefined): number | undefined {
	const canonical = canonicalDeepSeekModel(modelId);
	if (!canonical) return undefined;
	const rates = MODEL_RATES[canonical];
	if (!rates || rates.usd.input <= 0) return undefined;
	return rates.cny.input / rates.usd.input;
}

/** 把 run 的 USD 成本折算成 ¥；模型未知时返回 undefined（宁可不显示）。 */
export function cnyFromUsd(usd: number, modelId: string | undefined): number | undefined {
	const ratio = cnyPerUsdForModel(modelId);
	if (ratio === undefined || !Number.isFinite(usd)) return undefined;
	return usd * ratio;
}

/**
 * 金额格式化（页脚与 usage 卡共用）。
 *
 * 口径：**2 位小数**；不足 1 分钱时显 `<0.01` 而不是 `0.00` —— 后者是假 0
 * （与「拿不到费用就显示未知」同一原则：宁可说"不到一分钱"，不说"没花钱"）。
 */
export function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

export function formatCny(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "¥0.00";
	return value < 0.01 ? "<¥0.01" : `¥${value.toFixed(2)}`;
}

/** 档位标签（报告卡用；页脚不显示，避免每轮变长）。 */
export function tierLabel(tier: PricingTier): string {
	return tier === "peak" ? "peak（高峰）" : "off-peak（低谷）";
}
