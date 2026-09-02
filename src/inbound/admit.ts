/**
 * 准入（admit）与群策略：唯一允许丢弃消息的地方。
 * 对齐 hermes _admit / _allow_group_message：
 * - 全局 groupPolicy（mention/open/disabled/allowlist/blacklist/admin_only）
 * - 每群规则 groupRules（policy/allowlist/blacklist/requireMention 字段继承）
 * - groupPolicyByChat 向后兼容（简单 policy 覆盖）
 * - admins 群内永远放行；allow_bots 默认拒绝（none）
 */
import type { AdmitReason, BridgeConfig, FeishuInboundMessage, GroupPolicy, GroupRule } from "../types.js";

export class LastSentCache {
	private ids: string[] = [];
	constructor(private capacity: number) {}

	record(messageId: string): void {
		this.ids.push(messageId);
		if (this.ids.length > this.capacity) this.ids.splice(0, this.ids.length - this.capacity);
	}

	has(messageId: string): boolean {
		return this.ids.includes(messageId);
	}
}

/** 全局策略：groupPolicyByChat 兼容层 → groupRules → defaultGroupPolicy → groupPolicy */
export function policyForChat(cfg: BridgeConfig, chatId: string): GroupPolicy {
	const simple = cfg.groupPolicyByChat[chatId];
	if (simple) return simple;
	const rule = cfg.groupRules[chatId];
	if (rule?.policy) return rule.policy;
	return cfg.defaultGroupPolicy ?? cfg.groupPolicy;
}

export function ruleForChat(cfg: BridgeConfig, chatId: string): GroupRule | undefined {
	return cfg.groupRules[chatId];
}

/** 该群是否需要 @（hermes require_mention 字段继承：rule.requireMention ?? 全局） */
export function requireMentionForChat(cfg: BridgeConfig, chatId: string): boolean {
	const rule = cfg.groupRules[chatId];
	if (rule?.requireMention !== undefined) return rule.requireMention;
	return cfg.requireMention;
}

/**
 * 准入判定（hermes _admit 两层模型对齐）：
 * 1. 策略层（谁可以发）：admin 豁免；disabled/open/admin_only/allowlist/blacklist
 * 2. mention 层（是否必须 @）：requireMention 默认 true，**admin 也要过**——
 *    hermes 的 admin 只豁免策略层，不豁免 @ 检查。
 */
export function admit(
	cfg: BridgeConfig,
	msg: FeishuInboundMessage,
	mentioned: boolean,
	replyToBot: boolean,
	lastSent: LastSentCache,
): { ok: true } | { ok: false; reason: AdmitReason } {
	// 1. 自身回声/其他 bot（hermes allow_bots 默认 "none"）
	if (msg.isBot) return { ok: false, reason: "bots_disabled" };

	const isGroup = msg.chatType !== "p2p";
	const isAdmin = isGroup && cfg.admins.length > 0 && cfg.admins.includes(msg.senderId);

	if (!isGroup) {
		// DM：白名单空 = 全部放行
		if (cfg.allowUsers.length === 0) return { ok: true };
		return cfg.allowUsers.includes(msg.senderId) ? { ok: true } : { ok: false, reason: "dm_policy_rejected" };
	}

	// ---- 策略层（hermes _allow_group_message；admin 豁免策略） ----
	const rule = ruleForChat(cfg, msg.chatId);
	const policy = policyForChat(cfg, msg.chatId);
	if (!isAdmin) {
		if (policy === "disabled") return { ok: false, reason: "group_policy_rejected" };
		if (policy === "open") { /* 策略层放行 */ }
		else if (policy === "admin_only") {
			return cfg.admins.includes(msg.senderId) ? { ok: true } : { ok: false, reason: "group_policy_rejected" };
		} else if (policy === "allowlist") {
			// 群白名单（allowChats 兼容层）+ 用户白名单（rule.allowlist）
			if (cfg.allowChats.length > 0 && !cfg.allowChats.includes(msg.chatId)) {
				return { ok: false, reason: "not_allowlisted" };
			}
			const allowlist = rule?.allowlist ?? [];
			if (allowlist.length > 0 && !allowlist.includes(msg.senderId)) {
				return { ok: false, reason: "not_allowlisted" };
			}
		} else if (policy === "blacklist") {
			const blacklist = rule?.blacklist ?? [];
			if (blacklist.includes(msg.senderId)) return { ok: false, reason: "group_policy_rejected" };
		}
	}

	// ---- mention 层（hermes：admin 也过 @ 检查） ----
	return checkMention(cfg, msg, mentioned, replyToBot);
}

/** mention 策略检查（hermes require_mention 字段 + groupAlsoOnReply）。 */
function checkMention(
	cfg: BridgeConfig,
	msg: FeishuInboundMessage,
	mentioned: boolean,
	replyToBot: boolean,
): { ok: true } | { ok: false; reason: AdmitReason } {
	const needMention = requireMentionForChat(cfg, msg.chatId);
	if (!needMention) return { ok: true };
	if (mentioned) return { ok: true };
	if (cfg.groupAlsoOnReply && replyToBot) return { ok: true };
	return { ok: false, reason: "bot_not_mentioned" };
}
