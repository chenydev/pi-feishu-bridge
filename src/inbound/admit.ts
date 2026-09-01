/**
 * 准入（admit）与群策略：唯一允许丢弃消息的地方。
 * 设计依据：docs/DESIGN.md §4；参考 hermes FeishuAdapter._admit / _allow_group_message。
 */
import type { AdmitReason, BridgeConfig, FeishuInboundMessage, GroupPolicy } from "../types.js";

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

export function policyForChat(cfg: BridgeConfig, chatId: string): GroupPolicy {
	return cfg.groupPolicyByChat[chatId] ?? cfg.groupPolicy;
}

/**
 * 准入判定。
 * @param msg 规范化后的消息
 * @param mentioned 该消息是否提及 bot（由上层算出，便于测试注入）
 * @param replyToBot 是否回复了本 bot 最近发送的消息
 * @param lastSent 本 bot 已发消息缓存（replyToBot 判定用）
 */
export function admit(
	cfg: BridgeConfig,
	msg: FeishuInboundMessage,
	mentioned: boolean,
	replyToBot: boolean,
	lastSent: LastSentCache,
): { ok: true } | { ok: false; reason: AdmitReason } {
	// 1. 自身回声/其他 bot（防御）
	if (msg.isBot) return { ok: false, reason: "bots_disabled" };

	const isGroup = msg.chatType !== "p2p";

	// 2. 管理员（群内永远放行）
	if (isGroup && cfg.admins.length > 0 && cfg.admins.includes(msg.senderId)) {
		return { ok: true };
	}

	if (!isGroup) {
		// DM：白名单空 = 全部放行
		if (cfg.allowUsers.length === 0) return { ok: true };
		return cfg.allowUsers.includes(msg.senderId) ? { ok: true } : { ok: false, reason: "dm_policy_rejected" };
	}

	// 3. 群消息
	const policy = policyForChat(cfg, msg.chatId);

	if (policy === "disabled") return { ok: false, reason: "group_policy_rejected" };
	if (policy === "allowlist") {
		if (!cfg.allowChats.includes(msg.chatId)) return { ok: false, reason: "not_allowlisted" };
		// 白名单内群继续按 mention 策略（mention 模式仍要求 @）
		const inner = cfg.groupPolicyByChat[msg.chatId] === "open" ? "open" : cfg.groupPolicy;
		if (inner === "open") return { ok: true };
		if (cfg.requireMention && !mentioned && !(cfg.groupAlsoOnReply && replyToBot)) {
			return { ok: false, reason: "bot_not_mentioned" };
		}
		return { ok: true };
	}
	if (policy === "open") return { ok: true };
	// mention 策略
	if (mentioned) return { ok: true };
	if (cfg.groupAlsoOnReply && replyToBot) return { ok: true };
	return { ok: false, reason: "bot_not_mentioned" };
}
