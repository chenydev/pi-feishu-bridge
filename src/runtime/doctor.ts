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
}): DoctorCheck[] {
	const outboxParent = dirname(input.paths.outboxFile);
	return [
		{ name: "credentials", ok: Boolean(input.config.appId && input.config.appSecret), detail: input.config.appId && input.config.appSecret ? "已配置" : "缺少 appId/appSecret" },
		{ name: "transport", ok: Boolean(input.transport?.isRunning()), detail: input.transport?.isConnected() ? "WS 已连接" : input.transport?.isRunning() ? "运行中但未连接" : "未启动" },
		{ name: "bot_identity", ok: Boolean(input.transport?.getBotIdentity().openId), detail: input.transport?.getBotIdentity().openId ? "已水合" : "未取得 open_id" },
		{ name: "session_dir", ok: existsSync(input.paths.sessionDir) && writable(input.paths.sessionDir), detail: input.paths.sessionDir },
		{ name: "outbox_dir", ok: existsSync(outboxParent) && writable(outboxParent), detail: outboxParent },
		{ name: "permissions", ok: input.config.admins.length > 0, detail: input.config.admins.length > 0 ? `已配置 ${input.config.admins.length} 名管理员` : "未配置管理员，审批将 fail closed" },
	];
}

export function formatDoctor(checks: DoctorCheck[]): string {
	return ["飞书桥诊断：", ...checks.map((check) => `${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`)].join("\n");
}
