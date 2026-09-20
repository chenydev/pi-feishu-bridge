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
import { formatCny, formatUsd } from "./deepseek-usage.js";

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

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	// 长任务（>1h）用小时：`180m00s` 这种写法无法一眼读出量级。
	if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export interface FooterContextUsage {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
}

export interface FooterOptions {
	elapsedMs: number;
	showCost: boolean;
	/** 本轮模型（优先于 metrics.model；会话层拿到时用会话的） */
	model?: string;
	/** 是否在 $ 后附 ¥（默认关；由调用方按配置打开）。 */
	showCny?: boolean;
	/** CNY/USD 比值（由官方两套价推导，见 deepseek-usage.ts）；缺失则不显示 ¥。 */
	cnyPerUsd?: number;
	/** 当前上下文占用（拿不到时不显示该段）。 */
	context?: FooterContextUsage;
	/**
	 * 会话累计：页脚的主要信息源（token/缓存/命中率/费用都取自这里）。
	 *
	 * 为什么以会话为准：本轮的 token 数字小、口径又容易与会话累计混读；用户看页脚
	 * 想回答的是"这次聊天花了多少"，而不是"这句话花了多少"。
	 */
	session?: {
		tokens?: RunUsageTotals;
		/** 会话累计费用（USD）。 */
		cost?: number;
	};
}

function contextSegment(context: FooterContextUsage | undefined): string | undefined {
	if (!context) return undefined;
	const { tokens, contextWindow, percent } = context;
	if (typeof tokens !== "number" || typeof contextWindow !== "number" || contextWindow <= 0) return undefined;
	const shown = typeof percent === "number" ? `${percent.toFixed(1)}%` : "—";
	return `${shown}（${formatTokens(tokens)} / ${formatTokens(contextWindow)}）`;
}

/** 费用段：缺价（或 0 费率）显示"未知"，有价则 USD + 可选 ¥，一律标"估算"。 */
function costSegment(cost: number | undefined, options: { showCost: boolean; showCny?: boolean; cnyPerUsd?: number }): string {
	if (!options.showCost) return "";
	if (cost === undefined || !(cost > 0)) return "费用未知";
	const text = formatUsd(cost);
	const cny = options.showCny && options.cnyPerUsd ? cost * options.cnyPerUsd : undefined;
	return `${text}${cny === undefined ? "" : ` / ${formatCny(cny)}`}（估算）`;
}

/**
 * 把页脚/报告的 markdown 标记去掉（文本消息不解析 markdown）。
 *
 * 页脚在**卡片**里是 markdown 元素（加粗能生效），走**文本通道**时加粗只是字面
 * 星号 —— 所以发给文本通道前必须先剥掉，否则用户看到 `**1.8s**`。
 */
export function stripMarkdown(text: string): string {
	return text.replace(/\*\*/g, "").replace(/`/g, "");
}

/** 页脚行的开头（emoji 版 + 旧文字版都认，便于跨版本剥离）。 */
const FOOTER_LINE_PREFIX = /^(本轮|会话|⚡|🗃|🧠|📊|💰)\s/;

/** 会话级 token 段：输入（= 未命中 + 缓存命中）+ 命中率 + 输出。 */
function sessionTokenSegment(tokens: RunUsageTotals): string | undefined {
	const uncached = tokens.input;
	// 缓存写入极少（DeepSeek 免费且不单列），并入"缓存命中"会让口径变糊 —— 只算读
	const cached = tokens.cacheRead;
	const inputTotal = uncached + cached;
	if (inputTotal + tokens.output <= 0) return undefined;
	const parts = [`输入 **${formatTokens(inputTotal)}**`];
	if (cached > 0) {
		const hit = (cached / inputTotal) * 100;
		parts.push(`= 未命中 **${formatTokens(uncached)}** + 缓存命中 **${formatTokens(cached)}**（**${hit.toFixed(1)}%**）`);
	}
	parts.push(`| 输出 **${formatTokens(tokens.output)}**`);
	return `📊 本会话 ${parts.join(" ")}`;
}

/**
 * 渲染 final 页脚（图标分区，三行）。
 *
 * 口径（与用户确认过）：
 * - **token/缓存/命中率/金额全部是会话级**（这次聊天一共多少），不是本轮 —— 本轮的
 *   token 数字太小、又容易与会话累计混读，价值低；
 * - **本轮只留模型 + 耗时**（耗时只有按轮算才有意义）；
 * - 命中率 = 缓存命中 / 输入侧合计（对应状态栏里的 `R/(U+R)`）。
 *
 * 原则与旧版一致：拿不到 usage 就不显示该段（不显示假 0）；费用一律标"估算"。
 */
export function renderFooter(metrics: RunMetrics, options: FooterOptions): string {
	const model = options.model ?? metrics.model;
	// 既没模型（说不清是谁答的）也没会话累计（一个数字都没有）：页脚毫无信息量
	if (!model && !options.session) return "";
	const lines: string[] = [];

	// ⚡ 本轮：模型 · 耗时 · 当前上下文占用
	const head: string[] = [];
	if (model) head.push(model);
	head.push(`**${formatDuration(options.elapsedMs)}**`);
	const context = contextSegment(options.context);
	if (context) head.push(`上下文 **${context}**`);
	if (head.length > 0) lines.push(`⚡ ${head.join(" · ")}`);

	// 📊 本会话累计 token（输入 = 未命中 + 缓存命中，带命中率）
	const tokens = options.session?.tokens;
	if (tokens) {
		const segment = sessionTokenSegment(tokens);
		if (segment) lines.push(segment);
	}

	// 💰 本会话累计费用（不再计算本轮金额）
	if (options.session) {
		const cost = costSegment(options.session.cost, options);
		if (cost) lines.push(`💰 本会话 **${cost}**`);
	}

	if (lines.length === 0) return "";
	return `———\n${lines.join("\n")}`;
}

/**
 * 从「被引用消息原文」里去掉桥自己加的页脚块。
 *
 * 为什么需要：用户**引用回复**时，桥会把被引用消息前 500 字注入提示词
 * （conversation-manager 的 replyToText 分支）—— 而页脚本来只是给人看的元信息，
 * 不该每轮都花掉几十个 token 去喂模型。
 *
 * 保守判定：必须有 `———` 单独一行，且其后每行都是「本轮/会话」开头或空行，才当作页脚
 * 剔除 —— 正文里碰巧出现分割线不会被误删。
 */
export function stripFooterFromQuote(text: string, knownFooters?: Iterable<string>): string {
	// ① 精确层：我们自己发过的页脚原文（`ConversationManager` 记住最近若干条）。
	//    按整段后缀匹配，命中的话是"删掉我们确定写进去的那段"，零猜测。
	const trimmed = text.trimEnd();
	if (knownFooters) {
		for (const footer of knownFooters) {
			const candidate = footer.trim();
			if (candidate && trimmed.endsWith(candidate)) {
				return trimmed.slice(0, trimmed.length - candidate.length).trimEnd();
			}
		}
	}

	// ② 兜底层：按行形态删。页脚每一行的行首图标都是桥生成的（见 renderFooter），
	//    因此"行首匹配 FOOTER_LINE_PREFIX 就删整行"是**超集**判定 —— 宁可多删一行，
	//    也不让元信息进模型上下文（引用块里这行本来也没有语义价值）。
	const kept = text
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			if (t === "") return true;
			if (t === "———") return false;          // 旧版的字面分割线标记
			return !FOOTER_LINE_PREFIX.test(t);
		});
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

