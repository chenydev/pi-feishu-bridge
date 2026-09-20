/**
 * 全局默认值（`--global`）：把「模型 / 思考等级」的修改写进 pi 的 settings.json。
 *
 * 为什么写 settings.json 而不是桥自己的 config.json：
 * pi 创建**每个新会话**时读的默认值就是 `defaultModel` / `defaultProvider` /
 * `defaultThinkingLevel`，而桥创建子会话时**没有覆盖**它们（PiSessionBackend
 * 不传 modelId）—— 所以写这里，新会话自然继承，桥不用自己维护一套"默认值"再
 * 手动传给 pi。少一层状态就少一处会不一致的地方。
 *
 * 语义边界（重要）：**只影响之后新建的会话**。已经在跑的会话早就拿着旧的档位/
 * 模型了，改这个文件不会回头改它们。这与 hermes 的 `/reasoning --global` 一致。
 *
 * 写法上坚持「读 → 改 → 原子替换」：
 * - 只覆盖我们管的三个键，其余字段（packages / skills / compaction …）原样保留；
 * - 先写临时文件再 rename，避免写一半被中断留下半截 JSON —— 那是 pi 的启动配置，
 *   写坏了整个 agent 起不来。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GlobalDefaults {
	defaultModel?: string;
	defaultProvider?: string;
	defaultThinkingLevel?: string;
}

/** settings.json 路径（pi 的 PI_CODING_AGENT_DIR 就是桥的 homeDir）。 */
export function settingsPath(homeDir: string): string {
	return join(homeDir, "settings.json");
}

export function readGlobalDefaults(homeDir: string): GlobalDefaults {
	const file = settingsPath(homeDir);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const out: GlobalDefaults = {};
		if (typeof parsed.defaultModel === "string") out.defaultModel = parsed.defaultModel;
		if (typeof parsed.defaultProvider === "string") out.defaultProvider = parsed.defaultProvider;
		if (typeof parsed.defaultThinkingLevel === "string") out.defaultThinkingLevel = parsed.defaultThinkingLevel;
		return out;
	} catch {
		// 读不动就当作没有默认值 —— 调用方会拒绝写入（宁可拒绝，也不要用一份
		// 读不全的配置去覆盖整个 settings.json）
		return {};
	}
}

export interface WriteResult {
	ok: boolean;
	/** 实际写入的键值（便于回执里如实说明） */
	applied?: GlobalDefaults;
	reason?: string;
}

export function writeGlobalDefaults(homeDir: string, patch: GlobalDefaults): WriteResult {
	const file = settingsPath(homeDir);

	let current: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			const raw = readFileSync(file, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { ok: false, reason: "settings.json 不是对象，拒绝覆盖" };
			}
			current = parsed as Record<string, unknown>;
		} catch {
			// **关键安全阀**：解析失败时绝不原地重写 —— 那会把用户的配置整份抹掉。
			return { ok: false, reason: "settings.json 无法解析，拒绝覆盖（请先手工修复）" };
		}
	}

	const applied: GlobalDefaults = {};
	for (const key of ["defaultModel", "defaultProvider", "defaultThinkingLevel"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		current[key] = value;
		applied[key] = value;
	}
	if (Object.keys(applied).length === 0) return { ok: false, reason: "没有要写入的默认值" };

	const tmp = join(dirname(file), `.settings.json.tmp-${process.pid}`);
	try {
		const fd = openSync(tmp, "w", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(current, null, 2)}\n`);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, file);
		return { ok: true, applied };
	} catch (error) {
		try { unlinkSync(tmp); } catch { /* 临时文件可能没建起来 */ }
		return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : "写入失败" };
	}
}

/**
 * 从 `/model <target> --global` 的目标里拆出 provider 与模型 id。
 *
 * 必须同时写 defaultProvider：只写 defaultModel 的话，两个 provider 有同名模型
 * 时 pi 不知道选哪个（这正是 /model 列表里坚持带 provider 前缀的原因）。
 * 没带前缀时**只写 model**，不猜 provider。
 */
export function splitModelTarget(target: string): { model: string; provider?: string } {
	const slash = target.indexOf("/");
	if (slash <= 0 || slash === target.length - 1) return { model: target };
	return { provider: target.slice(0, slash), model: target.slice(slash + 1) };
}
