/**
 * 飞书 WS 长连 transport：lark SDK 包装 + bot 身份水合 + 事件分发 + 连接状态。
 * 设计依据：docs/DESIGN.md §3.2。
 * 关键决策（参考 pi-feishu-link 实机验证）：
 * - WSClient autoReconnect:false，由上层受控退避重连；
 * - bot 身份水合 GET /open-apis/bot/v3/info（openId + name 一起水合，hermes 设计）；
 * - 事件负载可能被 SDK 包成 { event: {...} }，统一剥壳。
 */
import type { BotIdentity, BridgeConfig, FeishuInboundMessage } from "../types.js";

// ---- 结构接口（真实 @larksuiteoapi/node-sdk 满足；测试注入 fake）----

export interface LarkSdkClient {
	request(opts: { url: string; method: string; params?: unknown; data?: unknown; headers?: Record<string, string> }): Promise<unknown>;
}

export interface LarkSdkDispatcher {
	register(handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>): LarkSdkDispatcher;
}

export interface LarkSdkWsClient {
	start(opts: { eventDispatcher: LarkSdkDispatcher }): void;
	stop(): Promise<void>;
}

export interface LarkSdkLike {
	Domain: { Feishu: string; Lark: string };
	Client: new (opts: { appId: string; appSecret: string; appType: number; domain: string; loggerLevel?: number }) => LarkSdkClient;
	WSClient: new (opts: {
		appId: string;
		appSecret: string;
		domain?: string;
		autoReconnect?: boolean;
		onReady?: () => void;
		onError?: (err: unknown) => void;
	}) => LarkSdkWsClient;
	EventDispatcher: new (opts?: { loggerLevel?: number }) => LarkSdkDispatcher;
}

export interface TransportEventMap {
	message: FeishuInboundMessage;
	status: { connState: string; reconnectCount: number };
}

export interface TransportDeps {
	config: BridgeConfig;
	sdk: LarkSdkLike;
	onMessage: (msg: FeishuInboundMessage) => Promise<void>;
	onStatus?: (connState: string, reconnectCount: number) => void;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	probeTtlMs?: number; // 测试注入
}

export interface BotProbeResult {
	openId?: string;
	name?: string;
	userId?: string;
}

export class FeishuTransport {
	private client: LarkSdkClient | undefined;
	private wsClient: LarkSdkWsClient | undefined;
	private wsReady = false;
	private running = false;
	private reconnectCount = 0;
	private botIdentity: BotIdentity = {};
	private probeCache: { at: number; identity: BotIdentity } | undefined;

	constructor(private deps: TransportDeps) {}

	getBotIdentity(): BotIdentity {
		return this.botIdentity;
	}

	isConnected(): boolean {
		return this.wsReady;
	}

	isRunning(): boolean {
		return this.running;
	}

	async start(): Promise<void> {
		if (this.running) return;
		const { sdk, config } = this.deps;
		const domain = config.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
		this.client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret, appType: 0, domain });

		// bot 身份水合（hermes 设计：不依赖 env/时序；失败不阻塞启动，降级为空）
		this.botIdentity = await this.hydrateBotIdentity();
		if (!this.botIdentity.openId && config.botOpenId) this.botIdentity.openId = config.botOpenId;
		if (!this.botIdentity.name && config.botName) this.botIdentity.name = config.botName;
		this.deps.log?.("info", "feishu.transport.bot_identity", this.botIdentity);

		const dispatcher = new sdk.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
			"im.message.message_read_v1": async () => undefined,
			"im.message.recalled_v1": async () => undefined,
			"im.chat.member.bot.added_v1": async () => undefined,
			"im.chat.member.bot.removed_v1": async () => undefined,
			"im.message.reaction.created_v1": async () => undefined,
		});

		this.wsClient = new sdk.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			autoReconnect: false,
			onReady: () => {
				this.wsReady = true;
				this.reconnectCount = 0;
				this.deps.onStatus?.("connected", this.reconnectCount);
				this.deps.log?.("info", "feishu.transport.ws_ready");
			},
			onError: (err: unknown) => {
				this.wsReady = false;
				this.deps.onStatus?.("error", this.reconnectCount);
				this.deps.log?.("error", "feishu.transport.ws_error", {
					error: err instanceof Error ? err.message : String(err),
				});
			},
		});
		this.running = true;
		try {
			this.wsClient.start({ eventDispatcher: dispatcher });
		} catch (err) {
			this.running = false;
			throw err;
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		this.wsReady = false;
		try {
			await this.wsClient?.stop();
		} catch {
			/* ignore */
		}
		this.wsClient = undefined;
	}

	/** 拉取被回复消息原文（B1 关键：回复链路可见性）。失败返回 undefined。 */
	async getMessageText(messageId: string): Promise<string | undefined> {
		try {
			const res = (await this.authedRequest({ url: `/open-apis/im/v1/messages/${messageId}`, method: "GET" })) as Record<string, unknown>;
			const data = (res?.data ?? res) as Record<string, unknown>;
			const items = Array.isArray(data?.items) ? (data.items as Array<Record<string, unknown>>) : undefined;
			const msg = (items?.[0] ?? data?.message ?? data) as Record<string, unknown> | undefined;
			if (!msg) return undefined;
			const content = typeof msg.content === "string" ? msg.content : undefined;
			if (!content) return undefined;
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text;
			} catch {
				/* fallthrough */
			}
			return content;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.quote_fetch_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	/** 受控重连：transport 层不自动重连，由 supervisor 调用（指数退避在 supervisor）。 */
	async reconnect(): Promise<void> {
		this.reconnectCount += 1;
		await this.stop();
		await this.start();
	}

	// ------------------------------------------------------------ REST ----

	/** 带 tenant token 的 REST 请求（lark SDK client.request 自动附 token）。 */
	async authedRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		if (!this.client) throw new Error("transport not started");
		return this.client.request({ ...opts, method: opts.method });
	}

	/** REST 出站原语（sender 复用同一 client）。 */
	async rawRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		if (!this.client) throw new Error("transport not started");
		return this.client.request({ ...opts, method: opts.method });
	}

	/** bot 身份水合：/open-apis/bot/v3/info（带 TTL 缓存，避免高频重启打爆接口）。 */
	async hydrateBotIdentity(): Promise<BotIdentity> {
		const ttl = this.deps.probeTtlMs ?? 60_000;
		if (this.probeCache && Date.now() - this.probeCache.at < ttl) return this.probeCache.identity;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const res = (await this.authedRequest({ url: "/open-apis/bot/v3/info", method: "GET" })) as Record<string, unknown>;
				const data = (res?.bot ?? res?.data ?? res) as Record<string, unknown>;
				const identity: BotIdentity = {
					openId: typeof data.open_id === "string" ? data.open_id : undefined,
					name:
						typeof data.bot_name === "string"
							? data.bot_name
							: typeof data.app_name === "string"
								? data.app_name
								: typeof data.name === "string"
									? data.name
									: undefined,
					userId: typeof data.user_id === "string" ? data.user_id : undefined,
				};
				if (identity.openId || identity.name) {
					this.probeCache = { at: Date.now(), identity };
					return identity;
				}
			} catch (err) {
				this.deps.log?.("error", "feishu.transport.bot_probe_failed", {
					error: err instanceof Error ? err.message : String(err),
					attempt,
				});
				if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
			}
		}
		return {};
	}

	// ------------------------------------------------------------ 入站 ----

	/**
	 * 事件解包：SDK 可能传 { event: {...} }，也可能直接传事件体。
	 * 消息字段在 event.message 子对象、sender 在 event 顶层。
	 */
	private async handleRawMessage(raw: unknown): Promise<void> {
		const root = (raw ?? {}) as Record<string, unknown>;
		const body = (root.event ?? root) as Record<string, unknown>;
		const msg = (body.message ?? body) as Record<string, unknown>;
		const messageId = typeof msg.message_id === "string" ? msg.message_id : undefined;
		if (!messageId) {
			this.deps.log?.("debug", "feishu.transport.drop_malformed", { raw });
			return;
		}
		const sender = (body.sender ?? msg.sender ?? {}) as Record<string, unknown>;
		const senderIdObj = (sender.sender_id ?? {}) as Record<string, unknown>;

		// 组装 normalize 输入（保持与 normalize.ts 的纯函数约定）
		const normalized = await this.normalizeInbound({
			messageId,
			chatId: (msg.chat_id as string) ?? "",
			chatType: (msg.chat_type as string) ?? "p2p",
			messageType: (msg.message_type as string) ?? "text",
			content: (msg.content as string) ?? "",
			sender: { sender_id: senderIdObj, sender_type: sender.sender_type },
			mentions: Array.isArray(msg.mentions) ? (msg.mentions as unknown[]) : undefined,
			parentId: typeof msg.parent_id === "string" ? msg.parent_id : undefined,
			upperMessageId: typeof msg.upper_message_id === "string" ? msg.upper_message_id : undefined,
			rootId: typeof msg.root_id === "string" ? msg.root_id : undefined,
			threadId: typeof msg.thread_id === "string" ? msg.thread_id : undefined,
			bot: this.botIdentity,
		});

		if (!normalized) return;
		// 自身回声防御
		if (normalized.isBot && normalized.senderId === this.botIdentity.openId) {
			this.deps.log?.("debug", "feishu.transport.drop_self_echo", { messageId });
			return;
		}
		await this.deps.onMessage(normalized);
	}

	/** 规范化（委托给 normalize.ts 纯函数；供测试与 transport 共用）。 */
	async normalizeInbound(input: Parameters<typeof import("./normalize.js").normalizeFeishuMessage>[0]): Promise<FeishuInboundMessage | undefined> {
		const { normalizeFeishuMessage } = await import("./normalize.js");
		const out = normalizeFeishuMessage(input);
		if (!out.messageId) return undefined;
		return out;
	}
}
