/**
 * 「始终批准」规则表（pi-permission-system 转发路径）。
 *
 * 背景：PS 的原生对话框有「始终批准」—— 它把模式记进**父会话**的 SessionRules
 * （`approved_for_serving_session`），子会话每次重新转发、由父会话直接批准。
 * 桥不是 PS 的 serving node（它是独立进程，自己写响应文件应答），走不到那条路，
 * 所以要在桥侧自己记一份等价的东西。
 *
 * 粒度取舍：按 **PS 的规则名**（请求里的 `matchedPattern`）记，而不是按命令模式。
 * 理由：规则名是 PS 自己给出的判定依据（审批卡的理由行显示的就是它），
 * 与 PS 的策略语义天然一致；桥不需要自己发明一套模式语言，也就不会和上游跑偏。
 * 代价是粒度偏粗（批准 `echo PS-TEST-*` 会放行所有命中该规则的动作），
 * 所以撤销入口必须存在（见 /feishu always revoke）与审计。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AlwaysApprovedRule {
	/** PS 的规则名（请求 facts.matchedPattern）。 */
	pattern: string;
	/** 批准人 open_id（管理员），审计用。 */
	approvedBy?: string;
	approvedAt: number;
	/** 首次批准时所在的飞书会话（排障用，不参与匹配）。 */
	conversationKey?: string;
}

interface StoreFile {
	version: number;
	rules: AlwaysApprovedRule[];
}

const STORE_VERSION = 1;

export class AlwaysApprovedStore {
	private readonly file: string;
	private rules = new Map<string, AlwaysApprovedRule>();
	private readonly now: () => number;

	constructor(options: { file: string; now?: () => number }) {
		this.file = options.file;
		this.now = options.now ?? Date.now;
		this.load();
	}

	private load(): void {
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
			for (const rule of raw?.rules ?? []) {
				if (typeof rule?.pattern === "string" && rule.pattern) {
					this.rules.set(rule.pattern, {
						pattern: rule.pattern,
						approvedBy: typeof rule.approvedBy === "string" ? rule.approvedBy : undefined,
						approvedAt: typeof rule.approvedAt === "number" ? rule.approvedAt : this.now(),
						conversationKey: typeof rule.conversationKey === "string" ? rule.conversationKey : undefined,
					});
				}
			}
		} catch {
			// 文件不存在/损坏都当作空表：规则表丢了只会让用户重新点一次，
			// 不该因为一份辅助文件把桥启动搞挂。
			this.rules.clear();
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const payload: StoreFile = { version: STORE_VERSION, rules: [...this.rules.values()] };
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(payload, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, this.file);
	}

	/** 规则是否已被「始终批准」。pattern 为空时一律返回 false（没有依据就不自动放行）。 */
	has(pattern: string | null | undefined): boolean {
		if (!pattern) return false;
		return this.rules.has(pattern);
	}

	/** 记录一条「始终批准」。重复批准同一条规则只更新元信息。 */
	add(rule: { pattern: string; approvedBy?: string; conversationKey?: string }): AlwaysApprovedRule {
		const record: AlwaysApprovedRule = {
			pattern: rule.pattern,
			approvedBy: rule.approvedBy,
			approvedAt: this.now(),
			conversationKey: rule.conversationKey,
		};
		this.rules.set(rule.pattern, record);
		this.persist();
		return record;
	}

	/** 撤销一条规则；返回是否真的删掉了。 */
	remove(pattern: string): boolean {
		const existed = this.rules.delete(pattern);
		if (existed) this.persist();
		return existed;
	}

	list(): AlwaysApprovedRule[] {
		return [...this.rules.values()].sort((a, b) => a.approvedAt - b.approvedAt);
	}

	get size(): number {
		return this.rules.size;
	}
}
