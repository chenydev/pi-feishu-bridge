/**
 * 配置加载：env 优先，config.json 持久化合并（写回保留 groupPolicyByChat 等运行时改动）。
 * 设计依据：docs/DESIGN.md §5。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { BridgeConfig, GroupPolicy } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface ConfigPaths {
	configFile: string;
	statusFile: string;
	sessionDir: string;
	outboxFile: string;
	dedupeFile: string;
	knownChatsFile: string;
}

export function resolvePaths(homeDir: string): ConfigPaths {
	return {
		configFile: join(homeDir, "feishu-bridge", "config.json"),
		statusFile: join(homeDir, "feishu-bridge", "status.json"),
		sessionDir: join(homeDir, "feishu-bridge", "sessions"),
		outboxFile: join(homeDir, "feishu-bridge", "outbox.jsonl"),
		dedupeFile: join(homeDir, "feishu-bridge", "dedupe.jsonl"),
		knownChatsFile: join(homeDir, "feishu-bridge", "known-chats.json"),
	};
}

export function resolveAppLockFile(homeDir: string, appId: string): string {
	const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const identity = createHash("sha256").update(appId).digest("hex").slice(0, 12);
	return join(homeDir, "feishu-bridge", `bridge-${safeAppId.slice(0, 48)}-${identity}.lock`);
}

function parseGroupPolicy(v: unknown): GroupPolicy | undefined {
	if (v === "open" || v === "mention" || v === "disabled" || v === "allowlist" || v === "blacklist" || v === "admin_only") return v;
	return undefined;
}

function toBool(v: unknown, dflt: boolean): boolean {
	if (typeof v === "boolean") return v;
	if (v === "true" || v === "1" || v === "yes") return true;
	if (v === "false" || v === "0" || v === "no") return false;
	return dflt;
}

function loadJson<T>(file: string): T | undefined {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		throw new Error(`invalid JSON config ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function requireGroupPolicy(value: unknown, source: string): GroupPolicy {
	const policy = parseGroupPolicy(value);
	if (!policy) throw new Error(`invalid group policy at ${source}: ${String(value)}`);
	return policy;
}

function requireStringArray(value: unknown, source: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`invalid string array at ${source}`);
	return value;
}

function validateGroupRule(value: unknown, source: string): import("./types.js").GroupRule {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid group rule at ${source}`);
	const raw = value as Record<string, unknown>;
	if (raw.requireMention !== undefined && typeof raw.requireMention !== "boolean") throw new Error(`invalid boolean at ${source}.requireMention`);
	return {
		policy: raw.policy === undefined ? undefined : requireGroupPolicy(raw.policy, `${source}.policy`),
		allowlist: requireStringArray(raw.allowlist, `${source}.allowlist`),
		blacklist: requireStringArray(raw.blacklist, `${source}.blacklist`),
		requireMention: raw.requireMention as boolean | undefined,
	};
}

/**
 * 合并顺序：默认值 < config.json < env。
 * env 键：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_DOMAIN / FEISHU_GROUP_POLICY /
 * FEISHU_GROUP_POLICY_BY_CHAT(JSON) / FEISHU_ALLOW_CHATS(csv) / FEISHU_ALLOW_USERS(csv) /
 * FEISHU_ADMINS(csv) / FEISHU_GROUP_ALSO_ON_REPLY / FEISHU_REQUIRE_MENTION / FEISHU_DEBUG。
 */
export function loadConfig(homeDir: string, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
	const paths = resolvePaths(homeDir);
	if (existsSync(paths.configFile)) {
		try { chmodSync(paths.configFile, 0o600); } catch { /* 只读文件系统仍由后续读取决定是否可用 */ }
	}
	const fileCfg = loadJson<Partial<BridgeConfig>>(paths.configFile) ?? {};
	const merged: BridgeConfig = {
		...DEFAULT_CONFIG,
		...fileCfg,
		// 旧版配置可能只保存 enabled/textWindowMs；逐字段合并以继承 V2 上限。
		batch: { ...DEFAULT_CONFIG.batch, ...fileCfg.batch },
		forwarding: { ...DEFAULT_CONFIG.forwarding, ...fileCfg.forwarding },
		approval: { ...DEFAULT_CONFIG.approval, ...fileCfg.approval },
		reaction: { ...DEFAULT_CONFIG.reaction, ...fileCfg.reaction },
	};
	merged.groupPolicy = requireGroupPolicy((fileCfg as Record<string, unknown>).groupPolicy ?? merged.groupPolicy, "config.groupPolicy");
	if (merged.defaultGroupPolicy !== undefined) merged.defaultGroupPolicy = requireGroupPolicy(merged.defaultGroupPolicy, "config.defaultGroupPolicy");
	for (const [chatId, policy] of Object.entries(merged.groupPolicyByChat)) {
		merged.groupPolicyByChat[chatId] = requireGroupPolicy(policy, `config.groupPolicyByChat.${chatId}`);
	}
	for (const [chatId, rule] of Object.entries(merged.groupRules)) {
		merged.groupRules[chatId] = validateGroupRule(rule, `config.groupRules.${chatId}`);
	}

	// ---- env 覆盖 ----
	if (env.FEISHU_APP_ID) merged.appId = env.FEISHU_APP_ID;
	if (env.FEISHU_APP_SECRET) merged.appSecret = env.FEISHU_APP_SECRET;
	if (env.FEISHU_DOMAIN === "feishu" || env.FEISHU_DOMAIN === "lark") merged.domain = env.FEISHU_DOMAIN;
	if (env.FEISHU_GROUP_POLICY) {
		merged.groupPolicy = requireGroupPolicy(env.FEISHU_GROUP_POLICY, "FEISHU_GROUP_POLICY");
	}
	if (env.FEISHU_GROUP_POLICY_BY_CHAT) {
		try {
			const parsed = JSON.parse(env.FEISHU_GROUP_POLICY_BY_CHAT) as Record<string, unknown>;
			const clean: Record<string, GroupPolicy> = {};
			for (const [k, v] of Object.entries(parsed)) {
				clean[k] = requireGroupPolicy(v, `FEISHU_GROUP_POLICY_BY_CHAT.${k}`);
			}
			merged.groupPolicyByChat = clean;
		} catch (error) {
			throw new Error(`invalid FEISHU_GROUP_POLICY_BY_CHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const csv = (v: string | undefined): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
	if (env.FEISHU_GROUP_RULES) {
		try {
			const parsed = JSON.parse(env.FEISHU_GROUP_RULES) as Record<string, unknown>;
			const clean: Record<string, import("./types.js").GroupRule> = {};
			for (const [k, v] of Object.entries(parsed)) clean[k] = validateGroupRule(v, `FEISHU_GROUP_RULES.${k}`);
			merged.groupRules = clean;
		} catch (error) {
			throw new Error(`invalid FEISHU_GROUP_RULES: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
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
		const tmp = `${paths.configFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, paths.configFile);
		return true;
	} catch {
		return false;
	}
}

export function loadJsonFile<T>(file: string): T | undefined {
	return loadJson<T>(file);
}
