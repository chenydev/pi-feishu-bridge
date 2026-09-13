/**
 * pi-feishu-bridge 扩展入口：装配 transport/pipeline/session/sender/outbox，
 * 提供 /feishu 命令与连接 supervisor（指数退避重连）。
 * 设计依据：docs/DESIGN.md §2/§3.7。
 */
import { join } from "node:path";
import type { ExtensionAPI } from "./pi-types.js";
import type { BridgeConfig, BridgeStatus, GroupPolicy } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { loadConfig, resolveAppLockFile, resolvePaths, saveConfig } from "./config.js";
import { FeishuTransport } from "./inbound/transport.js";
import { InboundPipeline } from "./inbound/pipeline.js";
import { LastSentCache, admit } from "./inbound/admit.js";
import { Sender } from "./outbound/sender.js";
import { Outbox } from "./outbound/outbox.js";
import { ConversationManager } from "./session/conversation-manager.js";
import { PiSessionBackend } from "./session/pi-session-backend.js";
import { DedupeStore } from "./inbound/dedupe-store.js";
import { AppLock } from "./runtime/app-lock.js";
import { writeStatus } from "./runtime/status-store.js";
import { compensateKnownChats } from "./runtime/history-compensation.js";
import { ResourceResolver } from "./inbound/resource-resolver.js";
import { queueLocalFile } from "./outbound/local-file-tool.js";
import { PermissionBridge, redactParams, type ApprovalChoice } from "./approval/permission-bridge.js";
import { buildApprovalCard, buildApprovalResultCard } from "./approval/cards.js";
import type { CardAction } from "./inbound/transport.js";
import { formatDoctor, runDoctor } from "./runtime/doctor.js";
import { buildConversationKey } from "./session/conversation-key.js";
import { KnownChatStore } from "./runtime/known-chat-store.js";
import { formatSlashCommandHelp } from "./slash-commands.js";

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
	let permissionBridge: PermissionBridge | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempts = 0;
	let config: BridgeConfig = DEFAULT_CONFIG;
	let homeDir = "";
	let appLock: AppLock | undefined;
	let reportedConnState: BridgeStatus["connState"] = "disconnected";
	let downSince: number | undefined;
	let lastError: string | undefined;
	let knownChats: KnownChatStore | undefined;
	let compensatedMessages = 0;
	let compensationErrors = 0;
	let compensationTruncated = 0;
	let compensationPromise: Promise<void> | undefined;
	let lifecycleTail: Promise<void> = Promise.resolve();
	let status: BridgeStatus = {
		connState: "disconnected",
		reconnectCount: 0,
		conversations: 0,
		outboxDepth: 0,
		outbox: { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 },
		messageTotal: 0,
		messageDropped: 0,
		compensatedMessages: 0,
		compensationErrors: 0,
		compensationTruncated: 0,
	};

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
		const outboxStats = outbox?.stats() ?? { pending: 0, sending: 0, sent: 0, failed: 0, lanes: 0, oldestAgeMs: 0 };
		status = {
			appId: config.appId || undefined,
			pid: process.pid,
			updatedAt: Date.now(),
			connState: transport?.isConnected() ? "connected" : reportedConnState === "error" ? "error" : transport?.isRunning() ? "connecting" : "disconnected",
			downSince,
			lastError,
			reconnectCount: reconnectAttempts,
			startedAt: status.startedAt,
			botOpenId: transport?.getBotIdentity().openId,
			botName: transport?.getBotIdentity().name,
			conversations: convManager?.count() ?? 0,
			sessionQueues: convManager?.queueStats() ?? { queued: 0, active: 0, waiting: 0 },
			pendingApprovals: permissionBridge?.pendingCount() ?? 0,
			outboxDepth: outboxStats.pending + outboxStats.sending,
			outbox: outboxStats,
			lastMessageAt: stats?.lastMessageAt,
			messageTotal: stats?.total ?? 0,
			messageDropped: stats?.dropped ?? 0,
			compensatedMessages,
			compensationErrors,
			compensationTruncated,
		};
		if (homeDir) {
			try { writeStatus(resolvePaths(homeDir).statusFile, status); } catch (error) {
				log.error("status write failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	async function handleCardAction(action: CardAction): Promise<unknown> {
		const value = action.value ?? {};
		if (value.op !== "approval" || typeof value.approvalId !== "string" || typeof value.token !== "string") return undefined;
		const choice = value.choice;
		if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") return undefined;
		const decision = permissionBridge?.decide({
			id: value.approvalId, token: value.token, messageId: action.messageId, chatId: action.chatId,
			operatorOpenId: action.operatorOpenId, choice: choice as ApprovalChoice,
		});
		if (!decision?.ok) return { toast: { type: "warning", content: decision?.reason ?? "审批已失效" } };
		return {
			toast: { type: "success", content: decision.reason },
			card: { type: "raw", data: buildApprovalResultCard(decision.pending!.toolName, decision.reason) },
		};
	}

	async function handleFeishuCommand(msg: import("./types.js").FeishuInboundMessage): Promise<boolean> {
		const raw = msg.text.trim();
		const [command, ...args] = raw.split(/\s+/);
		const normalized = command.toLowerCase();
		const reply = (text: string) => {
			if (!outbox) throw new Error("outbox unavailable");
			outbox.enqueue(msg.chatId, text, { replyTo: msg.messageId, threadId: msg.threadId }, {
				dedupeKey: `${msg.messageId}:command`, laneKey: buildConversationKey(msg, config), kind: "notify",
			});
		};
		if (normalized === "/help" || normalized === "/commands"
			|| (normalized === "/feishu" && args[0]?.toLowerCase() === "help")) {
			reply(formatSlashCommandHelp());
			return true;
		}
		if (normalized === "/feishu" && args[0]?.toLowerCase() === "status") { reply(statusText()); return true; }
		if (normalized === "/feishu" && args[0]?.toLowerCase() === "doctor") {
			reply(formatDoctor(runDoctor({ config, paths: resolvePaths(homeDir), transport })));
			return true;
		}
		if (normalized === "/feishu" && args[0]?.toLowerCase() === "policy") {
			if (!config.admins.includes(msg.senderId)) { reply("仅管理员可修改群策略"); return true; }
			if (msg.chatType === "p2p") { reply("群策略只能在群聊或话题中修改"); return true; }
			const policy = args[1] as GroupPolicy | undefined;
			const valid: GroupPolicy[] = ["open", "mention", "disabled", "allowlist", "blacklist", "admin_only"];
			if (!policy || !valid.includes(policy)) { reply("用法：/feishu policy <open|mention|disabled|allowlist|blacklist|admin_only>"); return true; }
			const previous = config.groupPolicyByChat[msg.chatId];
			config.groupPolicyByChat[msg.chatId] = policy;
			if (saveConfig(homeDir, config)) reply(`已设置本群策略：${policy}`);
			else {
				if (previous === undefined) delete config.groupPolicyByChat[msg.chatId];
				else config.groupPolicyByChat[msg.chatId] = previous;
				reply("策略落盘失败，运行态未修改");
			}
			return true;
		}
		if (normalized === "/new") {
			permissionBridge?.resetSession(buildConversationKey(msg, config));
			await convManager?.resetConversation(msg);
			reply("已创建新的会话上下文");
			return true;
		}
		if (normalized === "/stop") {
			permissionBridge?.resetSession(buildConversationKey(msg, config));
			reply(await convManager?.stopConversation(msg)
				? "已请求停止当前任务；通过 /queue 排队的后续任务将继续执行"
				: "当前没有正在执行的任务");
			return true;
		}
		if (normalized === "/queue" || normalized === "/q") {
			const text = args.join(" ").trim();
			if (!text) { reply("用法：/queue <内容>（别名 /q）"); return true; }
			const result = await convManager?.queueConversation({ ...msg, text });
			reply(result === "rejected" ? "当前队列已满，请稍后再试" : "已加入后续任务队列");
			return true;
		}
		if (normalized === "/steer") {
			const text = args.join(" ").trim();
			if (!text) { reply("用法：/steer <内容>"); return true; }
			const result = await convManager?.steerConversation({ ...msg, text });
			reply(result === "steered" ? "已注入当前任务" : result === "queued" ? "当前任务已结束，已作为新任务执行" : "当前队列已满，请稍后再试");
			return true;
		}
		if (normalized === "/compact") { reply(await convManager?.compactConversation(msg, args.join(" ") || undefined) ?? "会话不可用"); return true; }
		if (normalized === "/model") { reply(await convManager?.modelConversation(msg, args[0]) ?? "会话不可用"); return true; }
		return false;
	}

	async function assemble(): Promise<void> {
		const paths = resolvePaths(homeDir);
		knownChats = new KnownChatStore(paths.knownChatsFile);
		const { createFeishuTransport } = await import("./inbound/transport-factory.js");
		transport = await createFeishuTransport(config, {
			onMessage: async (msg) => {
				if (msg.chatId) knownChats?.add(msg.chatId);
				await pipeline?.handle(msg);
			},
			onStatus: (connState, reconnectCount) => {
				reconnectAttempts = reconnectCount;
				const outageStartedAt = downSince;
				reportedConnState = connState === "connected" ? "connected" : connState === "error" ? "error" : "connecting";
				if (reportedConnState === "connected") {
					downSince = undefined;
					lastError = undefined;
					if (outageStartedAt) void compensateMissed(outageStartedAt);
				} else if (reportedConnState === "error") {
					downSince ??= Date.now();
				}
				setStatus("conn", connState === "connected" ? "飞书桥已连接" : `飞书桥 ${connState}`);
				updateStatus();
			},
			onCardAction: handleCardAction,
			log: (level, m, meta) => log[level](m, meta),
		});
		permissionBridge = new PermissionBridge({
			getConfig: () => config.approval,
			onAsk: async (pending) => transport!.sendCard(pending.chatId, buildApprovalCard(pending), {
				replyTo: pending.sourceMessageId, threadId: pending.threadId,
			}),
			onAlwaysAllow: (toolName) => {
				if (!config.approval.autoApprove.includes(toolName)) config.approval.autoApprove.push(toolName);
				saveConfig(homeDir, config);
			},
			onAudit: (event) => log.info("feishu.approval.audit", event),
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
			prepare: (chatId, content, opts) => sender!.prepare(chatId, content, opts),
			prepareMedia: (chatId, artifact, opts) => sender!.prepareMedia(chatId, artifact, opts),
			send: (request, checkpoint) => sender!.sendPrepared(request, checkpoint),
			log: (level, m, meta) => log[level](m, meta),
			onChange: updateStatus,
		});

		convManager = new ConversationManager({
			config,
			sessionDir: paths.sessionDir,
			sessionBackend: new PiSessionBackend({ sessionDir: paths.sessionDir, log: (l, m, x) => log[l](m, x) }),
			pendingFile: join(paths.sessionDir, "..", "pending.jsonl"),
			sender,
			durableOutbox: outbox,
			resourceResolver: new ResourceResolver({
				baseDir: join(paths.sessionDir, "..", "resources"),
				download: (ref, maxBytes) => transport!.downloadResource(ref, maxBytes),
			}),
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
			dedupeStore: new DedupeStore({ file: paths.dedupeFile, capacity: config.dedupCacheSize, ttlMs: config.dedupTtlMs }),
			onDispatch: async (msg) => { await convManager!.route(msg); },
			onCommand: handleFeishuCommand,
			log: (level, m, meta) => log[level](m, meta),
		});
	}

	pi.registerTool({
		name: "feishu_send_local_file",
		label: "发送文件到飞书",
		description: "将当前工作区内的本地图片或文件发送到触发本轮的飞书会话",
		promptSnippet: "生成用户需要的文件后，使用 feishu_send_local_file 发送；path 可为当前工作区内的相对或绝对路径。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "当前工作区内的文件路径" },
				caption: { type: "string", description: "可选的文件说明" },
			},
			required: ["path"],
		},
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const route = convManager?.routeForSessionId(ctx.sessionManager.getSessionId());
			return queueLocalFile({
				toolCallId, path: params.path, caption: params.caption, cwd: ctx.cwd, homeDir, route, outbox,
			});
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event as { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
		const sessionId = ctx.sessionManager.getSessionId();
		const route = convManager?.routeForSessionId(sessionId);
		if (!route || !permissionBridge || !input.toolCallId || !input.toolName) return undefined;
		convManager?.markPendingToolBoundary(sessionId);
		const result = await permissionBridge.gate({
			conversationKey: route.conversationKey,
			sessionId,
			runId: route.runId ?? input.toolCallId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			paramsText: redactParams(input.input),
			chatId: route.chatId,
			threadId: route.threadId,
			sourceMessageId: route.sourceMessageId,
			allowedOperatorIds: [...config.admins],
		});
		if (result.decision === "allow") return undefined;
		if (result.decision === "deny") return { block: true, reason: "工具调用被策略拒绝" };
		const verdict = await result.verdict;
		if (verdict === "approved") return undefined;
		return { block: true, reason: verdict === "timeout" ? "飞书审批超时，已拒绝" : "飞书审批已拒绝" };
	});

	async function compensateMissed(outageStartedAt: number): Promise<void> {
		if (compensationPromise) return compensationPromise;
		compensationPromise = (async () => {
			const endTime = Date.now();
			const result = await compensateKnownChats({
				chatIds: knownChats?.values() ?? [],
				outageStartedAt,
				now: endTime,
				maxWindowMs: 5 * 60_000,
				maxPerChat: 50,
				list: (chatId, startTime, finishTime, limit) => transport?.listChatHistory(chatId, startTime, finishTime, limit) ?? Promise.resolve([]),
				handle: (message) => pipeline?.handle(message) ?? Promise.resolve(),
				onError: (chatId, error) => log.warn("history compensation failed", { chatId, error: error instanceof Error ? error.message : String(error) }),
			});
			compensatedMessages += result.recovered;
			compensationErrors += result.errors;
			compensationTruncated += result.truncatedChats + (result.windowTruncated ? 1 : 0);
			updateStatus();
		})();
		try {
			await compensationPromise;
		} finally {
			compensationPromise = undefined;
		}
	}

	function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const run = lifecycleTail.then(operation, operation);
		lifecycleTail = run.then(() => undefined, () => undefined);
		return run;
	}

	function startBridge(): Promise<string> {
		return serializeLifecycle(startBridgeUnlocked);
	}

	async function startBridgeUnlocked(): Promise<string> {
		if (started) return "already";
		try {
			appLock = AppLock.acquire(resolveAppLockFile(homeDir, config.appId), config.appId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastError = message;
			reportedConnState = "error";
			// 锁由其他实例持有时不能覆盖 owner 的共享 status.json。
			setStatus("bridge", `飞书桥启动失败: ${message.slice(0, 60)}`);
			return `启动失败：${message}`;
		}
		started = true;
		stopping = false;
		reportedConnState = "connecting";
		lastError = undefined;
		status.startedAt = Date.now();
		updateStatus();
		try {
			await assemble();
			await transport!.start();
			outbox!.start();
			setStatus("conn", "飞书桥启动中…");
			setStatus("bridge", "飞书桥已启动");
			log.info("bridge started", { bot: transport?.getBotIdentity() });
			updateStatus();
			return "started";
		} catch (err) {
			started = false;
			const msg = err instanceof Error ? err.message : String(err);
			lastError = msg;
			reportedConnState = "error";
			appLock?.release();
			appLock = undefined;
			log.error("bridge start failed", { error: msg });
			setStatus("bridge", `飞书桥启动失败: ${msg.slice(0, 60)}`);
			updateStatus();
			return `启动失败：${msg}`;
		}
	}

	function stopBridge(): Promise<string> {
		return serializeLifecycle(stopBridgeUnlocked);
	}

	async function stopBridgeUnlocked(): Promise<string> {
		stopping = true;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
		}
		try {
			permissionBridge?.shutdown();
			try { await pipeline?.stop(); } catch { /* best effort */ }
			try { await convManager?.shutdown(); } catch { /* best effort */ }
			try { await outbox?.stop(); } catch { /* best effort */ }
			try {
				await transport?.stop();
			} catch {
				/* ignore */
			}
		} finally {
			started = false;
			reportedConnState = "disconnected";
			downSince = undefined;
			appLock?.release();
			appLock = undefined;
			updateStatus();
			setStatus("bridge", "飞书桥已停止");
		}
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
				lastError = err instanceof Error ? err.message : String(err);
				reportedConnState = "error";
				downSince ??= Date.now();
				log.error("reconnect failed", { error: lastError });
				updateStatus();
			}
			scheduleReconnect();
		}, delay);
		reconnectTimer.unref?.();
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
			`会话队列: queued ${status.sessionQueues?.queued ?? 0} / active ${status.sessionQueues?.active ?? 0} / waiting ${status.sessionQueues?.waiting ?? 0}`,
			`待审批: ${status.pendingApprovals ?? 0}`,
			`outbox: pending ${status.outbox.pending} / sending ${status.outbox.sending} / sent ${status.outbox.sent} / failed ${status.outbox.failed} / lanes ${status.outbox.lanes} / oldest ${Math.round(status.outbox.oldestAgeMs / 1000)}s`,
			`消息: 总 ${status.messageTotal} / 丢弃 ${status.messageDropped}`,
			`补收: ${status.compensatedMessages} / 错误 ${status.compensationErrors} / 窗口截断 ${status.compensationTruncated}`,
			`策略: 全局 ${config.groupPolicy}${Object.keys(config.groupPolicyByChat).length ? `，覆盖 ${JSON.stringify(config.groupPolicyByChat)}` : ""}`,
			`群白名单: ${config.allowChats.length ? config.allowChats.join(", ") : "（全部群按策略）"}`,
		];
			if (status.lastMessageAt) lines.push(`最近消息: ${new Date(status.lastMessageAt).toLocaleTimeString()}`);
			if (status.lastError) lines.push(`最近错误: ${status.lastError.slice(0, 200)}`);
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
			const valid: GroupPolicy[] = ["open", "mention", "disabled", "allowlist", "blacklist", "admin_only"];
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
		void stopBridge().finally(() => process.exit(0));
		setTimeout(() => process.exit(0), 3000).unref();
	});

	pi.on("session_shutdown", async () => {
		stopping = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		clearInterval(watchdog);
		await stopBridge();
	});
}
