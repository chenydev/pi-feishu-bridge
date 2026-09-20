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
	/** 「始终批准」规则表（转发路径）。 */
	alwaysApprovedFile: string;
}

export function resolvePaths(homeDir: string): ConfigPaths {
	return {
		configFile: join(homeDir, "feishu-bridge", "config.json"),
		statusFile: join(homeDir, "feishu-bridge", "status.json"),
		sessionDir: join(homeDir, "feishu-bridge", "sessions"),
		outboxFile: join(homeDir, "feishu-bridge", "outbox.jsonl"),
		dedupeFile: join(homeDir, "feishu-bridge", "dedupe.jsonl"),
		knownChatsFile: join(homeDir, "feishu-bridge", "known-chats.json"),
		alwaysApprovedFile: join(homeDir, "feishu-bridge", "ps-always-approved.json"),
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
 * 判断 IANA 时区名是否可用。
 *
 * `Intl.DateTimeFormat` 遇到未知时区会抛 `RangeError` —— 配置里一个拼错的时区名
 * 不该把整个桥弄挂，所以这里先探测再用。
 */
function isValidTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * 解析展示用时区：FEISHU_TIMEZONE > config.json > 容器 TZ > 默认。
 *
 * 三层是有意的：容器 TZ 决定系统级时间（日志、date），config/环境变量让桥的
 * 展示可以被单独覆盖（比如容器是 UTC 但想让用户看到北京时间）。
 * 任何一层给了无效值都跳过，最终兜底到默认值 —— 绝不因为时区配置写错而启动失败。
 */
export function resolveTimezone(
	fileCfg: Pick<Partial<BridgeConfig>, "timezone">,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const candidates = [env.FEISHU_TIMEZONE, fileCfg.timezone, env.TZ, DEFAULT_CONFIG.timezone];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const value = candidate.trim();
		if (value && isValidTimezone(value)) return value;
	}
	return DEFAULT_CONFIG.timezone;
}

/** 按配置时区格式化时间（面向用户的展示用）。时区无效时退回系统默认，绝不抛。 */
export function formatTimeInZone(timestamp: number, timeZone?: string): string {
	try {
		return new Date(timestamp).toLocaleTimeString("zh-CN", {
			timeZone: timeZone ?? DEFAULT_CONFIG.timezone,
			hour12: false,
		});
	} catch {
		return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
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
	if (existsSync(paths.configFile)) {
		try { chmodSync(paths.configFile, 0o600); } catch { /* 只读文件系统仍由后续读取决定是否可用 */ }
	}
	const fileCfg = loadJson<Partial<BridgeConfig>>(paths.configFile) ?? {};
	const merged: BridgeConfig = {
		...DEFAULT_CONFIG,
		...fileCfg,
		// 时区要显式解析：env 的 FEISHU_TIMEZONE 优先于配置文件，跨层兜底到容器 TZ。
		timezone: resolveTimezone(fileCfg, env),
		// 旧版配置可能只保存 enabled/textWindowMs；逐字段合并以继承 V2 上限。
		batch: { ...DEFAULT_CONFIG.batch, ...fileCfg.batch },
		forwarding: { ...DEFAULT_CONFIG.forwarding, ...fileCfg.forwarding },
		approval: {
			...DEFAULT_CONFIG.approval,
			// env 优先：便于在 compose 里声明，不必改仓库配置
			policyEngine: (process.env.FEISHU_BRIDGE_POLICY_ENGINE as "bridge" | "pi-permission-system" | undefined)
				?? fileCfg.approval?.policyEngine
				?? DEFAULT_CONFIG.approval.policyEngine,
			...fileCfg.approval,
			commandPolicy: {
				enabled: fileCfg.approval?.commandPolicy?.enabled ?? DEFAULT_CONFIG.approval.commandPolicy?.enabled ?? true,
				extraReadOnly: fileCfg.approval?.commandPolicy?.extraReadOnly ?? DEFAULT_CONFIG.approval.commandPolicy?.extraReadOnly,
				extraDangerous: fileCfg.approval?.commandPolicy?.extraDangerous ?? DEFAULT_CONFIG.approval.commandPolicy?.extraDangerous,
			},
			// 开关优先级：环境变量 FEISHU_PS_FORWARDING=1/0 > 配置文件 > 默认（关）。
			// 与 streamingCard 同一约定：实验能力必须显式开启。
			forwarding: {
				enabled: envPsForwardingEnabled(env)
					?? fileCfg.approval?.forwarding?.enabled
					?? DEFAULT_CONFIG.approval.forwarding?.enabled
					?? false,
				parentSessionId: fileCfg.approval?.forwarding?.parentSessionId
					?? DEFAULT_CONFIG.approval.forwarding?.parentSessionId,
				// 「始终批准」：env FEISHU_PS_ALWAYS=0 可强制关闭（与其它实验能力同一约定）
				alwaysApprove: envAlwaysApprove(env)
					?? fileCfg.approval?.forwarding?.alwaysApprove
					?? DEFAULT_CONFIG.approval.forwarding?.alwaysApprove
					?? true,
			},
		},
		// 开关优先级：环境变量 FEISHU_STREAMING_CARD=1/true 可强制打开（便于容器里临时实验），
		// 否则读配置；两者都没有则用默认（关）。
		streamingCard: {
			enabled: envStreamingCardEnabled(env)
				?? fileCfg.streamingCard?.enabled
				?? DEFAULT_CONFIG.streamingCard?.enabled
				?? false,
			throttleMs: fileCfg.streamingCard?.throttleMs
				?? DEFAULT_CONFIG.streamingCard?.throttleMs
				?? 1000,
			printFrequencyMs: fileCfg.streamingCard?.printFrequencyMs
				?? DEFAULT_CONFIG.streamingCard?.printFrequencyMs
				?? 50,
			printStep: fileCfg.streamingCard?.printStep
				?? DEFAULT_CONFIG.streamingCard?.printStep
				?? 50,
		},
		runIdleTimeoutMs: fileCfg.runIdleTimeoutMs ?? DEFAULT_CONFIG.runIdleTimeoutMs,
		runMaxDurationMs: fileCfg.runMaxDurationMs ?? DEFAULT_CONFIG.runMaxDurationMs,
		allowBots: fileCfg.allowBots ?? DEFAULT_CONFIG.allowBots,
		reaction: { ...DEFAULT_CONFIG.reaction, ...fileCfg.reaction },
		footer: { ...DEFAULT_CONFIG.footer, ...fileCfg.footer },
		sessionLifecycle: { ...DEFAULT_CONFIG.sessionLifecycle, ...fileCfg.sessionLifecycle },
		progress: { ...DEFAULT_CONFIG.progress, ...fileCfg.progress },
		workspaces: {
			...DEFAULT_CONFIG.workspaces,
			...fileCfg.workspaces,
			aliases: { ...DEFAULT_CONFIG.workspaces?.aliases, ...fileCfg.workspaces?.aliases },
		},
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

/** 环境变量开关：FEISHU_PS_FORWARDING=1|true|yes 打开父会话转发；0|false|no 强制关闭；未设置返回 undefined。 */
/** `FEISHU_PS_ALWAYS`：`0`/`false` 关闭「始终批准」，`1`/`true` 打开；未设 = 交给配置文件。 */
function envAlwaysApprove(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = env.FEISHU_PS_ALWAYS;
	if (raw === undefined || raw === "") return undefined;
	if (raw === "0" || raw.toLowerCase() === "false") return false;
	if (raw === "1" || raw.toLowerCase() === "true") return true;
	return undefined;
}

function envPsForwardingEnabled(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = env.FEISHU_PS_FORWARDING;
	if (raw === undefined || raw === "") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

/** 环境变量开关：FEISHU_STREAMING_CARD=1|true|yes 打开流式卡片；0|false|no 强制关闭；未设置返回 undefined。 */
function envStreamingCardEnabled(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = env.FEISHU_STREAMING_CARD;
	if (raw === undefined || raw === "") return undefined;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}
