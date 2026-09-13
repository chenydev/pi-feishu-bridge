/**
 * 飞书 WS 长连 transport：lark SDK 包装 + bot 身份水合 + 事件分发 + 连接状态。
 * 设计依据：docs/DESIGN.md §3.2。
 * 关键决策（参考 pi-feishu-link 实机验证）：
 * - WSClient autoReconnect:false，由上层受控退避重连；
 * - bot 身份水合 GET /open-apis/bot/v3/info（openId + name 一起水合，hermes 设计）；
 * - 事件负载可能被 SDK 包成 { event: {...} }，统一剥壳。
 */
import type { BotIdentity, BridgeConfig, FeishuInboundMessage } from "../types.js";
import type { ResourceRef } from "../types.js";
import type { Readable } from "node:stream";

// ---- 结构接口（真实 @larksuiteoapi/node-sdk 满足；测试注入 fake）----

export interface LarkSdkClient {
	request(opts: { url: string; method: string; params?: unknown; data?: unknown; headers?: Record<string, string> }): Promise<unknown>;
	im?: { v1?: {
		messageResource?: { get(payload: { params: { type: string }; path: { message_id: string; file_key: string } }): Promise<{ getReadableStream(): Readable; headers?: Record<string, unknown> }> };
		image?: { create(payload: { data: { image_type: "message"; image: Buffer } }): Promise<unknown> };
		file?: { create(payload: { data: { file_type: "stream" | "mp4" | "opus"; file_name: string; file: Buffer } }): Promise<unknown> };
	} };
}

export interface LarkSdkDispatcher {
	register(handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>): LarkSdkDispatcher;
}

export interface LarkSdkWsClient {
	start(opts: { eventDispatcher: LarkSdkDispatcher }): void;
	close(params?: { force?: boolean }): void;
	getConnectionStatus?(): string | { state?: string };
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
	onCardAction?: (action: CardAction) => Promise<unknown>;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	probeTtlMs?: number; // 测试注入
	now?: () => number;
}

export interface CardAction {
	messageId: string;
	chatId?: string;
	operatorOpenId: string;
	value?: Record<string, unknown>;
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
	/** 最近一次 start() 的时间戳：上层 watchdog 据此宽限握手期，避免误判重连。 */
	private connectStartedAt = 0;
	private downSince: number | undefined;
	private generation = 0;
	/** 仅显式 start/stop 改变，用于使并发 reconnect 意图失效。 */
	private lifecycleIntent = 0;
	private startPromise: Promise<void> | undefined;
	private reconnectPromise: Promise<void> | undefined;
	private readonly now: () => number;

	constructor(private deps: TransportDeps) {
		this.now = deps.now ?? Date.now;
	}

	getBotIdentity(): BotIdentity {
		return this.botIdentity;
	}

	getConnectStartedAt(): number {
		return this.connectStartedAt;
	}

	getDownSince(): number | undefined {
		return this.downSince;
	}

	isConnected(): boolean {
		const sdkStatus = this.wsClient?.getConnectionStatus?.();
		const sdkState = typeof sdkStatus === "string" ? sdkStatus : sdkStatus?.state;
		if (sdkState && sdkState !== "connected" && this.wsReady && this.running) this.markDisconnected(new Error(`ws state ${sdkState}`));
		return this.wsReady;
	}

	isRunning(): boolean {
		return this.running;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.startPromise) return this.startPromise;
		this.lifecycleIntent += 1;
		this.startPromise = this.doStart();
		try {
			await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	private async doStart(): Promise<void> {
		const { sdk, config } = this.deps;
		const generation = ++this.generation;
		this.running = true;
		this.connectStartedAt = this.now();
		const domain = config.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
		this.closeWs();
		this.client = new sdk.Client({ appId: config.appId, appSecret: config.appSecret, appType: 0, domain });

		// bot 身份水合（hermes 设计：不依赖 env/时序；失败不阻塞启动，降级为空）
		this.botIdentity = await this.hydrateBotIdentity();
		if (!this.running || generation !== this.generation) return;
		if (!this.botIdentity.openId && config.botOpenId) this.botIdentity.openId = config.botOpenId;
		if (!this.botIdentity.name && config.botName) this.botIdentity.name = config.botName;
		this.deps.log?.("info", "feishu.transport.bot_identity", this.botIdentity);

		const dispatcher = new sdk.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
			"card.action.trigger": async (data: unknown) => this.handleCardAction(data),
			"im.message.message_read_v1": async () => undefined,
			"im.message.recalled_v1": async () => undefined,
			"im.chat.member.bot.added_v1": async () => undefined,
			"im.chat.member.bot.removed_v1": async () => undefined,
			"im.message.reaction.created_v1": async () => undefined,
			// 撤回自身表情也会收到 deleted 事件：注册空 handler 消除 SDK warn
			"im.message.reaction.deleted_v1": async () => undefined,
		});

		this.wsClient = new sdk.WSClient({
			appId: config.appId,
			appSecret: config.appSecret,
			autoReconnect: false,
			onReady: () => {
				if (!this.running || generation !== this.generation) return;
				this.wsReady = true;
				this.connectStartedAt = 0;
				this.downSince = undefined;
				this.reconnectCount = 0;
				this.deps.onStatus?.("connected", this.reconnectCount);
				this.deps.log?.("info", "feishu.transport.ws_ready");
			},
			onError: (err: unknown) => {
				if (generation === this.generation) this.markDisconnected(err);
			},
		});
		try {
			this.wsClient.start({ eventDispatcher: dispatcher });
		} catch (err) {
			this.markDisconnected(err);
			this.running = false;
			throw err;
		}
	}

	private markDisconnected(error: unknown): void {
		if (!this.running) return;
		this.wsReady = false;
		this.downSince ??= this.now();
		this.deps.onStatus?.("error", this.reconnectCount);
		this.deps.log?.("error", "feishu.transport.ws_error", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	async stop(): Promise<void> {
		this.lifecycleIntent += 1;
		this.stopTransport();
	}

	private stopTransport(): void {
		this.running = false;
		this.wsReady = false;
		this.connectStartedAt = 0;
		this.generation += 1;
		this.closeWs();
	}

	/** 关闭当前 WSClient（close({force}) 真正断连；旧版 SDK 的 stop 不存在 → 泄漏）。 */
	private closeWs(): void {
		try {
			this.wsClient?.close({ force: true });
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
			// 实测（2026-09-02）：content 在 body.content（嵌套 JSON），顶层 content 缺失
			const body = (msg.body ?? {}) as Record<string, unknown>;
			const content = typeof msg.content === "string" ? msg.content : typeof body.content === "string" ? body.content : undefined;
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
		if (this.reconnectPromise) return this.reconnectPromise;
		this.reconnectPromise = (async () => {
			const lifecycleIntent = this.lifecycleIntent;
			this.reconnectCount += 1;
			this.stopTransport();
			// 给并发的显式 stop 一个失效本次重连意图的机会。
			await Promise.resolve();
			if (this.lifecycleIntent !== lifecycleIntent) return;
			await this.start();
		})();
		try {
			await this.reconnectPromise;
		} finally {
			this.reconnectPromise = undefined;
		}
	}

	/** 获取单个 chat 的有界历史消息，供短时断线补收。 */
	async listChatHistory(chatId: string, startTimeMs: number, endTimeMs: number, limit = 50): Promise<FeishuInboundMessage[]> {
		const res = (await this.authedRequest({
			url: "/open-apis/im/v1/messages",
			method: "GET",
			params: {
				container_id_type: "chat_id",
				container_id: chatId,
				start_time: String(Math.floor(startTimeMs / 1000)),
				end_time: String(Math.ceil(endTimeMs / 1000)),
				sort_type: "ByCreateTimeAsc",
				page_size: Math.max(1, Math.min(50, limit)),
			},
		})) as Record<string, unknown>;
		const data = (res.data ?? res) as Record<string, unknown>;
		const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
		const output: FeishuInboundMessage[] = [];
		for (const item of items.slice(0, limit)) {
			const body = (item.body ?? {}) as Record<string, unknown>;
			const sender = (item.sender ?? {}) as Record<string, unknown>;
			const rawSenderId = sender.id ?? sender.sender_id ?? {};
			const idType = typeof sender.id_type === "string" ? sender.id_type : "open_id";
			const senderId = typeof rawSenderId === "string" ? { [idType]: rawSenderId } : rawSenderId as Record<string, unknown>;
			const normalized = await this.normalizeInbound({
				messageId: typeof item.message_id === "string" ? item.message_id : "",
				chatId: typeof item.chat_id === "string" ? item.chat_id : chatId,
				chatType: typeof item.chat_type === "string" ? item.chat_type : "group",
				messageType: typeof item.msg_type === "string" ? item.msg_type : typeof item.message_type === "string" ? item.message_type : "text",
				content: typeof body.content === "string" ? body.content : typeof item.content === "string" ? item.content : "",
				sender: { sender_id: senderId, sender_type: sender.sender_type },
				mentions: Array.isArray(item.mentions) ? item.mentions : undefined,
				parentId: typeof item.parent_id === "string" ? item.parent_id : undefined,
				rootId: typeof item.root_id === "string" ? item.root_id : undefined,
				threadId: typeof item.thread_id === "string" ? item.thread_id : undefined,
				bot: this.botIdentity,
			});
			if (normalized) output.push(normalized);
		}
		return output;
	}

	async downloadResource(ref: ResourceRef, maxBytes: number): Promise<{ buffer: Buffer; mimeType?: string }> {
		const messageResource = this.client?.im?.v1?.messageResource;
		if (!messageResource) throw new Error("messageResource.get unavailable");
		const response = await messageResource.get({
			params: { type: ref.kind === "image" ? "image" : "file" },
			path: { message_id: ref.messageId, file_key: ref.key },
		});
		const headers = response.headers ?? {};
		const declared = Number(headers["content-length"] ?? headers["Content-Length"] ?? 0);
		if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`resource too large: ${declared} > ${maxBytes}`);
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of response.getReadableStream()) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
			total += buffer.length;
			if (total > maxBytes) throw new Error(`resource too large: ${total} > ${maxBytes}`);
			chunks.push(buffer);
		}
		const contentType = headers["content-type"] ?? headers["Content-Type"];
		return { buffer: Buffer.concat(chunks), mimeType: typeof contentType === "string" ? contentType.split(";")[0]?.trim() : undefined };
	}

	async uploadImage(image: Buffer): Promise<string> {
		const api = this.client?.im?.v1?.image;
		if (!api) throw new Error("image.create unavailable");
		const response = await api.create({ data: { image_type: "message", image } }) as { image_key?: string; data?: { image_key?: string } };
		const key = response.data?.image_key ?? response.image_key;
		if (!key) throw new Error("upload image failed: no image_key");
		return key;
	}

	async uploadFile(fileName: string, file: Buffer, fileType: "stream" | "mp4" | "opus" = "stream"): Promise<string> {
		const api = this.client?.im?.v1?.file;
		if (!api) throw new Error("file.create unavailable");
		const response = await api.create({ data: { file_type: fileType, file_name: fileName, file } }) as { file_key?: string; data?: { file_key?: string } };
		const key = response.data?.file_key ?? response.file_key;
		if (!key) throw new Error("upload file failed: no file_key");
		return key;
	}

	async sendCard(chatId: string, card: unknown, opts: { replyTo?: string; threadId?: string } = {}): Promise<string | undefined> {
		const response = await this.rawRequest(opts.replyTo ? {
			url: `/open-apis/im/v1/messages/${opts.replyTo}/reply`, method: "POST",
			data: { msg_type: "interactive", content: JSON.stringify(card), reply_in_thread: Boolean(opts.threadId) },
		} : {
			url: "/open-apis/im/v1/messages", method: "POST",
			params: opts.threadId ? { receive_id_type: "thread_id" } : { receive_id_type: "chat_id" },
			data: { receive_id: opts.threadId ?? chatId, msg_type: "interactive", content: JSON.stringify(card) },
		}) as { data?: { message_id?: string } };
		return response.data?.message_id;
	}

	private async handleCardAction(data: unknown): Promise<unknown> {
		const outer = data as Record<string, unknown>;
		const context = (outer.context ?? outer) as Record<string, unknown>;
		const operator = (outer.operator ?? {}) as Record<string, unknown>;
		const action = (outer.action ?? {}) as Record<string, unknown>;
		const messageId = context.open_message_id ?? context.message_id ?? outer.open_message_id;
		const operatorOpenId = operator.open_id;
		if (typeof messageId !== "string" || typeof operatorOpenId !== "string") return undefined;
		const rawChatId = context.open_chat_id ?? context.chat_id ?? outer.open_chat_id;
		return this.deps.onCardAction?.({
			messageId,
			chatId: typeof rawChatId === "string" ? rawChatId : undefined,
			operatorOpenId,
			value: action.value && typeof action.value === "object" ? action.value as Record<string, unknown> : undefined,
		});
	}

	// ------------------------------------------------------------ REST ----

	/** 带 tenant token 的 REST 请求（lark SDK client.request 自动附 token）。 */
	async authedRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		if (!this.client) throw new Error("transport not started");
		return this.client.request({ ...opts, method: opts.method });
	}

	/** 添加表情回应（hermes 式"处理中"指示）：POST reactions。返回 reaction_id。 */
	async addReaction(messageId: string, emoji: string): Promise<string | undefined> {
		try {
			const res = (await this.authedRequest({
				url: `/open-apis/im/v1/messages/${messageId}/reactions`,
				method: "POST",
				data: { reaction_type: { emoji_type: emoji } },
			})) as Record<string, unknown>;
			const data = (res?.data ?? res) as Record<string, unknown>;
			const reactionId = typeof data?.reaction_id === "string" ? data.reaction_id : undefined;
			return reactionId;
		} catch (err) {
			this.deps.log?.("debug", "feishu.transport.reaction_add_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	/** 移除表情回应（处理完成）。 */
	async removeReaction(messageId: string, reactionId: string): Promise<boolean> {
		try {
			await this.authedRequest({
				url: `/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
				method: "DELETE",
			});
			return true;
		} catch (err) {
			this.deps.log?.("debug", "feishu.transport.reaction_remove_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/** REST 出站原语（sender 复用同一 client）。 */
	async rawRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		if (!this.client) throw new Error("transport not started");
		return this.client.request({ ...opts, method: opts.method });
	}

	/** 进度消息：编辑已发消息内容（飞书 im.v1.message.update 是 PUT——PATCH 会 400）。 */
	async editMessage(messageId: string, text: string): Promise<boolean> {
		try {
			await this.client?.request({
				url: `/open-apis/im/v1/messages/${messageId}`,
				method: "PUT",
				data: { content: JSON.stringify({ text }), msg_type: "text" },
			});
			return true;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.edit_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	/** 进度消息：撤回消息（im.v1.message.recall）。 */
	async recallMessage(messageId: string): Promise<boolean> {
		try {
			await this.client?.request({
				url: `/open-apis/im/v1/messages/${messageId}`,
				method: "DELETE",
			});
			return true;
		} catch (err) {
			this.deps.log?.("warn", "feishu.transport.recall_failed", {
				messageId,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
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
			this.deps.log?.("debug", "feishu.transport.drop_malformed", {
				rawType: Array.isArray(raw) ? "array" : typeof raw,
				keys: raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>).slice(0, 12) : [],
			});
			return;
		}
		const sender = (body.sender ?? msg.sender ?? {}) as Record<string, unknown>;
		const senderIdObj = (sender.sender_id ?? {}) as Record<string, unknown>;

		// 探针：确认 mentions 原始结构（key/name 是否存在）
		if (Array.isArray(msg.mentions) && msg.mentions.length > 0) {
			this.deps.log?.("debug", "feishu.transport.mentions_probe", {
				count: msg.mentions.length,
				shapes: (msg.mentions as Record<string, unknown>[]).map((m) => ({
					hasKey: typeof m.key === "string",
					hasName: typeof m.name === "string",
					hasOpenId: typeof (m.id as Record<string, unknown> | undefined)?.open_id === "string",
				})),
			});
		} else {
			this.deps.log?.("debug", "feishu.transport.mentions_probe", { count: 0, raw: msg.mentions === undefined ? "undefined" : "empty" });
		}

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
