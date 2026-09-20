/**
 * 准入（admit）与群策略：唯一允许丢弃消息的地方。
 * 对齐 hermes _admit / _allow_group_message：
 * - 全局 groupPolicy（mention/open/disabled/allowlist/blacklist/admin_only）
 * - 每群规则 groupRules（policy/allowlist/blacklist/requireMention 字段继承）
 * - groupPolicyByChat 向后兼容（简单 policy 覆盖）
 * - admins 群内只豁免策略层（@ 层默认不豁免，见 adminBypassMention）；allow_bots 默认拒绝（none）
 */
import type { AdmitReason, BridgeConfig, FeishuInboundMessage, GroupPolicy, GroupRule } from "../types.js";

/**
 * allowBots 的特殊值（对齐 hermes allow_bots=mentions）。
 * 与具体 id 并列在同一数组里：["mentions", "cli_xxx"] 表示
 * 「任何 @ 了本 bot 的消息放行，另外这个 app 的消息无条件放行」。
 */
export const ALLOW_BOTS_MENTIONS = "mentions";

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
): { ok: true } | { ok: false; reason: AdmitReason; hint?: string } {
	/**
	 * 拒绝结果，**只在「@ 了本 bot」时附带修复指引**。
	 *
	 * 群里没 @ 的消息本来就不该被处理（闲聊、别人之间的对话），给它们打印
	 * "该往哪个配置加什么"是纯噪音 —— 一边刷屏一边把真正需要的那条埋掉。
	 * 而 @ 了却被挡的消息，说明用户**表达了意图**，那才是该告诉他怎么放行的场合。
	 *
	 * 私聊是例外：消息量小，且用户是**专门来找这个 bot** 的，被挡就该告诉他怎么放行
	 * （私聊通常不带 @，若也按 @ 判定就永远拿不到指引了）。
	 */
	const withHint = (reason: AdmitReason, hint: string) =>
		mentioned || msg.chatType === "p2p"
			? { ok: false as const, reason, hint }
			: { ok: false as const, reason };

	// 1. 自身回声/其他 bot（hermes allow_bots 默认 "none"）；
	//    P2 增补：allowBots 白名单允许指定的自定义机器人/兄弟应用驱动桥（默认空 = 维持原行为）。
	// 白名单可写 app_id（跨应用稳定）或 open_bot_id（按视角，换应用后会变）——两者都接受。
	// 另支持特殊值 "mentions"（对齐 hermes allow_bots=mentions）：任何 bot 消息，
	// 只要 @ 了本 bot 就放行。它不依赖 id，因此换应用后不会失效，且天然防
	// 死循环——两个 bot 互相自动回话时不会互相 @。
	const allowBots = cfg.allowBots ?? [];
	const allowByMention = allowBots.includes(ALLOW_BOTS_MENTIONS) && mentioned;
	const allowById =
		allowBots.includes(msg.senderId) || (msg.senderAppId ? allowBots.includes(msg.senderAppId) : false);
	const botAllowed = msg.isBot && (allowByMention || allowById);
	if (msg.isBot && !botAllowed) {
		return withHint(
			"bots_disabled",
			// 日志要自解释：给出「照做就能通过」的具体动作，而不是让人去翻代码。
			// 而且建议要**看当前配置** —— 配了 mentions 还被挡，问题通常是"没 @ 到本 bot"，
			// 这时让人去加 id 是错的方向（加完也还是挡住）。
			allowBots.includes(ALLOW_BOTS_MENTIONS)
				? `allowBots 已含 "mentions"（按 @ 放行），但这条消息没有 @ 到本 bot（没 @ / @ 的是别人 / 只 @所有人）。`
					+ `放行方式：内容里带上 <at user_id="<botOpenId>">（botOpenId 见 status.json）；`
					+ `或把 "${msg.senderAppId ?? msg.senderId}" 直接加进 config.json 的 allowBots。`
				: `非人类发送者不在 allowBots 白名单。放行方式（任选其一）：`
					+ `① 在 pi-config/feishu-bridge/config.json 的 allowBots 里加 "${msg.senderAppId ?? msg.senderId}"；`
					+ `② 加特殊值 "mentions"（任何 bot 只要 @ 了本 bot 就放行 —— 不依赖 id，换应用后不会失效）。`,
		);
	}

	const isGroup = msg.chatType !== "p2p";
	const isAdmin = isGroup && isAdminOrOwner(cfg, msg.senderId);

	if (!isGroup) {
		// DM：fail-closed —— 空白名单 = 拒绝所有私聊（与群维度的 allowChats 对称）。
		// 但管理员与应用归属人（启动时水合的 implicitAdmins）始终放行：
		// 归属人 open_id 随应用自动刷新，换应用后不需要重新维护白名单，
		// 否则会出现「换了应用，只有管理员被自己挡在门外」的尴尬。
		if (cfg.allowUsers.includes(msg.senderId)) return { ok: true };
		if (isAdminOrOwner(cfg, msg.senderId)) return { ok: true };
		return withHint(
			"dm_policy_rejected",
			`私聊 fail-closed（allowUsers 为空 = 拒绝所有私聊）。`
				+ `放行方式：在 config.json 的 allowUsers 里加 "${msg.senderId}"，或让该用户成为管理员/应用归属人。`,
		);
	}

	// ---- 群准入闸（fail-closed：空白名单 = 拒绝所有群） ----
	// allowChats 与 groupPolicy 是两个正交维度：前者答「哪些群允许被服务」，
	// 后者答「在允许的群里怎么触发」。原实现把 allowChats 塞在 allowlist 策略
	// 分支内，导致 groupPolicy 取其它值时白名单形同虚设 —— 任何群 @ 一下就响应。
	// 安全默认必须是 fail-closed，因此这里无条件检查，且空数组也拒绝。
	if (!cfg.allowChats.includes(msg.chatId)) {
		return withHint(
			"not_allowlisted",
			`群准入 fail-closed（allowChats 为空 = 拒绝所有群）。`
				+ `放行方式：在 config.json 的 allowChats 里加 "${msg.chatId}"。`,
		);
	}

	// ---- 策略层（hermes _allow_group_message；admin 豁免策略） ----
	const rule = ruleForChat(cfg, msg.chatId);
	const policy = policyForChat(cfg, msg.chatId);
	if (!isAdmin) {
		if (policy === "disabled") {
			return withHint(
				"group_policy_rejected",
				`本群策略是 disabled。放行方式：把 config.json 的 groupRules["${msg.chatId}"].policy 或全局 groupPolicy 改成 open/mention。`,
			);
		}
		if (policy === "open") { /* 策略层放行 */ }
		else if (policy === "admin_only") {
			if (isAdminOrOwner(cfg, msg.senderId)) return { ok: true };
			return withHint(
				"group_policy_rejected",
				`本群策略是 admin_only 且发送者不是管理员。`
					+ `放行方式：把 "${msg.senderId}" 加入 config.json 的 admins，或把群策略改成 mention/open。`,
			);
		} else if (policy === "allowlist") {
			// 用户白名单（rule.allowlist）；群维度的准入已由上方 allowChats 闸完成
			const allowlist = rule?.allowlist ?? [];
			if (allowlist.length > 0 && !allowlist.includes(msg.senderId)) {
				return withHint(
					"not_allowlisted",
					`本群策略是 allowlist 且该用户不在名单里。`
						+ `放行方式：在 config.json 的 groupRules["${msg.chatId}"].allowlist 里加 "${msg.senderId}"。`,
				);
			}
		} else if (policy === "blacklist") {
			const blacklist = rule?.blacklist ?? [];
			if (blacklist.includes(msg.senderId)) {
				return withHint(
					"group_policy_rejected",
					`发送者在黑名单里。放行方式：从 config.json 的 groupRules["${msg.chatId}"].blacklist 移除 "${msg.senderId}"。`,
				);
			}
		}
	}

	// ---- mention 层（hermes：admin 也过 @ 检查） ----
	return checkMention(cfg, msg, mentioned, replyToBot);
}

/**
 * 管理员或应用归属人判定（implicitAdmins 为启动时水合的 app owner/creator）。
 * 归属人 open_id 与消息 senderId 同为「当前应用视角」，可直接比较。
 */
/**
 * 有效管理员集合 = 配置的 admins + 启动时水合的应用归属人。
 * 所有「管理员才能做」的判定都应走这里，避免换应用后 admins 视角失效。
 */
export function effectiveAdmins(cfg: BridgeConfig): string[] {
	return [...new Set([...cfg.admins, ...(cfg.implicitAdmins ?? [])])];
}

export function isAdminOrOwner(cfg: BridgeConfig, senderId: string): boolean {
	if (!senderId) return false;
	return cfg.admins.includes(senderId) || (cfg.implicitAdmins ?? []).includes(senderId);
}

/** mention 策略检查（hermes require_mention 字段 + groupAlsoOnReply）。 */
function checkMention(
	cfg: BridgeConfig,
	msg: FeishuInboundMessage,
	mentioned: boolean,
	replyToBot: boolean,
): { ok: true } | { ok: false; reason: AdmitReason; hint?: string } {
	const needMention = requireMentionForChat(cfg, msg.chatId);
	if (!needMention) return { ok: true };
	if (mentioned) return { ok: true };
	// 管理员/应用归属人默认**不**豁免 @（hermes 两层模型）：需要显式 adminBypassMention=true 才免 @
	if (cfg.adminBypassMention === true && isAdminOrOwner(cfg, msg.senderId)) return { ok: true };
	if (cfg.groupAlsoOnReply && replyToBot) return { ok: true };
	// 到这里说明「没 @ 到本 bot」（@ 了就直接 return ok 了）—— 按准入日志的分寸，
	// 这种情况**不给修复指引**：群里大量没 @ 的闲聊本来就不该被处理，逐条打印
	// "怎么放行"只会刷屏，把真正需要看的那条埋掉。
	return { ok: false, reason: "bot_not_mentioned" };
}
