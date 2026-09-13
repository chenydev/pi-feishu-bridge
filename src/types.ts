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
	maxMessages: number;
	maxChars: number;
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
	dedupTtlMs: number;
	/** 同时执行的 Pi 会话上限；其余 conversation 在内存队列等待。 */
	maxActiveSessions: number;
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
	batch: { enabled: true, textWindowMs: 3000, maxMessages: 8, maxChars: 12_000 },
	forwarding: { acceptMergeForward: true },
	approval: { autoApprove: [], timeoutMs: 300_000 },
	reaction: { processingEmoji: "Typing", enabled: true },
	sessionDir: "sessions/feishu",
	debug: false,
	lastSentCacheSize: 64,
	quotedFetchTtlMs: 5 * 60_000,
	dedupCacheSize: 4096,
	dedupTtlMs: 24 * 60 * 60_000,
	maxActiveSessions: 8,
};

// ------------------------------------------------------------ 入站消息 ----

export type InboundMsgType = "text" | "image" | "video" | "audio" | "file" | "post" | "merge_forward" | "share_chat" | "interactive" | "unknown";

export interface FeishuMentionRef {
	/** 占位符 key（@_user_N / @_all） */
	key?: string;
	id?: { open_id?: string; user_id?: string; union_id?: string };
	name?: string;
	isSelf: boolean;
}

export interface ResourceRef {
	kind: "image" | "video" | "audio" | "file";
	key: string;
	messageId: string;
	name?: string;
	mimeType?: string;
	size?: number;
}

export interface PiImageContent {
	type: "image";
	/** 裸 base64，不含 data: URI 前缀。 */
	data: string;
	mimeType: string;
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
	resources: ResourceRef[];
	/** 回复链路：被回复消息 id（parent_id ?? upper_message_id ?? root_id） */
	replyToMessageId?: string;
	/** 被回复消息原文（API 拉取；失败为占位文本） */
	replyToText?: string;
	/** 话题/根消息 */
	threadId?: string;
	raw: unknown;
	ts: number;
	/** batch 后保留所有原始事件 id，供恢复审计。 */
	sourceMessageIds?: string[];
}

export type AdmitReason = "self_echo" | "bots_disabled" | "bot_not_mentioned" | "dm_policy_rejected" | "group_policy_rejected" | "not_allowlisted";

// ------------------------------------------------------------ 出站 ----

export interface SendOptions {
	replyTo?: string;
	threadId?: string;
	/** durable final 覆盖此前易失流式消息；编辑目标失效时回退 reply/create。 */
	editMessageId?: string;
}

export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
	fallback?: boolean; // 是否发生过 reply→create 回退
	retryable?: boolean;
	errorCode?: number;
	retryAfterMs?: number;
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
			prompt(text: string, images?: PiImageContent[]): Promise<unknown>;
			steer?(text: string, images?: PiImageContent[]): Promise<void>;
			followUp?(text: string, images?: PiImageContent[]): Promise<void>;
			subscribe(fn: (event: unknown) => void): () => void;
			abort(): Promise<void>;
			dispose(): Promise<void>;
			modelId: string;
			compact?(instructions?: string): Promise<string>;
			setModel?(modelId: string): Promise<boolean>;
		}>;
}

export interface BridgeSessionState {
	chatId: string;
	conversationKey: string;
	sessionFile: string;
	queue: Array<{ text: string; images: PiImageContent[]; messageId: string; replyToMessageId?: string; replyToText?: string }>;
	activeRun: boolean;
	lastReplyId?: string;
	busySince?: number;
}

// ------------------------------------------------------------ 状态 ----

export interface BridgeStatus {
	appId?: string;
	pid?: number;
	updatedAt?: number;
	connState: "disconnected" | "connecting" | "connected" | "error";
	downSince?: number;
	lastError?: string;
	reconnectCount: number;
	startedAt?: number;
	botOpenId?: string;
	botName?: string;
	conversations: number;
	sessionQueues?: { queued: number; active: number; waiting: number };
	pendingApprovals?: number;
	outboxDepth: number;
	outbox: {
		pending: number;
		sending: number;
		sent: number;
		failed: number;
		lanes: number;
		oldestAgeMs: number;
	};
	lastMessageAt?: number;
	messageTotal: number;
	messageDropped: number;
	compensatedMessages: number;
	compensationErrors: number;
	compensationTruncated: number;
}

export interface BotIdentity {
	openId?: string;
	userId?: string;
	name?: string;
}
