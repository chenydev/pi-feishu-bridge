/**
 * 配置加载：env 优先，config.json 持久化合并（写回保留 groupPolicyByChat 等运行时改动）。
 * 设计依据：docs/DESIGN.md §5。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeConfig, GroupPolicy } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface ConfigPaths {
	configFile: string;
	statusFile: string;
	sessionDir: string;
	outboxFile: string;
}

export function resolvePaths(homeDir: string): ConfigPaths {
	return {
		configFile: join(homeDir, "feishu-bridge", "config.json"),
		statusFile: join(homeDir, "feishu-bridge", "status.json"),
		sessionDir: join(homeDir, "feishu-bridge", "sessions"),
		outboxFile: join(homeDir, "feishu-bridge", "outbox.jsonl"),
	};
}

function parseGroupPolicy(v: unknown): GroupPolicy | undefined {
	if (v === "open" || v === "mention" || v === "disabled" || v === "allowlist") return v;
	return undefined;
}

function toBool(v: unknown, dflt: boolean): boolean {
	if (typeof v === "boolean") return v;
	if (v === "true" || v === "1" || v === "yes") return true;
	if (v === "false" || v === "0" || v === "no") return false;
	return dflt;
}

function loadJson<T>(file: string): T | undefined {
	try {
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/**
 * 合并顺序：默认值 < config.json < env。
 * env 键：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_DOMAIN / FEISHU_GROUP_POLICY /
 * FEISHU_GROUP_POLICY_BY_CHAT(JSON) / FEISHU_ALLOW_CHATS(csv) / FEISHU_ALLOW_USERS(csv) /
 * FEISHU_ADMINS(csv) / FEISHU_GROUP_ALSO_ON_REPLY / FEISHU_REQUIRE_MENTION / FEISHU_DEBUG。
 */
export function loadConfig(homeDir: string, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
	const paths = resolvePaths(homeDir);
	const fileCfg = loadJson<Partial<BridgeConfig>>(paths.configFile) ?? {};
	const merged: BridgeConfig = { ...DEFAULT_CONFIG, ...fileCfg };

	// ---- env 覆盖 ----
	if (env.FEISHU_APP_ID) merged.appId = env.FEISHU_APP_ID;
	if (env.FEISHU_APP_SECRET) merged.appSecret = env.FEISHU_APP_SECRET;
	if (env.FEISHU_DOMAIN === "feishu" || env.FEISHU_DOMAIN === "lark") merged.domain = env.FEISHU_DOMAIN;
	if (env.FEISHU_GROUP_POLICY) {
		const p = parseGroupPolicy(env.FEISHU_GROUP_POLICY);
		if (p) merged.groupPolicy = p;
	}
	if (env.FEISHU_GROUP_POLICY_BY_CHAT) {
		try {
			const parsed = JSON.parse(env.FEISHU_GROUP_POLICY_BY_CHAT) as Record<string, unknown>;
			const clean: Record<string, GroupPolicy> = {};
			for (const [k, v] of Object.entries(parsed)) {
				const p = parseGroupPolicy(v);
				if (p) clean[k] = p;
			}
			merged.groupPolicyByChat = clean;
		} catch {
			/* 忽略非法 env JSON */
		}
	}
	const csv = (v: string | undefined): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
	if (env.FEISHU_ALLOW_CHATS) merged.allowChats = csv(env.FEISHU_ALLOW_CHATS);
	if (env.FEISHU_ALLOW_USERS) merged.allowUsers = csv(env.FEISHU_ALLOW_USERS);
	if (env.FEISHU_ADMINS) merged.admins = csv(env.FEISHU_ADMINS);
	if (env.FEISHU_GROUP_ALSO_ON_REPLY) merged.groupAlsoOnReply = toBool(env.FEISHU_GROUP_ALSO_ON_REPLY, merged.groupAlsoOnReply);
	if (env.FEISHU_REQUIRE_MENTION) merged.requireMention = toBool(env.FEISHU_REQUIRE_MENTION, merged.requireMention);
	if (env.FEISHU_DEBUG) merged.debug = toBool(env.FEISHU_DEBUG, merged.debug);
	if (env.FEISHU_HOME_DIR) {
		// 允许测试注入 home
		const alt = resolvePaths(env.FEISHU_HOME_DIR);
		return { ...merged, sessionDir: alt.sessionDir };
	}
	return merged;
}

/**
 * 保存配置到 config.json（保留 groupPolicyByChat 等运行时字段）。
 * 失败静默（只读文件系统不阻塞启动）。
 */
export function saveConfig(homeDir: string, cfg: BridgeConfig): boolean {
	try {
		const paths = resolvePaths(homeDir);
		mkdirSync(dirname(paths.configFile), { recursive: true });
		writeFileSync(paths.configFile, JSON.stringify(cfg, null, 2), { encoding: "utf8" });
		return true;
	} catch {
		return false;
	}
}

export function loadJsonFile<T>(file: string): T | undefined {
	return loadJson<T>(file);
}
