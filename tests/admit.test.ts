/**
 * admit 单元测试：策略矩阵（open/mention/disabled/allowlist、管理员、DM、回复免 @）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, LastSentCache, policyForChat, requireMentionForChat } from "../src/inbound/admit.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";
import type { FeishuInboundMessage } from "../src/types.js";

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], ...over };
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


/**
 * 只断言判定结果，不锁死返回对象的形状。
 *
 * admit 的返回值会带诊断字段（如 `hint`：告诉日志读者"该改哪个配置的哪个字段"），
 * 用 deepEqual 精确匹配会让每次加字段都翻修一遍测试 —— 而这里真正要守的是
 * 「是否放行」与「拒绝原因」。
 */
function verdictOf(result: { ok: true } | { ok: false; reason: string }): string {
	return result.ok ? "allow" : result.reason;
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

test("管理员默认不豁免 @（adminBypassMention 默认 false），显式开启后才豁免", () => {
	const msg = groupMsg({ senderId: "ou_admin" });
	// 默认（hermes 两层模型）：管理员只豁免策略层，未 @ 仍拒绝
	const c = cfg({ groupPolicy: "mention", admins: ["ou_admin"] });
	assert.equal(admit(c, msg, true, false, new LastSentCache(8)).ok, true);
	assert.equal(admit(c, msg, false, false, new LastSentCache(8)).ok, false, "默认未 @ 应拒绝");
	// 显式开启豁免：管理员不必 @ 即可驱动 agent
	const lax = cfg({ groupPolicy: "mention", admins: ["ou_admin"], adminBypassMention: true });
	assert.equal(admit(lax, msg, true, false, new LastSentCache(8)).ok, true);
	assert.equal(admit(lax, msg, false, false, new LastSentCache(8)).ok, true, "开启豁免后未 @ 也放行");
	// admin 豁免策略层：admin_only 下 admin 过策略层，@ 层默认仍要过
	const c2 = cfg({ groupPolicy: "admin_only", admins: ["ou_admin"] });
	assert.equal(admit(c2, msg, true, false, new LastSentCache(8)).ok, true);
	assert.equal(admit(c2, msg, false, false, new LastSentCache(8)).ok, false, "admin_only 下管理员未 @ 仍拒绝");
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

test("DM：空白名单 fail-closed，拒绝所有私聊", () => {
	const c = cfg({});
	const msg = groupMsg({ chatType: "p2p" });
	assert.equal(verdictOf(admit(c, msg, false, false, new LastSentCache(8))), "dm_policy_rejected");
});

test("DM：管理员与应用归属人即使不在 allowUsers 里也放行", () => {
	const msg = groupMsg({ chatType: "p2p" });
	const lastSent = new LastSentCache(8);
	// 显式管理员
	assert.deepEqual(admit(cfg({ admins: ["ou_user"] }), msg, false, false, lastSent), { ok: true });
	// 应用归属人 / 协作者（启动时水合进 implicitAdmins）
	assert.deepEqual(admit(cfg({ implicitAdmins: ["ou_user"] }), msg, false, false, lastSent), { ok: true });
	// 既不是管理员也不是归属人 → 拒绝
	assert.equal(verdictOf(admit(cfg({ implicitAdmins: ["ou_someone_else"] }), msg, false, false, lastSent)), "dm_policy_rejected");
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
	// admin_only 策略：admin 过策略层；mention 层默认也要过 @（adminBypassMention 默认 false）
	const c5 = cfg({ groupPolicy: "admin_only", admins: ["ou_admin"] });
	assert.equal(admit(c5, groupMsg({ senderId: "ou_admin" }), true, false, new LastSentCache(8)).ok, true);
	assert.equal(admit(c5, groupMsg({ senderId: "ou_admin" }), false, false, new LastSentCache(8)).ok, false, "管理员默认也要 @");
	// 显式开启豁免后才免 @
	const c5lax = cfg({ groupPolicy: "admin_only", admins: ["ou_admin"], adminBypassMention: true });
	assert.equal(admit(c5lax, groupMsg({ senderId: "ou_admin" }), false, false, new LastSentCache(8)).ok, true);
	assert.equal(admit(c5, groupMsg({ senderId: "ou_user" }), true, false, new LastSentCache(8)).ok, false);
});

test("allowBots 白名单：默认拒绝所有 bot，登记后可放行指定 app", async () => {
	const cfg = { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], groupPolicy: "open" as const };
	const botMsg = (senderId: string) => ({
		messageId: "m-bot", chatId: "oc_group", chatType: "group" as const,
		senderId, senderName: "自定义机器人", isBot: true, msgType: "text" as const,
		text: "hi", mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "CY智能助手", isSelf: true }],
		resources: [], raw: undefined, ts: Date.now(),
	});
	const lastSent = { has: () => false };
	// 默认：拒绝
	assert.equal(verdictOf(admit(cfg, botMsg("cli_testbot00000000") as never, true, false, lastSent as never)), "bots_disabled");
	// 白名单：放行（@ 仍需满足）
	const allowed = { ...cfg, allowBots: ["cli_testbot00000000"] };
	assert.deepEqual(admit(allowed, botMsg("cli_testbot00000000") as never, true, false, lastSent as never), { ok: true });
	// 白名单外：仍拒绝
	assert.equal(verdictOf(admit(allowed, botMsg("cli_other") as never, true, false, lastSent as never)), "bots_disabled");
	// 白名单但没 @（mention 策略）：按 mention 规则拒绝
	const mentionCfg = { ...allowed, groupPolicy: "mention" as const };
	assert.equal(verdictOf(admit(mentionCfg, botMsg("cli_testbot00000000") as never, false, false, lastSent as never)), "bot_not_mentioned");
});

test("@所有人 默认被过滤，可配置为不过滤（ignoreAtAll）", async () => {
	const base = { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], groupPolicy: "mention" as const };
	const atAllMsg = {
		messageId: "m-atall", chatId: "oc_group", chatType: "group" as const,
		senderId: "ou_user", senderName: "同事", isBot: false, msgType: "text" as const,
		text: "@_all 大家好，这是群公告", mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
	const lastSent = { has: () => false };

	// 默认（ignoreAtAll 未设置 = true）：@所有人 不唤醒
	assert.equal(
		verdictOf(admit(base, atAllMsg as never, false, false, lastSent as never)),
		"bot_not_mentioned",
		"默认必须过滤 @所有人",
	);
	// 显式关闭过滤：@所有人 视为已提及
	assert.deepEqual(
		admit({ ...base, ignoreAtAll: false }, atAllMsg as never, true, false, lastSent as never),
		{ ok: true },
	);
	// 即使开启过滤，消息里同时 @ 了本 bot 仍应唤醒（isSelf 分支）
	assert.deepEqual(
		admit(base, atAllMsg as never, true, false, lastSent as never),
		{ ok: true },
		"真实 @本 bot 不受 @所有人 过滤影响",
	);
});

test("allowBots 支持 app_id 匹配（换应用后 open_id 变化仍可用）", async () => {
	const cfgBots = { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], groupPolicy: "open" as const, allowBots: ["cli_testbot00000000"] };
	const appMsg = {
		messageId: "m-webhook", chatId: "oc_group", chatType: "group" as const,
		senderId: "ou_new_perspective_bot", // 视角相关，换应用后会变
		senderAppId: "cli_testbot00000000", // 稳定
		isBot: true, msgType: "text" as const, text: "@bot hi",
		mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "TestAssistant", isSelf: true }],
		resources: [], raw: undefined, ts: Date.now(),
	};
	const lastSent = { has: () => false };
	assert.deepEqual(
		admit(cfgBots, appMsg as never, true, false, lastSent as never),
		{ ok: true },
		"仅凭 app_id 白名单就应放行（不依赖视角相关的 open_id）",
	);
	// 既不是白名单里的 app_id 也不是白名单里的 open_id → 拒绝
	assert.equal(verdictOf(admit(cfgBots, { ...appMsg, senderAppId: "cli_other", senderId: "ou_other" } as never, true, false, lastSent as never)), "bots_disabled");
});

test("管理员/应用归属人默认也要 @（adminBypassMention 默认关闭）", async () => {
	const base = { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], groupPolicy: "mention" as const };
	const ownerMsg = {
		messageId: "m-owner", chatId: "oc_group", chatType: "group" as const,
		senderId: "ou_owner", senderName: "陈勇", isBot: false, msgType: "text" as const,
		text: "帮我看看这个报错", mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
	const lastSent = { has: () => false };
	// 归属人（启动时水合的 implicitAdmins）：默认不豁免 @
	assert.equal(
		verdictOf(admit({ ...base, implicitAdmins: ["ou_owner"] } as never, ownerMsg as never, false, false, lastSent as never)),
		"bot_not_mentioned",
		"应用归属人默认也要 @",
	);
	// admins 配置里的管理员同理
	assert.equal(
		verdictOf(admit({ ...base, admins: ["ou_owner"] } as never, ownerMsg as never, false, false, lastSent as never)),
		"bot_not_mentioned",
		"配置的管理员默认也要 @",
	);
	//  @ 到 bot 时管理员照常放行
	assert.deepEqual(
		admit({ ...base, admins: ["ou_owner"] } as never, ownerMsg as never, true, false, lastSent as never),
		{ ok: true },
		"管理员 @ 后应放行",
	);
	// 普通成员仍必须 @
	assert.equal(verdictOf(admit(base as never, { ...ownerMsg, senderId: "ou_other" } as never, false, false, lastSent as never)), "bot_not_mentioned");
	// 显式开启豁免后，管理员免 @
	assert.deepEqual(
		admit({ ...base, implicitAdmins: ["ou_owner"], adminBypassMention: true } as never, ownerMsg as never, false, false, lastSent as never),
		{ ok: true },
	);
});

// ---------------------------------------------------------------- allowBots: "mentions" ----
// 对齐 hermes allow_bots=mentions：任何 bot 消息，只要 @ 了本 bot 就放行。
// 与 id 白名单的区别在于不依赖应用视角生成的 id，换应用后不会失效。

test("allowBots: \"mentions\" 只按 @ 放行，不依赖 id", async () => {
	const base = cfg({ groupPolicy: "open", allowBots: ["mentions"] });
	// senderId 是一个从未登记过的 bot —— 证明放行完全来自 @，而非 id 匹配
	const strangerBot = groupMsg({
		messageId: "m-bot-1",
		senderId: "ou_never_registered",
		isBot: true,
	} as never);
	const lastSent = new LastSentCache(8);

	// @ 了本 bot → 放行
	assert.deepEqual(admit(base, strangerBot, true, false, lastSent), { ok: true });
	// 没 @ → 仍然拒绝。这正是防死循环的关键：两个 bot 自动互回时不会互相 @。
	assert.equal(verdictOf(admit(base, strangerBot, false, false, lastSent)), "bots_disabled");
});

test("allowBots: \"mentions\" 可与具体 app_id 混用", async () => {
	const mixed = cfg({ groupPolicy: "mention", allowBots: ["mentions", "cli_uncond000000000"] });
	const lastSent = new LastSentCache(8);
	const uncond = groupMsg({ messageId: "m-bot-2", senderId: "cli_uncond000000000", isBot: true } as never);
	const stranger = groupMsg({ messageId: "m-bot-3", senderId: "cli_stranger0000000", isBot: true } as never);

	// 登记过的 app：没 @ 也能过 bots 闸（随后仍受 mention 层约束）
	assert.deepEqual(admit(mixed, uncond, true, false, lastSent), { ok: true });
	// 未登记且没 @ → bots 闸拒绝
	assert.equal(verdictOf(admit(mixed, stranger, false, false, lastSent)), "bots_disabled");
	// 未登记但 @ 了 → mention 档放行
	assert.deepEqual(admit(mixed, stranger, true, false, lastSent), { ok: true });
});

test("allowBots: 纯 id 数组行为不变（\"mentions\" 不是通配符）", async () => {
	const onlyIds = cfg({ groupPolicy: "open", allowBots: ["cli_only00000000000"] });
	const lastSent = new LastSentCache(8);
	// 非白名单 bot：@ 了也不放行 —— 纯 id 模式没有 mention 档，保持向后兼容
	const other = groupMsg({ messageId: "m-bot-4", senderId: "cli_other0000000", isBot: true } as never);
	assert.equal(verdictOf(admit(onlyIds, other, true, false, lastSent)), "bots_disabled");
});

// ------------------------------------------------- allowChats fail-closed ----

test("allowChats 是群准入闸：空白名单拒绝所有群（fail-closed）", () => {
	// 即使策略是 open、也不需要 @，空白名单也必须拒绝 —— 安全默认
	const c = cfg({ groupPolicy: "open", requireMention: false, allowChats: [] });
	assert.equal(verdictOf(admit(c, groupMsg(), true, false, new LastSentCache(8))), "not_allowlisted");
	// 管理员也不能绕过准入闸（准入先于策略层与管理员豁免）
	const owner = cfg({ groupPolicy: "open", requireMention: false, allowChats: [], implicitAdmins: ["ou_user"] });
	assert.equal(verdictOf(admit(owner, groupMsg(), true, false, new LastSentCache(8))), "not_allowlisted");
});

test("allowChats 与 groupPolicy 正交：白名单生效后策略才决定触发方式", () => {
	// 策略是 mention（白名单原本不参与判定）—— 现在白名单照样生效
	const inList = cfg({ groupPolicy: "mention", requireMention: true, allowChats: ["oc_group"] });
	const outList = cfg({ groupPolicy: "mention", requireMention: true, allowChats: ["oc_somewhere_else"] });
	const lastSent = new LastSentCache(8);
	// 白名单内：过准入 → 过策略 → 过 mention
	assert.deepEqual(admit(inList, groupMsg(), true, false, lastSent), { ok: true });
	// 白名单外：准入闸直接拒绝，与 groupPolicy 取值无关
	assert.equal(verdictOf(admit(outList, groupMsg(), true, false, lastSent)), "not_allowlisted");
});

// ── 拒绝日志的 hint（本轮新增）──────────────────────────────────────────
// 准入是 fail-closed 的，被挡很常见；日志必须自解释「为什么被挡、怎么放行」，
// 否则每次都要翻代码。hint 还要**看当前配置**给建议 —— 方向错了比没有更糟。

test("hint：未配 mentions 时，bots_disabled 建议加 id 或启用 mentions", () => {
	const c = cfg({ allowBots: [] });
	const bot = groupMsg({
		chatId: "oc_group", senderId: "cli_testbot00000000", senderName: "自定义机器人",
		isBot: true, mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "CY智能助手", isSelf: true }] as never,
	});
	const result = admit(c, bot as never, true, false, new LastSentCache(8));   // @ 了本 bot
	assert.equal(result.ok, false);
	const hint = result.ok ? "" : (result as { hint?: string }).hint ?? "";
	assert.match(hint, /allowBots/);
	assert.match(hint, /mentions/, "应给出「加 mentions 特殊值」这条一劳永逸的路");
});

test("hint：群里没 @ 本 bot 的消息不给引导（群消息量大，避免刷屏）", () => {
	// 用户明确要求：只有 @ 到智能体的才需要日志引导。
	// 群里没 @ 的闲聊本来就不该被处理，逐条打印"怎么放行"会把真问题埋掉。
	const c = cfg({ allowBots: ["mentions"], allowChats: ["oc_group"] });
	const bot = groupMsg({ chatId: "oc_group", senderId: "cli_testbot00000000", isBot: true, mentions: [] as never });
	const result = admit(c, bot as never, false, false, new LastSentCache(8));
	assert.equal(result.ok, false);
	assert.equal((result as { hint?: string }).hint, undefined, "没 @ 就不该给引导");
});

test("hint：@ 了本 bot 却被挡时，才是该给引导的场合", () => {
	const c = cfg({ allowBots: ["mentions"], allowChats: [] });   // 群不在白名单
	const bot = groupMsg({
		chatId: "oc_group", senderId: "cli_testbot00000000", isBot: true,
		mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "CY智能助手", isSelf: true }] as never,
	});
	const result = admit(c, bot as never, true, false, new LastSentCache(8));
	assert.equal(result.ok, false);
	assert.match((result as { hint?: string }).hint ?? "", /allowChats/, "@ 了却被挡 → 必须告诉怎么放行");
});

test("hint：群白名单拒绝时给出要加的 chatId", () => {
	const c = cfg({ allowChats: [] });
	const msg = groupMsg({ chatId: "oc_deadbeef" });
	const result = admit(c, msg as never, true, false, new LastSentCache(8));
	assert.equal(result.ok, false);
	const hint = result.ok ? "" : (result as { hint?: string }).hint ?? "";
	assert.match(hint, /allowChats/);
	assert.match(hint, /oc_deadbeef/, "要把实际 chatId 打出来，直接复制即可");
});

test("hint：私聊拒绝时给出要加的 userId", () => {
	const c = cfg({ allowUsers: [] });
	const msg = groupMsg({ chatType: "p2p", senderId: "ou_someone" });
	const result = admit(c, msg as never, false, false, new LastSentCache(8));
	assert.equal(result.ok, false);
	// 私聊例外：消息量小、用户是专程来找 bot 的 → 即使没 @ 也给引导
	const hint = result.ok ? "" : (result as { hint?: string }).hint ?? "";
	assert.match(hint, /allowUsers/);
	assert.match(hint, /ou_someone/);
});

test("hint：bot_not_mentioned 不带引导（它本身就是「没 @」的结果）", () => {
	const c = cfg({ groupPolicy: "mention", allowChats: ["oc_group"] });
	const msg = groupMsg({ chatId: "oc_group" });
	const result = admit(c, msg as never, false, false, new LastSentCache(8));
	assert.equal(result.ok, false);
	assert.equal(verdictOf(result), "bot_not_mentioned");
	assert.equal((result as { hint?: string }).hint, undefined);
});
