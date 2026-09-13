/**
 * admit 单元测试：策略矩阵（open/mention/disabled/allowlist、管理员、DM、回复免 @）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, LastSentCache, policyForChat, requireMentionForChat } from "../src/inbound/admit.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";
import type { FeishuInboundMessage } from "../src/types.js";

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, ...over };
}

function groupMsg(over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return {
		messageId: "om_1",
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_user",
		isBot: false,
		msgType: "text",
		text: "hi",
		mentions: [],
		resources: [],
		ts: Date.now(),
		raw: undefined,
		...over,
	};
}

test("mention 策略：@ 放行", () => {
	const c = cfg({ groupPolicy: "mention" });
	assert.equal(admit(c, groupMsg(), true, false, new LastSentCache(8)).ok, true);
});

test("mention 策略：未 @ 拒绝", () => {
	const c = cfg({ groupPolicy: "mention" });
	const r = admit(c, groupMsg(), false, false, new LastSentCache(8));
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "bot_not_mentioned");
});

test("mention 策略：回复 bot 消息免 @（groupAlsoOnReply）", () => {
	const c = cfg({ groupPolicy: "mention", groupAlsoOnReply: true });
	const cache = new LastSentCache(8);
	cache.record("om_bot_sent");
	const msg = groupMsg({ replyToMessageId: "om_bot_sent" });
	assert.equal(admit(c, msg, false, true, cache).ok, true);
});

test("mention 策略：回复非 bot 消息仍拒绝", () => {
	const c = cfg({ groupPolicy: "mention", groupAlsoOnReply: true });
	const cache = new LastSentCache(8);
	cache.record("om_bot_sent");
	const msg = groupMsg({ replyToMessageId: "om_other_msg" });
	assert.equal(admit(c, msg, false, false, cache).ok, false);
});

test("open 策略：策略层放行，但 mention 层仍检查（hermes 两层模型）", () => {
	const c = cfg({ groupPolicy: "open" }); // requireMention 默认 true
	assert.equal(admit(c, groupMsg(), true, false, new LastSentCache(8)).ok, true); // @ 放行
	assert.equal(admit(c, groupMsg(), false, false, new LastSentCache(8)).ok, false); // 未 @ 拒绝
	// requireMention=false 时 open 全放行
	const c2 = cfg({ groupPolicy: "open", requireMention: false });
	assert.equal(admit(c2, groupMsg(), false, false, new LastSentCache(8)).ok, true);
});

test("disabled 策略：全部拒绝", () => {
	const c = cfg({ groupPolicy: "disabled" });
	assert.equal(admit(c, groupMsg(), true, false, new LastSentCache(8)).ok, false);
});

test("管理员也要 @（hermes：admin 只豁免策略层，不豁免 mention）", () => {
	const c = cfg({ groupPolicy: "mention", admins: ["ou_admin"] });
	const msg = groupMsg({ senderId: "ou_admin" });
	assert.equal(admit(c, msg, true, false, new LastSentCache(8)).ok, true); // @ 放行
	assert.equal(admit(c, msg, false, false, new LastSentCache(8)).ok, false); // 未 @ 拒绝
	// admin 豁免策略层：disabled/admin_only 下 admin 放行（mention 仍查）
	const c2 = cfg({ groupPolicy: "admin_only", admins: ["ou_admin"] });
	assert.equal(admit(c2, msg, true, false, new LastSentCache(8)).ok, true);
});

test("allowlist 策略：非白名单群拒绝", () => {
	const c = cfg({ groupPolicy: "allowlist", allowChats: ["oc_ok"] });
	assert.equal(admit(c, groupMsg(), true, false, new LastSentCache(8)).ok, false);
});

test("allowlist 策略：白名单群 + mention 放行", () => {
	const c = cfg({ groupPolicy: "allowlist", allowChats: ["oc_group"] });
	assert.equal(admit(c, groupMsg(), true, false, new LastSentCache(8)).ok, true);
});

test("groupPolicyByChat 覆盖全局（open）——策略层 open 但仍需 @（mention 层独立）", () => {
	const c = cfg({ groupPolicy: "mention", groupPolicyByChat: { oc_group: "open" } });
	assert.equal(policyForChat(c, "oc_group"), "open");
	assert.equal(admit(c, groupMsg(), true, false, new LastSentCache(8)).ok, true); // @ 放行
	assert.equal(admit(c, groupMsg(), false, false, new LastSentCache(8)).ok, false); // 未 @ 拒绝
});

test("DM：白名单空 = 全放行", () => {
	const c = cfg({});
	const msg = groupMsg({ chatType: "p2p" });
	assert.equal(admit(c, msg, false, false, new LastSentCache(8)).ok, true);
});

test("DM：白名单命中", () => {
	const c = cfg({ allowUsers: ["ou_user"] });
	assert.equal(admit(c, groupMsg({ chatType: "p2p" }), false, false, new LastSentCache(8)).ok, true);
});

test("DM：白名单未命中拒绝", () => {
	const c = cfg({ allowUsers: ["ou_other"] });
	const r = admit(c, groupMsg({ chatType: "p2p" }), false, false, new LastSentCache(8));
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.reason, "dm_policy_rejected");
});

test("bot 消息一律拒绝（防回声）", () => {
	const c = cfg({ groupPolicy: "open" });
	assert.equal(admit(c, groupMsg({ isBot: true }), false, false, new LastSentCache(8)).ok, false);
});

test("LastSentCache 容量淘汰", () => {
	const cache = new LastSentCache(2);
	cache.record("a");
	cache.record("b");
	cache.record("c");
	assert.equal(cache.has("a"), false);
	assert.equal(cache.has("b"), true);
	assert.equal(cache.has("c"), true);
});

test("每群规则：policy/requireMention/allowlist 逐字段继承", () => {
	// 规则未配置字段 → 继承全局
	const c = cfg({ groupPolicy: "open", requireMention: true });
	assert.equal(policyForChat(c, "oc_unconfigured"), "open");
	// 规则覆盖 policy
	const c2 = cfg({ groupPolicy: "mention", groupRules: { oc_x: { policy: "open" } } });
	assert.equal(policyForChat(c2, "oc_x"), "open");
	assert.equal(policyForChat(c2, "oc_y"), "mention"); // 未配置沿用主配置
	// rule.requireMention 字段级继承
	const c3 = cfg({ requireMention: true, groupRules: { oc_x: { requireMention: false } } });
	assert.equal(requireMentionForChat(c3, "oc_x"), false);
	assert.equal(requireMentionForChat(c3, "oc_y"), true);
	// blacklist 策略 + 每群 blacklist
	const c4 = cfg({ groupPolicy: "blacklist", groupRules: { oc_x: { blacklist: ["ou_bad"] } } });
	assert.equal(admit(c4, groupMsg({ senderId: "ou_bad", chatId: "oc_x" }), true, false, new LastSentCache(8)).ok, false);
	assert.equal(admit(c4, groupMsg({ senderId: "ou_ok", chatId: "oc_x" }), true, false, new LastSentCache(8)).ok, true);
	// admin_only 策略：admin 过策略层，但 mention 层仍要 @（hermes 两层模型）
	const c5 = cfg({ groupPolicy: "admin_only", admins: ["ou_admin"] });
	assert.equal(admit(c5, groupMsg({ senderId: "ou_admin" }), true, false, new LastSentCache(8)).ok, true);
	assert.equal(admit(c5, groupMsg({ senderId: "ou_admin" }), false, false, new LastSentCache(8)).ok, false);
	assert.equal(admit(c5, groupMsg({ senderId: "ou_user" }), true, false, new LastSentCache(8)).ok, false);
});
