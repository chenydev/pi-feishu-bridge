/**
 * `/feishu usage` 卡：本会话累计 + 本轮 run + 账户余额/消耗速率。
 *
 * 分两张信息面（会话 / 账户）而不是混在一起：前者回答"这次聊天花了多少"，
 * 后者回答"钱包还剩多少"，两者的时间尺度完全不同 —— 会话是分钟级、账户是天级。
 *
 * 余额段可能不可用（未配 key / 接口失败）：那时只显示原因，**不隐藏整张卡**，
 * 因为会话用量本身仍然是有价值的信息。
 */
import type { BalanceResult, DeepSeekBalance } from "../outbound/deepseek-balance.js";
import { formatRunway } from "../outbound/deepseek-balance.js";
import { cnyFromUsd, formatCny, formatUsd, tierLabel, type PricingTier } from "../outbound/deepseek-usage.js";
import { formatDuration, formatTokens } from "../outbound/run-metrics.js";

export interface UsageTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface UsageContext {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
}

/** 会话累计（来自 `AgentSession.getSessionStats()`；字段缺失即该项不显示）。 */
export interface SessionUsage {
	tokens?: UsageTokens;
	/** 会话累计费用（USD，pi 口径）。 */
	cost?: number;
	contextUsage?: UsageContext;
	userMessages?: number;
	assistantMessages?: number;
	toolCalls?: number;
}

/** 本轮 run（桥自己的 run 级指标，与页脚同源）。 */
export interface RunUsage {
	model?: string;
	tokens: UsageTokens;
	/** USD；hasCost=false 表示拿不到费用。 */
	cost: number;
	hasCost: boolean;
	elapsedMs: number;
}

/** `/feishu usage` 的数据快照（由 ConversationManager 提供，本模块只负责渲染）。 */
export interface UsageSnapshot {
	modelLabel?: string;
	session?: SessionUsage;
	run?: RunUsage;
}

export interface UsageReportInput {
	/** 形如 `deepseek/deepseek-flash`。 */
	modelLabel?: string;
	tier: PricingTier;
	session?: SessionUsage;
	run?: RunUsage;
	balance: BalanceResult;
	/** 汇总口径：会写进卡片底部说明。 */
	localTimeLabel?: string;
}

function contextLine(context: UsageContext | undefined): string | undefined {
	if (!context) return undefined;
	const { tokens, contextWindow, percent } = context;
	if (typeof tokens !== "number" || typeof contextWindow !== "number" || contextWindow <= 0) return undefined;
	const shownPercent = typeof percent === "number" ? `${percent.toFixed(1)}%` : "—";
	return `${shownPercent}（${formatTokens(tokens)} / ${formatTokens(contextWindow)}）`;
}

function tokenPair(tokens: UsageTokens | undefined): string | undefined {
	if (!tokens) return undefined;
	if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) return undefined;
	return `**${formatTokens(tokens.input)}→${formatTokens(tokens.output)}** tok`;
}

function costText(cost: number | undefined, modelId: string | undefined, tier: PricingTier): string | undefined {
	if (cost === undefined || !(cost > 0)) return undefined;
	const cny = cnyFromUsd(cost, modelId);
	return `**${formatUsd(cost)}${cny === undefined ? "" : ` / ${formatCny(cny)}`}**（估算 · ${tierLabel(tier)}）`;
}

/**
 * 第一段：本会话。与页脚同一套视觉语言（图标分区、数字加粗、同一套 token 口径），
 * 因为这两处回答的是同一类问题，样式一致才不用重新学怎么读。
 *
 * token 口径：输入 = 未命中 + 缓存命中；命中率 = 缓存命中 / 输入侧合计。
 */
export function sessionSectionLines(input: UsageReportInput): string[] {
	const session = input.session;
	const modelId = input.modelLabel?.split("/").pop();
	const lines: string[] = [];
	lines.push(`**本会话**${input.modelLabel ? ` · 模型 \`${input.modelLabel}\`` : ""}`);
	if (input.run) lines.push(`⚡ 最近一轮耗时 **${formatDuration(input.run.elapsedMs)}**`);
	const context = contextLine(session?.contextUsage);
	if (context) lines.push(`🧠 上下文 **${context}**`);
	const tokenSegment = sessionTokensSegment(session?.tokens);
	if (tokenSegment) lines.push(tokenSegment);
	const sessionCost = costText(session?.cost, modelId, input.tier);
	if (sessionCost) lines.push(`💰 累计 ${sessionCost}`);
	else if (session?.tokens) lines.push("💰 累计 费用未知（模型未配置费率）");
	if (session && (session.userMessages !== undefined || session.assistantMessages !== undefined || session.toolCalls !== undefined)) {
		lines.push(`🧾 消息 用户 ${session.userMessages ?? 0} / 助手 ${session.assistantMessages ?? 0} / 工具 ${session.toolCalls ?? 0}`);
	}
	return lines;
}

/** 会话级 token 段（与页脚同一措辞：输入 = 未命中 + 缓存命中）。 */
function sessionTokensSegment(tokens: UsageTokens | undefined): string | undefined {
	if (!tokens) return undefined;
	const uncached = tokens.input;
	const cached = tokens.cacheRead;
	const inputTotal = uncached + cached;
	if (inputTotal + tokens.output <= 0) return undefined;
	const parts = [`输入 **${formatTokens(inputTotal)}**`];
	if (cached > 0) {
		parts.push(`= 未命中 **${formatTokens(uncached)}** + 缓存命中 **${formatTokens(cached)}**（**${((cached / inputTotal) * 100).toFixed(1)}%**）`);
	}
	parts.push(`| 输出 **${formatTokens(tokens.output)}**`);
	return `📊 ${parts.join(" ")}`;
}

/** 第二段：DeepSeek 账户（余额 / 消耗速率 / 预计可用）。 */
export function accountSectionLines(input: UsageReportInput): string[] {
	const balance = input.balance;
	const lines: string[] = ["**账户（DeepSeek）**"];
	if (balance.status === "unavailable") {
		lines.push(`⚠️ 余额不可用：${balance.reason}`);
	} else {
		const info: DeepSeekBalance = balance.balance;
		lines.push(`💳 余额 **${formatCny(info.total)}**`
			+ `${info.currency === "CNY" ? "" : `（${info.currency}）`}`
			+ `（充值 ${formatCny(info.toppedUp)} + 赠送 ${formatCny(info.granted)}）`);
		if (balance.burnRate) {
			const hours = info.total / balance.burnRate.perHour;
			lines.push(`📉 消耗 **${formatCny(balance.burnRate.perHour)}/h**`
				+ `（${balance.burnRate.samples} 快照 / ${formatDuration(balance.burnRate.spanMs)}）`
				+ ` · 预计可用 **≈ ${formatRunway(hours)}**`);
		} else {
			lines.push("📉 消耗速率：样本不足（需 ≥3 快照且跨度 ≥1h，每次查询会累积）");
		}
	}
	const meta = [`🕒 ${tierLabel(input.tier)}`];
	if (input.localTimeLabel) meta.push(input.localTimeLabel);
	if (balance.status === "ok") meta.push(`数据源 GET /user/balance${balance.cached ? "（缓存）" : ""}`);
	lines.push(meta.join(" · "));
	return lines;
}

/** 报告正文行（Markdown）。文本回退复用同一份行，避免两处口径漂移。 */
export function usageReportLines(input: UsageReportInput): string[] {
	return [...sessionSectionLines(input), "", ...accountSectionLines(input)];
}

/** 纯文本回退（卡片发送失败时用）。 */
export function formatUsageReport(input: UsageReportInput): string {
	return usageReportLines(input)
		.map((line) => line.replace(/\*\*/g, "").replace(/`/g, ""))
		.join("\n");
}

/** 卡片（card 2.0；注意 header 是对象本身，不能带 tag）。 */
/** 卡片：两段（会话 / 账户）用分割线分开，与页脚同一套图标+加粗语言。 */
export function buildUsageCard(input: UsageReportInput): unknown {
	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: "用量与余额" }, template: "blue" },
		body: {
			elements: [
				{ tag: "markdown", content: sessionSectionLines(input).join("\n") },
				{ tag: "hr" },
				{ tag: "markdown", text_size: "notation", content: accountSectionLines(input).join("\n") },
			],
		},
	};
}
