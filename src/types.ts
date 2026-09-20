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

	/**
	 * 展示用时区（IANA 名称，如 Asia/Shanghai）。
	 * 解析顺序：FEISHU_TIMEZONE 环境变量 > config.json > 容器 TZ > 默认 Asia/Shanghai。
	 * 只影响「面向用户的时间显示」；对时间戳存储/比较没有影响（那些一律用 epoch）。
	 */
	timezone: string;

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
	/**
	 * 允许私聊（DM）的用户 open_id 白名单。
	 * fail-closed：空数组 = 拒绝所有私聊；管理员与应用归属人例外，
	 * 始终放行（归属人随应用自动刷新，无需手工维护）。
	 */
	allowUsers: string[];
	/**
	 * 管理员与「应用归属人」是否豁免 @ 检查（**默认 false**）。
	 * 默认关闭时对齐 hermes 两层模型：admin 只豁免策略层，群内仍必须 @ 才触发。
	 * 归属人由启动时调用开放平台接口水合（见 implicitAdmins），无需手工维护 open_id。
	 */
	adminBypassMention?: boolean;
	/**
	 * 运行时水合的隐式管理员（应用 owner/creator 的 open_id，当前应用视角）。
	 * 不写入配置文件：换应用/改归属后重启自动刷新。
	 */
	implicitAdmins?: string[];
	/** 管理员 open_id；豁免群策略层（@ 层由 adminBypassMention 决定） */
	admins: string[];
	/**
	 * 允许触发桥的 bot/app 白名单。
	 *
	 * 元素可以是：
	 * - `app_id`（如 cli_xxx）—— 跨应用稳定，推荐；
	 * - `open_bot_id`（如 ou_xxx）—— 按应用视角生成，换应用后失效；
	 * - 特殊值 `"mentions"` —— 任何 bot 消息只要 @ 了本 bot 就放行
	 *   （对齐 hermes allow_bots=mentions）。不依赖 id，故换应用后不失效，
	 *   且天然防死循环：两个 bot 自动互回时不会互相 @。
	 *
	 * 默认空 = 拒绝所有 bot 消息（hermes allow_bots=none 的安全默认）。
	 */
	allowBots?: string[];
	/** run 空闲超时（无任何事件产出才算）；0 = 关闭。默认 10 分钟。 */
	runIdleTimeoutMs?: number;
	/** run 总时长硬上限；0 = 不限制（默认）。 */
	runMaxDurationMs?: number;
	/**
	 * 是否忽略「@所有人」的唤醒（默认 true = 过滤）。
	 * @所有人 常用于群公告类广播，默认不应唤醒 agent；
	 * 显式设为 false 后，@所有人 与 @本 bot 等效（仍受群策略与白名单约束）。
	 */
	ignoreAtAll?: boolean;
	/** mention 策略下，回复 bot 消息（parent 命中本 bot 已发缓存）免 @ */
	groupAlsoOnReply: boolean;
	/** 群内普通消息按用户隔离会话（hermes group_sessions_per_user 默认 true）；
	 * 话题内始终共享话题会话（thread_sessions_per_user=false 等价）。 */
	groupSessionsPerUser: boolean;
	requireMention: boolean;

	batch: BatchConfig;
	forwarding: { acceptMergeForward: boolean };
	/**
	 * 审批策略：
	 * - autoApprove：按工具名免审批（原有）
	 * - adminSkipApproval：**管理员/应用归属人发起的工具调用直接放行**（默认 false）
	 */
	approval: {
		autoApprove: string[];
		timeoutMs: number;
		adminSkipApproval?: boolean;
		/**
		 * 命令级审批策略：按 bash 命令语义分级，避免「每个 shell 命令都要点一次审批」。
		 * - 只读命令（ls/cat/git status…）免审
		 * - 危险命令（rm -rf/、fork 炸弹、curl|sh、git push --force…）直接拒绝
		 * - 其余仍弹审批卡
		 * 判定不确定时一律归为「询问」，宁可多问不可误放。
		 */
		/**
		 * 策略引擎归属：
		 * - "bridge"（默认）：用桥自研的 command-policy + 飞书审批卡
		 * - "pi-permission-system"：策略完全交给 @gotgenes/pi-permission-system
		 *   （它在 pi 的子会话里先于桥的闸门执行，deny 时桥根本收不到调用），
		 *   桥不再弹审批卡 —— 用户用该扩展的配置文件维护放行/黑名单规则。
		 *
		 * **失败关闭**：若该扩展实际上没装成，桥会回落到自己的审批而非静默放行。
		 */
		policyEngine?: "bridge" | "pi-permission-system";
		commandPolicy?: {
			enabled: boolean;
			extraReadOnly?: string[];
			extraDangerous?: string[];
		};
		/**
		 * pi-permission-system 父会话转发（**默认关闭**，实验性）。
		 *
		 * 打开后桥充当该扩展的「父会话应答方」：在进程环境里声明父子关系（PI_SUBAGENT_PARENT_SESSION，
		 * 见 approval/ps-forwarding.ts 的 PS_FORWARDING_PARENT_ENV_KEYS），
		 * 并在 <agentDir>/sessions/permission-forwarding/ 下发布心跳 + 轮询子会话写入的请求文件，
		 * 把 PS 的 ask 变成飞书审批卡。
		 * 关闭时桥不碰该环境变量、不读写转发目录（保持 33.0.3 的现状：ask 无人应答 → 拒绝）。
		 */
		forwarding?: {
			enabled: boolean;
			/** 桥侧父会话 id（PS 用它命名转发目录；必须稳定且不等于任何真实 session id）。 */
			parentSessionId?: string;
			/**
			 * 「始终批准」规则表（默认 true）。开启后审批卡多一个 always 按钮；
			 * 命中已记规则的请求直接放行、不再弹卡。撤销见 `/feishu always revoke`。
			 */
			alwaysApprove?: boolean;
		};
	};
	reaction: { processingEmoji: string; enabled: boolean };
	/**
	 * P1-01：CardKit 流式卡片（**默认关闭**）。
	 * 打开后过程内容用流式卡片呈现，最终回答仍走 durable 文本通道（卡片失败不影响交付）。
	 * 需要应用具备 `cardkit:card:write` 权限；也可用环境变量 FEISHU_STREAMING_CARD=1 临时启用。
	 */
	streamingCard?: {
		enabled: boolean;
		throttleMs: number;
		/** 打字机参数：每次上屏间隔（毫秒）。平台默认 70，越小越快。 */
		printFrequencyMs?: number;
		/** 打字机参数：每次上屏字符数。平台默认 1（500 字要播 35 秒），实测 50 可显著加速。 */
		printStep?: number;
	};
	/** P1-03：final 页脚（模型/耗时/token/费用估算）。 */
	footer: { enabled: boolean; showCost: boolean };
	/** P1-08：空闲会话回收（与 maxActiveSessions 的“并发上限”语义不同）。 */
	sessionLifecycle: { idleTtlMs: number; maxResidentSessions: number; sweepIntervalMs: number };
	/** P1-02：处理中进度展示（工具名/耗时/脱敏摘要；思考摘要默认关闭）。 */
	progress: { showThinking: boolean };
	/**
	 * P2-02：受控工作区别名 —— 只允许别名映射到 realpath 白名单目录。
	 * 空对象 = 功能关闭（默认）；绝对路径/`..`/白名单外的值一律拒绝。
	 */
	workspaces: { aliases: Record<string, string> };
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
	// 默认上海：容器基础镜像是 UTC，不显式指定的话用户看到的时间会差 8 小时
	timezone: "Asia/Shanghai",
	groupPolicy: "mention",
	groupPolicyByChat: {},
	groupRules: {},
	allowChats: [],
	allowUsers: [],
	admins: [],
	groupAlsoOnReply: true,
	allowBots: [],
	// 空闲超时：只在「完全没有事件产出」时中止（对齐 hermes 不设固定总时长的做法）
	runIdleTimeoutMs: 600_000,
	// 总时长上限：默认 0 = 不限制
	runMaxDurationMs: 0,
	groupSessionsPerUser: true,
	requireMention: true,
	// 群内 @ 检查对所有人一致（含管理员/应用归属人）——管理员可显式设为 true 豁免
	adminBypassMention: false,
	batch: { enabled: true, textWindowMs: 3000, maxMessages: 8, maxChars: 12_000 },
	forwarding: { acceptMergeForward: true },
	approval: {
		autoApprove: [], timeoutMs: 300_000, adminSkipApproval: false, commandPolicy: { enabled: true },
		// 实验性：默认关闭。打开前先确认 pi-permission-system 的 ask 规则确实需要人工判定。
		forwarding: {
			enabled: false,
			// 「始终批准」：桥侧维护规则表，命中规则的转发请求直接放行、不再弹卡。
			// 语义等价于 PS 原生对话框的「始终批准」（PS 记在父会话 SessionRules 里，
			// 桥走不到那条路，改为按规则名记在自己的表里）。默认开 —— 它需要管理员
			// 主动点卡片才生效，且撤销入口存在（/feishu always revoke）。
			alwaysApprove: true,
		},
	},
	reaction: { processingEmoji: "Typing", enabled: true },
	footer: { enabled: true, showCost: true },
	sessionLifecycle: { idleTtlMs: 30 * 60_000, maxResidentSessions: 32, sweepIntervalMs: 60_000 },
	progress: { showThinking: false },
	// P2-02：默认关闭 —— 未确定授权范围前不允许切换工作区
	workspaces: { aliases: {} },
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
	senderId: string;
	/**
	 * app/bot 消息的 app_id（如 cli_xxx）。app_id 跨应用稳定，
	 * 而 open_id/open_bot_id 是按应用视角生成的，换应用后会变 —— allowBots 白名单应优先用它。
	 */
	senderAppId?: string; // open_id 优先
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
	/** P0-07：统一错误分类（rate_limited/permission/not_found/...），用于日志与降级决策。 */
	errorClass?: string;
}

export class RetryableError extends Error {}
export class FatalDeliveryError extends Error {}

// ------------------------------------------------------------ 会话 ----

export interface SessionBackend {
	createSession(opts: {
		chatId: string;
		conversationKey: string;
		sessionFile?: string;
		/** P2-02：该会话的工作目录（默认进程 cwd；绝不修改进程全局 cwd）。 */
		cwd?: string;
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
			/** P1-06：已认证模型清单（provider 用于区分同名模型）。 */
			listModels?(): Promise<Array<{ id: string; provider?: string }>>;
			/** P1-06：当前模型支持的思考等级（空/未实现表示不支持）。 */
			availableThinkingLevels?(): string[];
			/** P1-06：当前思考等级。 */
			thinkingLevel?(): string;
			/** P1-06：设置思考等级（由 provider 内部按模型能力 clamp）。 */
			setThinkingLevel?(level: string): void;
			/** P1-04：列出会话目录下的会话（仅用于归属校验后的浏览）。 */
			listSessions?(): Promise<Array<{ path: string; id: string; name?: string; modified: number; messageCount: number }>>;
			/** P1-04：当前会话名称。 */
			sessionName?(): string | undefined;
			/** P1-04：重命名当前会话（写入 Pi transcript）。 */
			setSessionName?(name: string): void;
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
