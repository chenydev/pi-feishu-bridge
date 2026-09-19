/**
 * 共享请求预算与熔断（P1-07）。
 *
 * 目标：多会话/流式高负载时减少 API 风暴，把预算优先留给**最终交付**与**审批**，
 * 在平台限频或网络故障时进入冷却（而不是持续重试放大）。
 *
 * 语义边界（刻意保守）：
 * - 只有**易失**通道（live 流式更新）会因预算不足被跳过 —— 它本来就是 best-effort；
 * - `final` / `approval` 不受熔断影响（它们不能丢，宁可慢也不能静默消失）；
 * - 熔断期间 durable 队列（outbox/pending）保持原样：不标记成功、不删除、不改 UUID；
 * - 平台限频返回的 `retryAfterMs` 会写入冷却时间，避免自造数字。
 */
export type BudgetCategory = "live" | "final" | "approval" | "other";

export interface RateBudgetOptions {
	/** 各类别每秒补充令牌数。 */
	rates?: Partial<Record<BudgetCategory, number>>;
	/** 各类别突发上限。 */
	bursts?: Partial<Record<BudgetCategory, number>>;
	/** 连续失败多少次后熔断（默认 3）。 */
	failureThreshold?: number;
	/** 熔断冷却时长（默认 30s；平台给出 retry-after 时取较大值）。 */
	cooldownMs?: number;
	now?: () => number;
}

interface BucketState {
	tokens: number;
	lastRefillAt: number;
	/** 因预算不足被跳过的次数（诊断用）。 */
	rejected: number;
}

export interface BudgetSnapshot {
	/** 熔断是否打开（打开时易失通道停发）。 */
	open: boolean;
	/** 熔断自动恢复时间（毫秒时间戳）。 */
	resumeAt?: number;
	/** 连续失败计数。 */
	failures: number;
	/** 各类别剩余令牌与被拒次数。 */
	categories: Record<string, { tokens: number; rejected: number }>;
}

const DEFAULT_RATES: Record<BudgetCategory, number> = { live: 2, final: 2, approval: 2, other: 1 };

/** final/approval 是硬需求：熔断不影响它们。 */
const PROTECTED: ReadonlySet<BudgetCategory> = new Set<BudgetCategory>(["final", "approval"]);

export class RateBudget {
	private buckets = new Map<BudgetCategory, BucketState>();
	private readonly rates: Record<BudgetCategory, number>;
	private readonly bursts: Partial<Record<BudgetCategory, number>>;
	private readonly failureThreshold: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private failures = 0;
	private resumeAt?: number;
	/** 半开探测：熔断期间只放行一次尝试。 */
	private probeUsed = false;

	constructor(options: RateBudgetOptions = {}) {
		this.rates = { ...DEFAULT_RATES, ...options.rates };
		this.bursts = options.bursts ?? {};
		this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
		this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000);
		this.now = options.now ?? Date.now;
	}

	/**
	 * 尝试获取一个令牌。
	 * - final/approval：始终放行（熔断也不阻断）；
	 * - live/other：熔断打开时拒绝；令牌不足时拒绝并给出建议等待时间。
	 */
	tryAcquire(category: BudgetCategory): { ok: boolean; retryAfterMs?: number; reason?: "cooldown" | "budget" } {
		if (PROTECTED.has(category)) return { ok: true };
		const now = this.now();
		if (this.isOpen(now)) {
			// 半开：放行一次探测请求
			if (!this.probeUsed) {
				this.probeUsed = true;
				return { ok: true };
			}
			return { ok: false, retryAfterMs: Math.max(0, (this.resumeAt ?? now) - now), reason: "cooldown" };
		}
		const bucket = this.bucket(category, now);
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return { ok: true };
		}
		bucket.rejected += 1;
		const rate = Math.max(0.1, this.rates[category]);
		return { ok: false, retryAfterMs: Math.ceil(1_000 / rate), reason: "budget" };
	}

	/** 记录一次 API 结果（成功清零失败计数并关闭熔断）。 */
	record(outcome: { errorClass?: string; retryAfterMs?: number; ok?: boolean }): void {
		const now = this.now();
		if (outcome.ok) {
			this.failures = 0;
			this.resumeAt = undefined;
			this.probeUsed = false;
			return;
		}
		const transient = outcome.errorClass === "rate_limited" || outcome.errorClass === "network" || outcome.errorClass === "server";
		if (!transient) return;
		this.failures += 1;
		if (this.failures < this.failureThreshold) return;
		const cooldown = Math.max(this.cooldownMs, outcome.retryAfterMs ?? 0);
		this.resumeAt = now + cooldown;
		this.probeUsed = false;
	}

	/**
	 * 熔断是否处于冷却期。
	 * 冷却结束即视为半开成功：清除熔断状态、恢复正常预算（后续再失败会重新累计）。
	 */
	isOpen(now: number = this.now()): boolean {
		if (this.resumeAt === undefined) return false;
		if (now >= this.resumeAt) {
			this.resumeAt = undefined;
			this.failures = 0;
			this.probeUsed = false;
			return false;
		}
		return true;
	}

	/** 面向诊断的快照（doctor/status 用）。 */
	snapshot(): BudgetSnapshot {
		const now = this.now();
		const categories: BudgetSnapshot["categories"] = {};
		for (const [name, bucket] of this.buckets) {
			categories[name] = { tokens: Math.floor(this.refill(bucket, name as BudgetCategory, now).tokens), rejected: bucket.rejected };
		}
		for (const name of Object.keys(this.rates) as BudgetCategory[]) {
			if (!categories[name]) categories[name] = { tokens: Math.floor(this.burst(name)), rejected: 0 };
		}
		const open = this.resumeAt !== undefined;
		return {
			open,
			resumeAt: open ? this.resumeAt : undefined,
			failures: this.failures,
			categories,
		};
	}

	/** 恢复提示文案（用户可见；无熔断时返回 undefined）。 */
	cooldownNotice(): string | undefined {
		if (this.resumeAt === undefined) return undefined;
		const remaining = Math.max(0, this.resumeAt - this.now());
		return `限流冷却中，约 ${Math.ceil(remaining / 1_000)} 秒后恢复（最终交付不受影响）`;
	}

	private burst(category: BudgetCategory): number {
		return this.bursts[category] ?? 4;
	}

	private bucket(category: BudgetCategory, now: number): BucketState {
		const existing = this.buckets.get(category);
		if (existing) return this.refill(existing, category, now);
		const created: BucketState = { tokens: this.burst(category), lastRefillAt: now, rejected: 0 };
		this.buckets.set(category, created);
		return created;
	}

	private refill(bucket: BucketState, category: BudgetCategory, now: number): BucketState {
		const elapsed = Math.max(0, now - bucket.lastRefillAt);
		const rate = this.rates[category];
		if (elapsed > 0 && rate > 0) {
			bucket.tokens = Math.min(this.burst(category), bucket.tokens + (elapsed / 1_000) * rate);
			bucket.lastRefillAt = now;
		}
		return bucket;
	}
}
