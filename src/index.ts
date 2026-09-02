/**
 * pi-feishu-bridge 扩展入口：装配 transport/pipeline/session/sender/outbox，
 * 提供 /feishu 命令与连接 supervisor（指数退避重连）。
 * 设计依据：docs/DESIGN.md §2/§3.7。
 */
import type { ExtensionAPI } from "./pi-types.js";
import type { BridgeConfig, BridgeStatus, GroupPolicy } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { loadConfig, resolvePaths, saveConfig } from "./config.js";
import { FeishuTransport } from "./inbound/transport.js";
import { InboundPipeline } from "./inbound/pipeline.js";
import { LastSentCache, admit } from "./inbound/admit.js";
import { Sender } from "./outbound/sender.js";
import { Outbox } from "./outbound/outbox.js";
import { ConversationManager } from "./session/conversation-manager.js";
import { PiSessionBackend } from "./session/pi-session-backend.js";

export interface BridgeLogger {
	debug(msg: string, meta?: unknown): void;
	info(msg: string, meta?: unknown): void;
	warn(msg: string, meta?: unknown): void;
	error(msg: string, meta?: unknown): void;
}

export interface BridgeDeps {
	homeDir: string;
	env?: NodeJS.ProcessEnv;
	log?: BridgeLogger;
	now?: () => number;
}

const MAX_RECONNECT_DELAY_MS = 60_000;

export default function feishuBridgeExtension(pi: ExtensionAPI) {
	let started = false;
	let stopping = false;
	let transport: FeishuTransport | undefined;
	let pipeline: InboundPipeline | undefined;
	let convManager: ConversationManager | undefined;
	let sender: Sender | undefined;
	let outbox: Outbox | undefined;
	let lastSent: LastSentCache | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempts = 0;
	let config: BridgeConfig = DEFAULT_CONFIG;
	let homeDir = "";
	let status: BridgeStatus = { connState: "disconnected", reconnectCount: 0, conversations: 0, outboxDepth: 0, messageTotal: 0, messageDropped: 0 };

	const log: BridgeLogger = {
		debug: (m, meta) => console.debug(`[feishu-bridge] ${m}`, meta ?? ""),
		info: (m, meta) => console.log(`[feishu-bridge] ${m}`, meta ?? ""),
		warn: (m, meta) => console.warn(`[feishu-bridge] ${m}`, meta ?? ""),
		error: (m, meta) => console.error(`[feishu-bridge] ${m}`, meta ?? ""),
	};

	function setStatus(key: "conn" | "bridge", text: string): void {
		try {
			pi.ui.setStatus(`feishu-${key}`, text);
		} catch {
			/* no-ui */
		}
	}

	function updateStatus(): void {
		const stats = pipeline?.getStats();
		status = {
			connState: transport?.isConnected() ? "connected" : transport?.isRunning() ? "connecting" : "disconnected",
			reconnectCount: reconnectAttempts,
			startedAt: status.startedAt,
			botOpenId: transport?.getBotIdentity().openId,
			botName: transport?.getBotIdentity().name,
			conversations: convManager?.count() ?? 0,
			outboxDepth: outbox?.depth() ?? 0,
			lastMessageAt: stats?.lastMessageAt,
			messageTotal: stats?.total ?? 0,
			messageDropped: stats?.dropped ?? 0,
		};
	}

	async function assemble(): Promise<void> {
		const paths = resolvePaths(homeDir);
		const { createFeishuTransport } = await import("./inbound/transport-factory.js");
		transport = await createFeishuTransport(config, {
			onMessage: async (msg) => {
				await pipeline?.handle(msg);
			},
			onStatus: (connState, reconnectCount) => {
				reconnectAttempts = reconnectCount;
				setStatus("conn", connState === "connected" ? "飞书桥已连接" : `飞书桥 ${connState}`);
				updateStatus();
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		lastSent = new LastSentCache(config.lastSentCacheSize);
		sender = new Sender({
			config,
			transport,
			onSent: (chatId, messageId) => {
				lastSent?.record(messageId);
				convManager?.updateLastReplyId(chatId, messageId);
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		outbox = new Outbox({
			file: paths.outboxFile,
			send: async (chatId, content, opts) => sender!.send(chatId, content, opts),
			log: (level, m, meta) => log[level](m, meta),
		});

		convManager = new ConversationManager({
			config,
			sessionDir: paths.sessionDir,
			sessionBackend: new PiSessionBackend({ sessionDir: paths.sessionDir, log: (l, m, x) => log[l](m, x) }),
			pendingFile: join(paths.sessionDir, "..", "pending.jsonl"),
			sender,
			editMessage: (messageId, text) => transport?.editMessage(messageId, text) ?? Promise.resolve(false),
			recallMessage: (messageId) => transport?.recallMessage(messageId) ?? Promise.resolve(false),
			lastSent,
			reactions: {
				add: (messageId, emoji) => transport!.addReaction(messageId, emoji),
				remove: (messageId, reactionId) => transport!.removeReaction(messageId, reactionId),
			},
			log: (level, m, meta) => log[level](m, meta),
		});

		pipeline = new InboundPipeline({
			config,
			transport,
			lastSent,
			onDispatch: async (msg) => convManager!.route(msg),
			log: (level, m, meta) => log[level](m, meta),
		});
	}

	async function startBridge(): Promise<string> {
		if (started) return "already";
		started = true;
		stopping = false;
		status.startedAt = Date.now();
		try {
			await assemble();
			await transport!.start();
			setStatus("conn", "飞书桥启动中…");
			setStatus("bridge", "飞书桥已启动");
			log.info("bridge started", { bot: transport?.getBotIdentity() });
			updateStatus();
			return "started";
		} catch (err) {
			started = false;
			const msg = err instanceof Error ? err.message : String(err);
			log.error("bridge start failed", { error: msg });
			setStatus("bridge", `飞书桥启动失败: ${msg.slice(0, 60)}`);
			return `启动失败：${msg}`;
		}
	}

	async function stopBridge(): Promise<string> {
		stopping = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
		try {
			await transport?.stop();
		} catch {
			/* ignore */
		}
		pipeline?.stop();
		outbox?.stop();
		started = false;
		setStatus("bridge", "飞书桥已停止");
		return "stopped";
	}

	/** 受控重连：指数退避 + 抖动（1s → 60s）。 */
	function scheduleReconnect(): void {
		if (!started || stopping) return;
		if (transport?.isConnected()) return;
		const delay = Math.min(1_000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS) + Math.random() * 500;
		reconnectAttempts += 1;
		setStatus("conn", `飞书桥重连中（第 ${reconnectAttempts} 次）`);
		log.warn("transport reconnect scheduled", { attempts: reconnectAttempts, delay });
		reconnectTimer = setTimeout(async () => {
			reconnectTimer = undefined;
			if (!started || stopping) return;
			try {
				await transport?.reconnect();
			} catch (err) {
				log.error("reconnect failed", { error: err instanceof Error ? err.message : String(err) });
			}
			scheduleReconnect();
		}, delay);
	}

	// 轮询监督（1s）：WS 掉线且已过握手宽限期（15s）未恢复 → 调度重连。
	// 宽限期避免首次启动时 watchdog 在 SDK 握手完成前误判掉线（触发多余重连）。
	const HAND_SHAKE_GRACE_MS = 15_000;
	const watchdog = setInterval(() => {
		if (started && !stopping && transport?.isRunning() && !transport?.isConnected() && !reconnectTimer) {
			const connectingSince = transport.getConnectStartedAt();
			if (connectingSince === 0 || Date.now() - connectingSince > HAND_SHAKE_GRACE_MS) {
				scheduleReconnect();
			}
		}
	}, 1_000);
	watchdog.unref?.();

	// ------------------------------------------------------------ 命令 ----

	function statusText(): string {
		updateStatus();
		const lines = [
			`连接: ${status.connState}（重连 ${status.reconnectCount} 次）`,
			`bot: ${status.botName ?? "?"} (${status.botOpenId ?? "?"})`,
			`会话数: ${status.conversations}`,
			`outbox: ${status.outboxDepth}`,
			`消息: 总 ${status.messageTotal} / 丢弃 ${status.messageDropped}`,
			`策略: 全局 ${config.groupPolicy}${Object.keys(config.groupPolicyByChat).length ? `，覆盖 ${JSON.stringify(config.groupPolicyByChat)}` : ""}`,
			`群白名单: ${config.allowChats.length ? config.allowChats.join(", ") : "（全部群按策略）"}`,
		];
		if (status.lastMessageAt) lines.push(`最近消息: ${new Date(status.lastMessageAt).toLocaleTimeString()}`);
		return lines.join("\n");
	}

	pi.registerCommand("feishu:status", {
		description: "飞书桥状态",
		handler: () => statusText(),
	});
	pi.registerCommand("feishu:start", {
		description: "启动飞书桥",
		handler: async () => startBridge(),
	});
	pi.registerCommand("feishu:stop", {
		description: "停止飞书桥",
		handler: async () => stopBridge(),
	});
	pi.registerCommand("feishu:restart", {
		description: "重启飞书桥",
		handler: async () => {
			await stopBridge();
			return startBridge();
		},
	});
	pi.registerCommand("feishu:policy", {
		description: "设置单群策略：/feishu:policy <chatId> <open|mention|disabled|allowlist>",
		handler: (_args, _ctx, args: string[]) => {
			const [chatId, policy] = args;
			const valid: GroupPolicy[] = ["open", "mention", "disabled", "allowlist"];
			if (!chatId || !policy || !valid.includes(policy as GroupPolicy)) {
				return "用法：/feishu:policy <chatId> <open|mention|disabled|allowlist>";
			}
			config.groupPolicyByChat[chatId] = policy as GroupPolicy;
			const saved = saveConfig(homeDir, config);
			return `已设置 ${chatId} → ${policy}${saved ? "（已落盘）" : "（落盘失败，仅本次会话生效）"}`;
		},
	});
	pi.registerCommand("feishu:debug", {
		description: "开关 debug 日志：/feishu:debug on|off",
		handler: (_args, _ctx, args: string[]) => {
			const flag = args[0];
			if (flag !== "on" && flag !== "off") return "用法：/feishu:debug on|off";
			config.debug = flag === "on";
			saveConfig(homeDir, config);
			return `debug = ${config.debug}`;
		},
	});

	// ------------------------------------------------------------ 生命周期 ----

	// 工具执行进度（方案 A）：tool_execution_start/end → 进度消息更新
	// （daemon-host 架构下主进程可收到子进程 agent 的工具事件，pi-feishu-link 同款用法）
	pi.on("tool_execution_start", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const ev = event as { toolName?: string; args?: unknown };
		const toolName = ev.toolName ?? "tool";
		convManager?.onToolEvent(sessionId, toolName, "start", (ev.args ?? {}) as Record<string, unknown>);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const toolName = (event as { toolName?: string })?.toolName ?? "tool";
		convManager?.onToolEvent(sessionId, toolName, "end");
	});

	pi.on("session_start", async () => {
		homeDir = process.env.FEISHU_BRIDGE_HOME ?? pi.getAgentDir();
		config = loadConfig(homeDir);
		if (!config.appId || !config.appSecret) {
			log.warn("FEISHU_APP_ID/SECRET 未配置，桥未启动。请配置后运行 /feishu:start。");
			return;
		}
		await startBridge();
		// 网关重启恢复：重发上次中断的未完成消息（hermes resume_pending）
		const recovered = await convManager?.recoverPending() ?? 0;
		if (recovered > 0) log.warn("bridge recovered pending messages", { count: recovered });
	});

	// 优雅关闭：docker stop/restart 时撤回进行中的进度消息与 Typing 表情，
	// 避免残留"🤖 正在处理…"消息和敲键盘表情（kill -9 时由 recoverPending 兜底重发）。
	process.on("SIGTERM", () => {
		void convManager?.shutdown().finally(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	});

	pi.on("session_shutdown", async () => {
		stopping = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		clearInterval(watchdog);
		await stopBridge();
	});
}
