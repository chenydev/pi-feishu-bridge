/**
 * DeepSeek 账户余额与消耗速率（`GET /user/balance`，非官方文档的公开接口）。
 *
 * 与宿主 `pi-deepseek-balance` 扩展的关系：**思路相同、实现独立**。那个扩展的产物
 * 只进 `ctx.ui.setStatus`（无 TUI 时是空实现，桥读不到）；桥是长驻服务，需要的是
 * 「能主动查一次并把结果渲染进飞书卡片」，所以这里自己实现，但沿用它的两个关键
 * 取舍：
 *   1. 余额是**账户级**信息，变化慢 → 带 TTL 的内存缓存，避免每条命令都打外部接口；
 *   2. 消耗速率/可用时长必须由**历史快照**推导（一次采样只能看到余额，看不到速率）
 *      → 落一份 snapshots jsonl，要求 ≥3 个样本且跨度 ≥1h 才给结论。
 *
 * 失败一律降级成"不可用 + 原因"，不抛异常：余额查不到不该让 `/feishu usage` 整体失败。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEFAULT_BALANCE_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** 快照保留上限（文件行数）。 */
export const SNAPSHOT_KEEP = 500;
/** 估算速率的最小样本数与最小跨度。 */
export const BURN_MIN_SAMPLES = 3;
export const BURN_MIN_SPAN_MS = 60 * 60_000;

export interface DeepSeekBalance {
	currency: string;
	/** 总余额（含赠送）。 */
	total: number;
	granted: number;
	toppedUp: number;
}

export interface BalanceSnapshot {
	/** 采样时刻（epoch ms）。 */
	t: number;
	currency: string;
	total: number;
}

export interface BurnRate {
	currency: string;
	/** 每小时消耗（与余额同币种）。 */
	perHour: number;
	samples: number;
	spanMs: number;
}

export type BalanceResult =
	| { status: "ok"; balance: DeepSeekBalance; burnRate?: BurnRate; cached: boolean }
	| { status: "unavailable"; reason: string };

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** 解析 `/user/balance` 响应体；结构不符返回 undefined。 */
export function parseBalance(body: unknown): DeepSeekBalance | undefined {
	if (!body || typeof body !== "object") return undefined;
	const infos = (body as { balance_infos?: unknown }).balance_infos;
	if (!Array.isArray(infos) || infos.length === 0) return undefined;
	const first = infos[0] as Record<string, unknown> | undefined;
	if (!first || typeof first !== "object") return undefined;
	const total = toNumber(first.total_balance);
	if (total === undefined) return undefined;
	return {
		currency: typeof first.currency === "string" ? first.currency : "CNY",
		total,
		granted: toNumber(first.granted_balance) ?? 0,
		toppedUp: toNumber(first.topped_up_balance) ?? 0,
	};
}

/**
 * 由历史快照估消耗速率：**只累计下降段（消费），忽略上升段（充值）**，再除以跨度。
 *
 * 不用端点法（(首-末)/Δt）：充值会让端点差变成负数，把"在花钱"算成"在赚钱"。
 * 也不用最小二乘：一次充值就能把斜率翻正。逐段取正差值的做法对充值免疫，
 * 代价是它给的是"含待机时间的平均消费率"（这对"还能用多久"恰好是要的口径）。
 * 要求 ≥3 个样本、跨度 ≥1h，且最新一条的币种与样本一致。
 */
export function estimateBurnRate(snapshots: readonly BalanceSnapshot[]): BurnRate | undefined {
	const usable = snapshots.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.total));
	if (usable.length < BURN_MIN_SAMPLES) return undefined;
	const currency = usable[usable.length - 1]?.currency;
	const same = usable.filter((s) => s.currency === currency);
	if (same.length < BURN_MIN_SAMPLES) return undefined;
	const spanMs = (same[same.length - 1]?.t ?? 0) - (same[0]?.t ?? 0);
	if (spanMs < BURN_MIN_SPAN_MS) return undefined;
	let consumed = 0;
	for (let i = 1; i < same.length; i += 1) {
		const delta = (same[i - 1]?.total ?? 0) - (same[i]?.total ?? 0);
		if (delta > 0) consumed += delta;
	}
	if (!(consumed > 0)) return undefined;
	const perHour = consumed / (spanMs / 3_600_000);
	if (!Number.isFinite(perHour) || perHour <= 0) return undefined;
	return { currency: currency ?? "CNY", perHour, samples: same.length, spanMs };
}

export interface BalanceClientDeps {
	/** DeepSeek API key；缺失时直接返回 unavailable。 */
	apiKey?: string | undefined;
	fetchImpl?: typeof fetch;
	/** 缓存窗口；0 表示每次都打接口。 */
	ttlMs?: number;
	timeoutMs?: number;
	/** 快照文件路径（默认 `~/.pi/agent/feishu-bridge/deepseek-balance-snapshots.jsonl`）。 */
	snapshotPath?: string;
	now?: () => number;
	log?: (level: "debug" | "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
}

export interface BalanceClient {
	/** 查余额（带缓存）；失败返回 unavailable，不抛异常。 */
	get(options?: { force?: boolean }): Promise<BalanceResult>;
	/** 当前内存里的快照（诊断/测试用）。 */
	snapshots(): readonly BalanceSnapshot[];
}

function readSnapshots(path: string | undefined): BalanceSnapshot[] {
	if (!path || !existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf8").split("\n");
		const out: BalanceSnapshot[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as BalanceSnapshot;
				if (Number.isFinite(parsed?.t) && Number.isFinite(parsed?.total)) out.push(parsed);
			} catch { /* 单行损坏不影响其余快照 */ }
		}
		return out;
	} catch {
		return [];
	}
}

function writeSnapshots(path: string, snapshots: readonly BalanceSnapshot[]): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const kept = snapshots.slice(-SNAPSHOT_KEEP);
		writeFileSync(path, `${kept.map((s) => JSON.stringify(s)).join("\n")}\n`, { mode: 0o600 });
	} catch { /* 快照是增强信息，写失败只影响速率估算 */ }
}

export function createBalanceClient(deps: BalanceClientDeps): BalanceClient {
	const ttlMs = deps.ttlMs ?? DEFAULT_BALANCE_TTL_MS;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = deps.now ?? (() => Date.now());
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const snapshotPath = deps.snapshotPath;
	const history = readSnapshots(snapshotPath);
	let cached: { at: number; result: BalanceResult } | undefined;

	function record(balance: DeepSeekBalance): void {
		history.push({ t: now(), currency: balance.currency, total: balance.total });
		if (history.length > SNAPSHOT_KEEP) history.splice(0, history.length - SNAPSHOT_KEEP);
		if (snapshotPath) writeSnapshots(snapshotPath, history);
	}

	return {
		snapshots: () => history,
		async get(options) {
			const at = now();
			if (!options?.force && cached && at - cached.at < ttlMs) {
				return cached.result.status === "ok" ? { ...cached.result, cached: true } : cached.result;
			}
			const key = deps.apiKey;
			if (!key) return { status: "unavailable", reason: "未配置 DEEPSEEK_API_KEY，无法查询账户余额" };
			if (typeof fetchImpl !== "function") return { status: "unavailable", reason: "当前运行环境没有 fetch" };
			let response: Response;
			try {
				response = await fetchImpl(BALANCE_URL, {
					headers: {
						Authorization: `Bearer ${key}`,
						Accept: "application/json",
						"User-Agent": "pi-feishu-bridge",
					},
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				const reason = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
					? "余额接口超时"
					: "余额接口请求失败（网络或代理问题）";
				deps.log?.("warn", "feishu.balance.request_failed", { reason });
				return { status: "unavailable", reason };
			}
			if (response.status === 401 || response.status === 403) {
				return { status: "unavailable", reason: "余额接口鉴权失败（API key 无效或无权限）" };
			}
			if (response.status === 429 || response.status >= 500) {
				return { status: "unavailable", reason: `余额接口暂不可用（HTTP ${response.status}）` };
			}
			let body: unknown;
			try {
				body = await response.json();
			} catch {
				return { status: "unavailable", reason: "余额接口响应无法解析" };
			}
			const balance = parseBalance(body);
			if (!balance) return { status: "unavailable", reason: "余额接口响应结构不符合预期" };
			record(balance);
			const burnRate = estimateBurnRate(history);
			const result: BalanceResult = {
				status: "ok", balance, cached: false,
				...(burnRate ? { burnRate } : {}),
			};
			cached = { at, result };
			deps.log?.("debug", "feishu.balance.fetched", {
				currency: balance.currency, total: balance.total, snapshots: history.length,
			});
			return result;
		},
	};
}

/** 「预计可用时长」：余额 / 速率；不足 1 小时按分钟给，≥24 小时用天。 */
export function formatRunway(hours: number): string {
	if (!Number.isFinite(hours) || hours <= 0) return "—";
	if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
	if (hours >= 1) return `${hours.toFixed(1)}h`;
	return `${Math.max(1, Math.round(hours * 60))}min`;
}

/** 追加一行快照到指定文件（供测试/外部集成用；主流程走 client 内部落盘）。 */
export function appendSnapshot(path: string, snapshot: BalanceSnapshot): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
	} catch { /* 忽略 */ }
}
