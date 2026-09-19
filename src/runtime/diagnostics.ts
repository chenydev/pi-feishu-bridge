/**
 * 可解释诊断摘要与脱敏导出（P2-04）。
 *
 * 目标：把「已连 WS」「有权限」「有 pending」「已最终失败」区分开，缩短故障定位时间。
 *
 * 脱敏约定（硬约束）：
 * - 导出只含**计数与枚举**：绝不包含 appId/appSecret、token、用户正文、审批 token、绝对路径；
 * - 权限类检查在未实际探测时写「未验证」，不假装通过、也不自动发送测试消息；
 * - 导出文件权限 0600，写入失败明确报错。
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "../types.js";

export interface DiagnosticsContext {
	/** 最近一次错误的分类（P0-07 errorClass），无错误时省略。 */
	lastErrorClass?: string;
	outbox?: { pending: number; failed: number; sending?: number; oldestAgeMs?: number };
	conversations?: number;
	pendingApprovals?: number;
	/** P1-07：预算/熔断状态。 */
	budget?: { open: boolean; resumeAt?: number; failures: number };
	piVersion?: string;
	/** 进程运行时长。 */
	uptimeMs?: number;
	/** 传输层状态（bool 安全，不含凭证）。 */
	transport?: { running: boolean; connected: boolean };
}

export interface DiagnosticsBundle {
	generatedAt: string;
	piVersion?: string;
	uptimeMs?: number;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	state: {
		transport: { running: boolean; connected: boolean };
		conversations: number;
		pendingApprovals: number;
		outbox: { pending: number; failed: number; sending: number; oldestAgeMs: number };
		rateBudget: { open: boolean; resumeAt?: string; failures: number };
		lastErrorClass?: string;
	};
	redaction: string;
}

/** 把已知的具体路径替换成占位符（避免导出绝对路径）。 */
function redactPaths(text: string, paths: string[]): string {
	let out = text;
	for (const path of paths) {
		if (!path || path.length < 2) continue;
		out = out.split(path).join("<path>");
	}
	return out;
}

/** 构造脱敏诊断包（纯数据，可直接 JSON 序列化）。 */
export function buildDiagnosticsBundle(input: {
	config: BridgeConfig;
	context: DiagnosticsContext;
	checks: Array<{ name: string; ok: boolean; detail: string }>;
	/** 需要在 detail 中被替换为占位符的路径（如 homeDir）。 */
	redactPaths?: string[];
	now?: () => number;
}): DiagnosticsBundle {
	const now = (input.now ?? Date.now)();
	const { context } = input;
	return {
		generatedAt: new Date(now).toISOString(),
		piVersion: context.piVersion,
		uptimeMs: context.uptimeMs,
		checks: input.checks.map((check) => ({
			name: check.name,
			ok: check.ok,
			detail: redactPaths(check.detail, input.redactPaths ?? []),
		})),
		state: {
			transport: {
				running: Boolean(context.transport?.running),
				connected: Boolean(context.transport?.connected),
			},
			conversations: context.conversations ?? 0,
			pendingApprovals: context.pendingApprovals ?? 0,
			outbox: {
				pending: context.outbox?.pending ?? 0,
				failed: context.outbox?.failed ?? 0,
				sending: context.outbox?.sending ?? 0,
				oldestAgeMs: Math.round(context.outbox?.oldestAgeMs ?? 0),
			},
			rateBudget: {
				open: Boolean(context.budget?.open),
				resumeAt: context.budget?.resumeAt ? new Date(context.budget.resumeAt).toISOString() : undefined,
				failures: context.budget?.failures ?? 0,
			},
			lastErrorClass: context.lastErrorClass,
		},
		redaction: "仅包含计数与枚举；已剔除 appId/appSecret、token、用户正文、审批 token 与绝对路径",
	};
}

/** 写出诊断包（0600）。返回文件路径。 */
export function writeDiagnosticsBundle(homeDir: string, bundle: DiagnosticsBundle): string {
	const dir = join(homeDir, "diagnostics");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `diagnostics-${bundle.generatedAt.replace(/[:.]/g, "-")}.json`);
	writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try { chmodSync(file, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
	return dir;
}
