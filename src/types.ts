/**
 * pi-feishu-bridge 核心类型定义。
 * 设计依据：docs/DESIGN.md §3/§4/§5。
 */

// ---------------------------------------------------------------- 配置 ----

export type GroupPolicy = "open" | "mention" | "disabled" | "allowlist" | "blacklist" | "admin_only";

/** 每群规则（hermes FeishuGroupRule 对齐）：未配置字段继承全局。 */
export interface GroupRule {
	policy?: GroupPolicy;
	allowlist?: string[];
	blacklist?: string[];
	requireMention?: boolean; // undefined = 继承全局
}

export interface BatchConfig {
	enabled: boolean;
	textWindowMs: number; // 同一 chat 多条 text 的合并窗口
}

export interface BridgeConfig {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	/** 可选；启动后由 /open-apis/bot/v3/info 水合覆盖 */
	botOpenId?: string;
	botUserId?: string;
	botName?: string;

	groupPolicy: GroupPolicy;
	/** 每群策略覆盖（优先于全局）——保留向后兼容 */
	groupPolicyByChat: Record<string, GroupPolicy>;
	/** 每群完整规则（hermes group_rules 对齐） */
	groupRules: Record<string, GroupRule>;
	/** 未配置规则群的兜底策略（hermes default_group_policy；空 = 用全局 groupPolicy） */
	defaultGroupPolicy?: GroupPolicy;
	/** 群白名单；空数组 = 全部群按策略 */
	allowChats: string[];
	/** DM 白名单；空 = 全部放行 */
	allowUsers: string[];
	/** 管理员 open_id；群内永远放行 */
	admins: string[];
	/** mention 策略下，回复 bot 消息（parent 命中本 bot 已发缓存）免 @ */
	groupAlsoOnReply: boolean;
	/** 群内普通消息按用户隔离会话（hermes group_sessions_per_user 默认 true）；
	 * 话题内始终共享话题会话（thread_sessions_per_user=false 等价）。 */
	groupSessionsPerUser: boolean;
	requireMention: boolean;

	batch: BatchConfig;
	forwarding: { acceptMergeForward: boolean };
	approval: { autoApprove: string[]; timeoutMs: number };
	reaction: { processingEmoji: string; enabled: boolean };
	sessionDir: string;
	debug: boolean;
	/** 最近已发消息缓存容量（回复判定用） */
	lastSentCacheSize: number;
	/** 拉取被回复原文的 TTL（毫秒） */
	quotedFetchTtlMs: number;
	/** 入站去重缓存容量 */
	dedupCacheSize: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
	appId: "",
	appSecret: "",
	domain: "feishu",
	groupPolicy: "mention",
	groupPolicyByChat: {},
	groupRules: {},
	allowChats: [],
	allowUsers: [],
	admins: [],
	groupAlsoOnReply: true,
	groupSessionsPerUser: true,
	requireMention: true,
	batch: { enabled: true, textWindowMs: 3000 },
	forwarding: { acceptMergeForward: true },
	approval: { autoApprove: [], timeoutMs: 300_000 },
	reaction: { processingEmoji: "Typing", enabled: true },
	sessionDir: "sessions/feishu",
	debug: false,
	lastSentCacheSize: 64,
	quotedFetchTtlMs: 5 * 60_000,
	dedupCacheSize: 4096,
};

// ------------------------------------------------------------ 入站消息 ----

export type InboundMsgType = "text" | "image" | "video" | "audio" | "file" | "post" | "merge_forward" | "share_chat" | "interactive" | "unknown";

export interface FeishuMentionRef {
	id?: { open_id?: string; user_id?: string; union_id?: string };
	name?: string;
	isSelf: boolean;
}

export interface FeishuInboundMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group" | "topic";
	senderId: string; // open_id 优先
	senderName?: string;
	isBot: boolean;
	msgType: InboundMsgType;
	text: string;
	mentions: FeishuMentionRef[];
	/** 回复链路：被回复消息 id（parent_id ?? upper_message_id ?? root_id） */
	replyToMessageId?: string;
	/** 被回复消息原文（API 拉取；失败为占位文本） */
	replyToText?: string;
	/** 话题/根消息 */
	threadId?: string;
	raw: unknown;
	ts: number;
}

export type AdmitReason = "self_echo" | "bots_disabled" | "bot_not_mentioned" | "dm_policy_rejected" | "group_policy_rejected" | "not_allowlisted";

// ------------------------------------------------------------ 出站 ----

export interface SendOptions {
	replyTo?: string;
	threadId?: string;
}

export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
	fallback?: boolean; // 是否发生过 reply→create 回退
}

export class RetryableError extends Error {}
export class FatalDeliveryError extends Error {}

// ------------------------------------------------------------ 会话 ----

export interface SessionBackend {
	createSession(opts: {
		chatId: string;
		conversationKey: string;
		sessionFile?: string;
	}): Promise<{
		sessionId: string;
		prompt(text: string, images?: unknown[]): Promise<unknown>;
		subscribe(fn: (event: unknown) => void): () => void;
		modelId: string;
	}>;
}

export interface BridgeSessionState {
	chatId: string;
	conversationKey: string;
	sessionFile: string;
	queue: Array<{ text: string; images: unknown[]; messageId: string; replyToMessageId?: string; replyToText?: string }>;
	activeRun: boolean;
	lastReplyId?: string;
	busySince?: number;
}

// ------------------------------------------------------------ 状态 ----

export interface BridgeStatus {
	connState: "disconnected" | "connecting" | "connected" | "error";
	reconnectCount: number;
	startedAt?: number;
	botOpenId?: string;
	botName?: string;
	conversations: number;
	outboxDepth: number;
	lastMessageAt?: number;
	messageTotal: number;
	messageDropped: number;
}

export interface BotIdentity {
	openId?: string;
	userId?: string;
	name?: string;
}
