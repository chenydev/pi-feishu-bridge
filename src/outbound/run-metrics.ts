/**
 * run 级指标与 final 页脚（P1-03）。
 *
 * 口径（对齐 pi 的 UsageTotals）：
 * - usage 按 assistant messageId 去重后累加，跨工具多轮累加；durable 重投不重复累加；
 * - reasoning 是 output 的子集，不重复相加；
 * - cost 是**按模型配置估算**，不是网关账单；缺价显示"未知"，绝不显示假 0；
 * - 耗时用单调时钟（performance.now），不受系统时间跳变影响。
 */
import type { AdaptedUsage } from "./agent-event-adapter.js";

export interface RunUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RunMetrics {
	provider?: string;
	model?: string;
	usage: RunUsageTotals;
	/** 是否至少有一条消息带 cost（否则费用显示"未知"）。 */
	hasCost: boolean;
	cost: number;
	/** 已计入的 assistant messageId（去重，防重投重复累加）。 */
	countedMessages: Set<string>;
	/** 无 messageId 时按事件序计一次（避免同一事件重复计入）。 */
	anonymousCounted: number;
	/** 单调时钟起点（performance.now）。 */
	startMark: number;
	/** 是否有任何 usage 被记录（否则不显示 token 段）。 */
	hasUsage: boolean;
}

const monotonic = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function createRunMetrics(): RunMetrics {
	return {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		hasCost: false, cost: 0,
		countedMessages: new Set<string>(),
		anonymousCounted: 0,
		startMark: monotonic(),
		hasUsage: false,
	};
}

/** 记录一条 assistant message 的用量；重复 messageId 只计一次。 */
export function recordUsage(metrics: RunMetrics, event: {
	messageId?: string; provider?: string; model?: string; usage?: AdaptedUsage;
}): boolean {
	if (event.provider) metrics.provider = event.provider;
	if (event.model) metrics.model = event.model;
	if (!event.usage) return false;
	if (event.messageId) {
		if (metrics.countedMessages.has(event.messageId)) return false;
		metrics.countedMessages.add(event.messageId);
	} else {
		// 无 id 的事件：每次都算一次（调用方按事件流只喂一次），并计数以便诊断。
		metrics.anonymousCounted += 1;
	}
	metrics.usage.input += event.usage.input;
	metrics.usage.output += event.usage.output;
	metrics.usage.cacheRead += event.usage.cacheRead;
	metrics.usage.cacheWrite += event.usage.cacheWrite;
	if (typeof event.usage.cost === "number") {
		metrics.cost += event.usage.cost;
		metrics.hasCost = true;
	}
	metrics.hasUsage = true;
	return true;
}

export function elapsedMs(metrics: RunMetrics): number {
	return Math.max(0, Math.round(monotonic() - metrics.startMark));
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * 渲染 final 页脚。拿不到 usage 时不显示 token/费用段（避免假 0）；
 * 费用一律标注"估算"，缺价显示"未知"。返回空串表示不显示页脚。
 */
export function renderFooter(metrics: RunMetrics, options: { elapsedMs: number; showCost: boolean }): string {
	// 既没有模型也没有用量：耗时单独出现没有信息量，直接不显示页脚。
	if (!metrics.model && !metrics.hasUsage) return "";
	const parts: string[] = [];
	if (metrics.model) parts.push(metrics.model);
	parts.push(formatDuration(options.elapsedMs));
	if (metrics.hasUsage) {
		const { input, output, cacheRead, cacheWrite } = metrics.usage;
		parts.push(`in ${formatTokens(input)} / out ${formatTokens(output)}`);
		const cache = cacheRead + cacheWrite;
		if (cache > 0) parts.push(`cache ${formatTokens(cache)}`);
		if (options.showCost) {
			parts.push(metrics.hasCost ? `$${metrics.cost.toFixed(4)}（估算）` : "费用未知");
		}
	}
	if (parts.length === 0) return "";
	return `———\n${parts.join(" · ")}`;
}
