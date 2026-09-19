import { accessSync, constants, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "../types.js";
import type { ConfigPaths } from "../config.js";

export interface DoctorCheck { name: string; ok: boolean; detail: string }

function writable(path: string): boolean {
	const probe = join(path, `.feishu-doctor-${process.pid}-${randomUUID()}.tmp`);
	try {
		accessSync(path, constants.W_OK);
		const fd = openSync(probe, "wx", 0o600);
		closeSync(fd);
		unlinkSync(probe);
		return true;
	} catch {
		try { unlinkSync(probe); } catch { /* best effort */ }
		return false;
	}
}

export function runDoctor(input: {
	config: BridgeConfig;
	paths: ConfigPaths;
	transport?: { isRunning(): boolean; isConnected(): boolean; getBotIdentity(): { openId?: string } };
	/** P2-04：诊断上下文（缺省时相关项写「未验证」，而不是假通过）。 */
	diagnostics?: {
		lastErrorClass?: string;
		outbox?: { pending: number; failed: number; oldestAgeMs?: number };
		pendingApprovals?: number;
		budget?: { open: boolean; resumeAt?: number; failures: number };
		piVersion?: string;
	};
}): DoctorCheck[] {
	const outboxParent = dirname(input.paths.outboxFile);
	const diag = input.diagnostics;
	const backlogLines: DoctorCheck[] = [];
	if (diag?.outbox) {
		const { pending, failed, oldestAgeMs } = diag.outbox;
		backlogLines.push({
			name: "backlog",
			ok: failed === 0,
			detail: `pending ${pending} / failed ${failed} / oldest ${Math.round((oldestAgeMs ?? 0) / 1000)}s`,
		});
	}
	if (diag) {
		backlogLines.push({
			name: "error_state",
			ok: !diag.lastErrorClass,
			detail: diag.lastErrorClass ? `最近错误类别：${diag.lastErrorClass}` : "无未处理错误",
		});
		if (diag.budget) {
			backlogLines.push({
				name: "rate_budget",
				ok: !diag.budget.open,
				detail: diag.budget.open
					? `限流冷却中（连续失败 ${diag.budget.failures}，恢复约 ${Math.max(0, Math.round((diag.budget.resumeAt ?? 0) - Date.now()) / 1000)}s；final/审批不受影响）`
					: `正常（连续失败 ${diag.budget.failures}）`,
			});
		}
		backlogLines.push({
			name: "pending_work",
			ok: (diag.pendingApprovals ?? 0) === 0,
			detail: diag.pendingApprovals ? `${diag.pendingApprovals} 个审批等待处理` : "无待审批",
		});
	}
	return [
		{ name: "credentials", ok: Boolean(input.config.appId && input.config.appSecret), detail: input.config.appId && input.config.appSecret ? "已配置" : "缺少 appId/appSecret" },
		{ name: "transport", ok: Boolean(input.transport?.isRunning()), detail: input.transport?.isConnected() ? "WS 已连接" : input.transport?.isRunning() ? "运行中但未连接" : "未启动" },
		{ name: "bot_identity", ok: Boolean(input.transport?.getBotIdentity().openId), detail: input.transport?.getBotIdentity().openId ? "已水合" : "未取得 open_id" },
		{ name: "session_dir", ok: existsSync(input.paths.sessionDir) && writable(input.paths.sessionDir), detail: input.paths.sessionDir },
		{ name: "outbox_dir", ok: existsSync(outboxParent) && writable(outboxParent), detail: outboxParent },
		{ name: "permissions", ok: input.config.admins.length > 0, detail: input.config.admins.length > 0 ? `已配置 ${input.config.admins.length} 名管理员` : "未配置管理员，审批将 fail closed" },
		// P2-04：权限范围在未实际探测前写「未验证」，不假装通过，也不自动发送测试消息
		{ name: "feishu_scopes", ok: false, detail: "未验证（需要真实调用才能确认租户权限；本诊断不会发送测试消息）" },
		{ name: "runtime", ok: true, detail: input.diagnostics?.piVersion ? `Pi ${input.diagnostics.piVersion}` : "Pi 版本未提供" },
		...backlogLines,
	];
}

export function formatDoctor(checks: DoctorCheck[]): string {
	return ["飞书桥诊断：", ...checks.map((check) => `${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`)].join("\n");
}
