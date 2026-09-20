/**
 * pi-feishu-bridge 扩展入口：装配 transport/pipeline/session/sender/outbox，
 * 提供 /feishu 命令与连接 supervisor（指数退避重连）。
 * 设计依据：docs/DESIGN.md §2/§3.7。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "./pi-types.js";
import type { BridgeConfig, BridgeStatus, GroupPolicy } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { loadConfig, resolveAppLockFile, resolvePaths, saveConfig, formatTimeInZone } from "./config.js";
import { FeishuTransport } from "./inbound/transport.js";
import { InboundPipeline } from "./inbound/pipeline.js";
import { LastSentCache, admit, effectiveAdmins } from "./inbound/admit.js";
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
import { createBridgeInlineExtension, type BridgeGateInput } from "./session/pi-bridge-hooks.js";
import { PermissionBridge, redactParams, type ApprovalChoice } from "./approval/permission-bridge.js";
import { AlwaysApprovedStore } from "./approval/always-approved-store.js";
import {
	PS_FORWARDING_PARENT_ENV_KEYS,
	PS_FORWARDING_UPSTREAM_TIMEOUT_MS,
	PsForwardingServer,
	applyPsForwardingParentEnv,
	psForwardingRootDir,
	resolvePsForwardingConfig,
} from "./approval/ps-forwarding.js";
import { classifyCommand } from "./approval/command-policy.js";
import { buildApprovalCard, type ApprovalCardResolution } from "./approval/cards.js";
import { buildModelStatusCard, buildModelsTable } from "./commands/models-card.js";
import { readGlobalDefaults, splitModelTarget, writeGlobalDefaults } from "./config/global-defaults.js";
import {
	ClarificationStore,
	buildClarificationCard,
	buildClarificationResultCard,
	clarificationTextFallback,
} from "./interaction/clarification-store.js";
import type { CardAction } from "./inbound/transport.js";
import { formatDoctor, runDoctor } from "./runtime/doctor.js";
import { buildDiagnosticsBundle, writeDiagnosticsBundle } from "./runtime/diagnostics.js";
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
	// pi-permission-system 父会话转发（实验性，默认关）：桥充当应答方，把 PS 的 ask 变成审批卡。
	let psForwarding: PsForwardingServer | undefined;
	/** 「始终批准」规则表（转发路径）；未启用时为 undefined。 */
	let alwaysApproved: AlwaysApprovedStore | undefined;
	let psForwardingParentId: string | undefined;
	/** 本进程自己声明过的父会话 id（撤回时只删自己设的值，不动外层 spawner 的声明）。 */
	let psForwardingOwnEnvId: string | undefined;
	// P2-01：澄清提问（与审批完全独立，选择不授予任何工具权限）
	let clarificationStore: ClarificationStore | undefined;
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

	/** 管理员/应用归属人判定（统一走 effectiveAdmins，避免换应用后视角失效）。 */
	function isAdminSender(msg: { senderId: string }): boolean {
		return effectiveAdmins(config).includes(msg.senderId);
	}

	async function handleCardAction(action: CardAction): Promise<unknown> {
		const value = action.value ?? {};
		log.info("feishu.card.action", {
			messageId: action.messageId, op: typeof value.op === "string" ? value.op : null,
			operator: action.operatorOpenId, hasValue: action.value !== undefined,
		});
		// 模型列表卡片是**纯展示**的（表格自带客户端分页），没有回调分支 ——
		// 切换模型走 /model <provider>/<id> 命令，不把列表变成表单。

		// /model 状态卡：点档位按钮即切换思考等级（等价于 /thinking <level>），
		// 然后原地刷新卡片 —— 按钮的勾与禁用态要跟着变，否则用户会以为没生效。
		if (value.op === "thinking.set") {
			if (typeof value.level !== "string" || typeof value.conversationKey !== "string") return undefined;
			const result = await convManager?.setThinkingByKey(value.conversationKey, value.level);
			if (!result?.ok) {
				log.warn("feishu.card.thinking_set_failed", { level: value.level, reason: result?.reason ?? "unknown" });
				return { toast: { type: "warning", content: result?.reason ?? "切换失败" } };
			}
			log.info("feishu.card.thinking_set", { level: value.level, conversationKey: value.conversationKey });
			const data = await convManager?.modelStatusCardDataByKey(value.conversationKey);
			if (!data) return { toast: { type: "success", content: `已切换到 ${value.level}` } };
			// 把这次执行的命令写进卡片：用户点的是按钮，但等价于发了一条斜杠命令，
			// 露出来才能复制去加 -g（全局默认）或转发给别人。
			return {
				toast: { type: "success", content: `已切换到 ${value.level}` },
				card: { type: "raw", data: buildModelStatusCard({ ...data, lastExecuted: `/thinking ${value.level}` }) },
			};
		}

		// /model 状态卡的「查看全部模型」：等价于执行 /models —— **发一张新卡片**
		// 而不是原地替换，那样会把状态卡覆盖掉，用户就失去了回到档位按钮的入口。
		if (value.op === "models.open") {
			if (typeof value.conversationKey !== "string") return undefined;
			const data = await convManager?.modelsTableDataByKey(value.conversationKey);
			if (!data) {
				log.warn("feishu.card.models_open_failed", { conversationKey: value.conversationKey });
				return { toast: { type: "warning", content: "会话已失效，请重新发送 /models" } };
			}
			log.info("feishu.card.models_open", { conversationKey: value.conversationKey });
			if (!action.chatId) return { toast: { type: "warning", content: "无法确定目标会话" } };
			try {
				await transport?.sendCard(action.chatId, buildModelsTable(data));
				return { toast: { type: "success", content: "已发送模型列表" } };
			} catch (error) {
				return { toast: { type: "warning", content: `发送失败：${error instanceof Error ? error.message.slice(0, 60) : "未知错误"}` } };
			}
		}
		// P2-01：澄清选择 —— 只恢复等待点，不写任何授权
		if (value.op === "clarify") {
			if (typeof value.clarificationId !== "string" || typeof value.token !== "string" || typeof value.choice !== "string") return undefined;
			const decided = clarificationStore?.decide({
				id: value.clarificationId, token: value.token, messageId: action.messageId,
				chatId: action.chatId ?? "", operatorOpenId: action.operatorOpenId, choice: value.choice,
			});
			if (!decided?.ok) return { toast: { type: "warning", content: decided?.reason ?? "该提问已失效" } };
			return {
				toast: { type: "success", content: decided.reason },
				card: { type: "raw", data: buildClarificationResultCard(value.choice, action.operatorOpenId) },
			};
		}
		if (value.op !== "approval" || typeof value.approvalId !== "string" || typeof value.token !== "string") return undefined;
		const choice = value.choice;
		if (choice !== "once" && choice !== "session" && choice !== "always" && choice !== "deny") return undefined;
		const decision = permissionBridge?.decide({
			id: value.approvalId, token: value.token, messageId: action.messageId, chatId: action.chatId,
			operatorOpenId: action.operatorOpenId, choice: choice as ApprovalChoice,
		});
		if (!decision?.ok) return { toast: { type: "warning", content: decision?.reason ?? "审批已失效" } };
		// 原地更新同一张卡：保留原文与参数，标题改成结论、被选项加 ✓、其余禁用。
		const resolution: ApprovalCardResolution = {
			choice: choice as ApprovalChoice,
			resultText: decision.reason,
			operatorOpenId: action.operatorOpenId,
		};
		return {
			toast: { type: "success", content: decision.reason },
			...(decision.pending ? { card: { type: "raw", data: buildApprovalCard(decision.pending, resolution) } } : {}),
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
			reply(formatDoctor(runDoctor({ config, paths: resolvePaths(homeDir), transport, diagnostics: diagnosticsContext() })));
			return true;
		}
		if (normalized === "/feishu" && args[0]?.toLowerCase() === "export") {
			if (!effectiveAdmins(config).includes(msg.senderId)) { reply("仅管理员或应用归属人可导出诊断包"); return true; }
			try {
				const bundle = buildDiagnosticsBundle({
					config, context: diagnosticsContext(),
					checks: runDoctor({ config, paths: resolvePaths(homeDir), transport, diagnostics: diagnosticsContext() }),
					redactPaths: [homeDir, resolvePaths(homeDir).sessionDir, process.cwd()],
				});
				const dir = writeDiagnosticsBundle(homeDir, bundle);
				reply(`已导出脱敏诊断包：${dir}/（0600，仅含计数与枚举；不含密钥、正文与绝对路径）`);
			} catch (error) {
				reply(`诊断包导出失败：${error instanceof Error ? error.message.slice(0, 120) : "未知错误"}`);
			}
			return true;
		}
		if (normalized === "/feishu" && args[0]?.toLowerCase() === "policy") {
			if (!effectiveAdmins(config).includes(msg.senderId)) { reply("仅管理员或应用归属人可修改群策略"); return true; }
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
		if (normalized === "/feishu" && args[0]?.toLowerCase() === "always") {
			// 「始终批准」是持久放行：必须能看、能撤，否则一次点击等于永久挖掉一块闸门。
			if (!effectiveAdmins(config).includes(msg.senderId)) { reply("仅管理员或应用归属人可查看或撤销「始终批准」规则"); return true; }
			if (!alwaysApproved) { reply("「始终批准」未启用（需要 pi-permission-system 转发模式）"); return true; }
			if (args[1]?.toLowerCase() === "revoke") {
				const pattern = args.slice(2).join(" ").trim();
				if (!pattern) { reply("用法：/feishu always revoke <规则名>（规则名见 /feishu always）"); return true; }
				const removed = alwaysApproved.remove(pattern);
				log.info("feishu.approval.always_revoked", { pattern, removed, operator: msg.senderId });
				reply(removed ? `已撤销规则「${pattern}」—— 下次同类请求会重新弹卡。` : `没有找到规则「${pattern}」。`);
				return true;
			}
			const rules = alwaysApproved.list();
			if (rules.length === 0) { reply("当前没有「始终批准」的规则（所有 ask 都会弹卡）。"); return true; }
			const lines = rules.map((rule) => {
				const when = formatTimeInZone(rule.approvedAt, config.timezone);
				return `· ${rule.pattern}（${when}${rule.approvedBy ? ` · ${rule.approvedBy}` : ""}）`;
			});
			reply([`「始终批准」规则共 ${rules.length} 条：`, ...lines, "用 /feishu always revoke <规则名> 撤销。"].join("\n"));
			return true;
		}
		if (normalized === "/new") {
			const force = args[0]?.toLowerCase() === "force";
			const result = await convManager?.resetConversation(msg, { force });
			if (!result) { reply("会话不可用"); return true; }
			if (result.status === "error") { reply(`开新会话失败：${result.reason}`); return true; }
			if (result.status === "busy") {
				reply(`当前有 ${result.pending} 个任务在执行或排队。回复 /new force 可取消它们并开新会话；或先 /stop 处理当前任务。`);
				return true;
			}
			permissionBridge?.resetSession(buildConversationKey(msg, config));
			reply(result.cancelled > 0
				? `已取消 ${result.cancelled} 个排队任务，并创建新的会话上下文`
				: "已创建新的会话上下文");
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
		if (normalized === "/model") {
			// 无参 = 状态卡（当前模型 + 档位按钮 + 「查看全部模型」按钮）。
			// 带参仍是命令式切换，保持文本回执 —— 那是一次性动作，不需要卡片。
			if (!args[0] && transport) {
				const data = await convManager?.modelStatusCardData(msg);
				if (data) {
					await transport.sendCard(msg.chatId, buildModelStatusCard(data), {
						replyTo: msg.messageId,
						threadId: msg.threadId,
					});
					return true;
				}
			}
			const raw = args.join(" ").trim();
			const wantsGlobal = /(^|\s)(--global|-g)(\s|$)/.test(raw);
			const target = raw.replace(/(^|\s)(--global|-g)(\s|$)/g, " ").trim();
			const result = await convManager?.modelConversation(msg, target || undefined) ?? "会话不可用";
			if (!wantsGlobal || !target) { reply(result); return true; }
			if (!isAdminSender(msg)) { reply(`${result}\n（--global/-g 需要管理员或应用归属人）`); return true; }
			const { model, provider } = splitModelTarget(target);
			const written = writeGlobalDefaults(homeDir, {
				defaultModel: model, ...(provider ? { defaultProvider: provider } : {}),
			});
			reply(written.ok
				? `${result}\n已设为全局默认：新建会话的模型 = ${target}`
				: `${result}\n⚠️ 全局默认写入失败：${written.reason}`);
			log.info("feishu.global_default.written", {
				kind: "model", value: target, ok: written.ok, operator: msg.senderId,
				reason: written.reason ?? null,
			});
			return true;
		}
		if (normalized === "/models") {
			// 表格卡片：飞书客户端自带分页（page_size），不需要服务端翻页回调，
			// 因此也不再接受页码参数 —— 翻页是客户端行为。
			const data = await convManager?.modelsCardData(msg);
			if (data && transport) {
				await transport.sendCard(msg.chatId, buildModelsTable(data), {
					replyTo: msg.messageId,
					threadId: msg.threadId,
				});
				return true;
			}
			reply(await convManager?.listModels(msg, 0) ?? "会话不可用");
			return true;
		}
		if (normalized === "/sessions") {
			const page = Number.parseInt(args[0] ?? "0", 10);
			reply(await convManager?.listSessionsFor(msg, Number.isFinite(page) ? page : 0) ?? "会话不可用");
			return true;
		}
		if (normalized === "/name") {
			reply(await convManager?.renameConversation(msg, args.join(" ")) ?? "会话不可用");
			return true;
		}
		if (normalized === "/resume") {
			reply(await convManager?.resumeConversation(msg, args[0]) ?? "会话不可用");
			return true;
		}
		if (normalized === "/workspace") {
			// P2-02：查看（任何人）/ 切换（仅管理员）
			reply(await convManager?.switchWorkspace(msg, args[0], { isAdmin: effectiveAdmins(config).includes(msg.senderId) }) ?? "会话不可用");
			return true;
		}
		if (normalized === "/thinking") {
			const raw = args.join(" ").trim();
			// `--global` 任意位置都算（对齐 hermes 的 /reasoning 解析），
			// 去掉它之后剩下的才是等级值 —— 否则 "--global" 会被当成一个档位名。
			const wantsGlobal = /(^|\s)(--global|-g)(\s|$)/.test(raw);
			const level = raw.replace(/(^|\s)(--global|-g)(\s|$)/g, " ").trim();
			const result = await convManager?.thinkingConversation(msg, level || undefined) ?? "会话不可用";
			if (!wantsGlobal || !level) { reply(result); return true; }
			// 改全局默认 = 影响所有人 → 限管理员/归属人（与会话级改动不同）
			if (!isAdminSender(msg)) { reply(`${result}\n（--global/-g 需要管理员或应用归属人）`); return true; }
			const written = writeGlobalDefaults(homeDir, { defaultThinkingLevel: level });
			reply(written.ok
				? `${result}\n已设为全局默认：新建会话的思考等级 = ${level}`
				: `${result}\n⚠️ 全局默认写入失败：${written.reason}`);
			log.info("feishu.global_default.written", {
				kind: "thinkingLevel", value: level, ok: written.ok,
				operator: msg.senderId, reason: written.reason ?? null,
			});
			return true;
		}
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
		clarificationStore = new ClarificationStore({
			allowedResponderIds: () => effectiveAdmins(config),
			// 管理员名单为空时不允许任何人作答（fail closed，避免任意群成员替用户做决定）
			onAudit: (event) => log.info("feishu.clarify.audit", event),
		});
		permissionBridge = new PermissionBridge({
			getConfig: () => config.approval,
			onAsk: async (pending) => transport!.sendCard(pending.chatId, buildApprovalCard(pending), {
				replyTo: pending.sourceMessageId, threadId: pending.threadId,
			}),
			// 超时/失效（非用户点击）时把卡片改成终态并禁用按钮，
			// 否则卡片会一直看起来可点，用户点了才被告知「审批已失效」。
			onCardResolve: (pending, outcome) => {
				if (!pending.cardMessageId) return;
				const card = buildApprovalCard(pending, {
					choice: undefined,
					terminal: outcome.terminal,
					resultText: outcome.resultText,
					operatorOpenId: "",
				});
				void transport?.updateCard(pending.cardMessageId, card).then((ok) => {
					if (!ok) log.warn("feishu.approval.card_terminal_failed", { approvalId: pending.id });
				});
			},
			onAlwaysAllow: (toolName) => {
				const previous = [...config.approval.autoApprove];
				if (!config.approval.autoApprove.includes(toolName)) config.approval.autoApprove.push(toolName);
				// P0-03：saveConfig 失败时回滚内存改动 —— 不得反馈“已持久授权”。
				if (saveConfig(homeDir, config)) return true;
				config.approval.autoApprove = previous;
				log.error("feishu.approval.always_persist_failed", { toolName });
				return false;
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
			// 超时策略：只在「完全没有事件产出」时中止；总时长默认不限（长任务不该被硬杀）
			// P1-01：流式卡片复用 transport 的原始请求能力
			rawRequest: (opts) => {
				if (!transport) throw new Error("transport unavailable");
				return transport.rawRequest(opts);
			},
			runIdleTimeoutMs: config.runIdleTimeoutMs,
			runMaxDurationMs: config.runMaxDurationMs,
			sessionBackend: new PiSessionBackend({
				sessionDir: paths.sessionDir,
				log: (l, m, x) => log[l](m, x),
				// P0-02：给每个子会话注入桥侧 hook（审批 gate + 文件工具），共享 outer 桥状态；
				// 同时剔除网关扩展，避免子会话重复启动飞书 WS / 创建空状态。
				bridgeExtensionFactory: createBridgeInlineExtension({
					routeForSessionId: (sessionId) => convManager?.routeForSessionId(sessionId),
					markToolBoundary: (sessionId) => convManager?.markPendingToolBoundary(sessionId),
					gateToolCall: (input) => gateToolCall(input),
					notifyCompaction: ({ sessionId, phase, detail }) => {
						const route = convManager?.routeForSessionId(sessionId);
						if (!route) return;
						log.info("feishu.bridge.compaction", { phase, chatId: route.chatId });
						// 压缩期间 Pi 不产出事件，发一条可见提示消除"莫名卡住"的困惑。
						// 必须用 notifyNow（notify 是 private）：attempt 里带 chatId+phase 保证压缩
						// 反复触发时不会每轮刷屏，但每次真实压缩都能出一次。
						if (phase === "start") {
							void convManager?.notifyNow(route.chatId, "🧠 上下文较长，正在整理记忆…", {
								replyTo: route.sourceMessageId,
								threadId: route.threadId,
							}, `compaction:${route.chatId}:${route.runId ?? ""}`);
						} else if (phase === "failed") {
							void convManager?.notifyNow(route.chatId, `⚠️ 上下文整理失败，已继续本轮${detail ? `（${detail}）` : ""}`, {
								replyTo: route.sourceMessageId,
								threadId: route.threadId,
							}, `compaction-failed:${route.chatId}:${route.runId ?? ""}`);
						}
					},
					markSettled: (sessionId) => {
						const route = convManager?.routeForSessionId(sessionId);
						if (!route) return;
						log.info("feishu.bridge.agent_settled", { chatId: route.chatId });
						convManager?.markSettled(sessionId);
					},
					sendLocalFile: (input) => queueLocalFile({
						toolCallId: input.toolCallId,
						path: input.path,
						caption: input.caption,
						cwd: input.cwd,
						homeDir,
						route: input.route,
						outbox,
					}),
					// P2-03：当前会话内的主动文本通知 —— 只认活动路由，走 durable notify
					notifyText: async (input) => {
						const route = input.route;
						if (!route?.chatId) return { status: "rejected" as const, detail: "没有活动会话" };
						const opts = { replyTo: route.sourceMessageId, threadId: route.threadId };
						const dedupeKey = `${route.conversationKey}:${input.toolCallId}:notify`;
						if (outbox) {
							const ids = outbox.enqueue(route.chatId, input.text, opts, {
								dedupeKey, laneKey: route.conversationKey, kind: "notify",
							});
							// 同一 toolCallId 重试只入队一次（outbox 按 dedupeKey 幂等）
							return ids.length > 0
								? { status: "queued" as const }
								: { status: "delivered" as const, detail: "该通知已入队" };
						}
						const res = await convManager?.notifyNow(route.chatId, input.text, opts, dedupeKey);
						return res?.success
							? { status: "delivered" as const }
							: { status: "rejected" as const, detail: res?.error ?? "发送失败" };
					},
					allowedOperatorIds: () => effectiveAdmins(config),
				// P2-01：澄清提问 —— 卡片优先后退化为文本选项，等待有界超时
				askChoice: async (input) => {
					if (!clarificationStore) return { status: "unavailable" as const, detail: "澄清存储未初始化" };
					if (!input.route?.chatId) return { status: "unavailable" as const, detail: "没有活动会话" };
					const pending = clarificationStore.create({
						conversationKey: input.route.conversationKey, chatId: input.route.chatId, threadId: input.route.threadId,
						runId: input.route.runId ?? input.toolCallId, toolCallId: input.toolCallId,
						question: input.question, options: input.options,
					});
					// 卡片优先：发送失败（例如无卡片权限）退化为文本选项，用户回复文本时按普通消息继续
					let cardSent = false;
					try {
						const messageId = await transport?.sendCard(input.route.chatId, buildClarificationCard(pending), {
							replyTo: input.route.sourceMessageId, threadId: input.route.threadId,
						});
						clarificationStore.attachCard(pending.id, messageId);
						cardSent = Boolean(messageId);
					} catch (error) {
						log.warn("feishu.clarify.card_failed", { error: error instanceof Error ? error.message : String(error) });
					}
					if (!cardSent) {
						const fallback = clarificationTextFallback(pending);
						if (outbox) {
							outbox.enqueue(input.route.chatId, fallback, { replyTo: input.route.sourceMessageId, threadId: input.route.threadId }, {
								dedupeKey: `${input.route.conversationKey}:${input.toolCallId}:clarify`, laneKey: input.route.conversationKey, kind: "notify",
							});
						}
					}
					return await pending.verdict;
				},
					redactParams,
					log: (level, msg, meta) => log[level](msg, meta),
				}),
			}),
			pendingFile: join(paths.sessionDir, "..", "pending.jsonl"),
			// P0-05：会话指针持久化 —— /new 后重启仍处于新会话，不回退到旧上下文。
			conversationFile: join(paths.sessionDir, "..", "conversations.jsonl"),
			// P0-03：run 结束/会话重置时撤销未决审批卡（旧卡不得再授予权限）。
			// P1-08：有未决审批的会话不允许回收句柄（避免审批卡失去响应目标）。
			pendingApprovalCount: (conversationKey) =>
				(permissionBridge?.pendingForConversation(conversationKey) ?? 0)
				+ (clarificationStore?.pendingForConversation(conversationKey) ?? 0),
			onApprovalInvalidate: ({ conversationKey, runId, reason }) => {
				if (!permissionBridge) return;
				const cancelled = runId
					? permissionBridge.cancelRun(conversationKey, runId)
					: permissionBridge.cancelConversation(conversationKey);
				// P2-01：同一 run 的未决提问一并失效（旧卡片不得再影响新状态）
				const clarifyCancelled = runId
					? clarificationStore?.cancelRun(conversationKey, runId) ?? 0
					: clarificationStore?.cancelConversation(conversationKey) ?? 0;
				if (cancelled > 0 || clarifyCancelled > 0) {
					log.info("feishu.approval.invalidated", { conversationKey, runId, reason, cancelled, clarifyCancelled });
				}
			},
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
			// P0-01：准入通过即写 pending ledger，消除 dedupe→ledger 丢失窗口。
			intake: convManager?.intakeLedger(),
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

	/**
	 * PS 父会话转发的配置视图（父会话 id 缺省时用固定值；引擎不是 PS 时视为关闭）。
	 */
	function psForwardingConfigured(): { enabled: boolean; parentSessionId: string; blockedBy?: "policyEngine" } {
		return resolvePsForwardingConfig(config.approval);
	}

	/**
	 * 声明/撤回「本进程是 PS 的父会话」（见 PS_FORWARDING_PARENT_ENV_KEYS）。
	 *
	 * 变量是进程级的（桥与子会话同进程，无法只给子会话设），而效果恰好是我们想要的：
	 * 进程内所有会话的 ask 都转发给桥；真正的发起会话从请求文件的 requesterSessionId 读。
	 * PS 在每次工具调用时实时读环境变量，因此这里在会话创建前设置即可。
	 *
	 * 关闭时必须撤回自己的声明：否则 PS 会把 ask 转发到一个没人收的收件箱，
	 * 子会话要等满 10 分钟才判拒绝（而正确行为是回落到它自己的判定）。
	 */
	function syncPsForwardingEnv(): void {
		const { enabled, parentSessionId, blockedBy } = psForwardingConfigured();
		if (blockedBy) {
			// 开关开了但引擎不是 PS：开启转发只会让同一次调用弹两张卡，这里明确说明。
			log.warn("feishu.approval.ps_forwarding_inactive", {
				reason: "approval.forwarding 仅在 approval.policyEngine=pi-permission-system 时生效",
				policyEngine: config.approval?.policyEngine ?? "bridge",
			});
		}
		const installed = piPermissionSystemInstalled();
		const active = enabled && installed;
		if (enabled && !installed) {
			// 与 policyEngine 同一套失败关闭语义：没装成就不做父子声明。
			log.error("feishu.approval.ps_forwarding_unavailable", { expected: "@gotgenes/pi-permission-system" });
		}
		const before = psForwardingOwnEnvId;
		const result = applyPsForwardingParentEnv({ enabled: active, parentSessionId, previousApplied: before });
		psForwardingOwnEnvId = result.appliedValue;
		if (result.appliedValue !== before) {
			log.info("feishu.approval.ps_forwarding_env", {
				state: result.appliedValue ? "declared" : "withdrawn",
				keys: PS_FORWARDING_PARENT_ENV_KEYS,
				parentSessionId,
			});
		}
		if (result.overridden.length > 0) {
			// 外层 spawner 已经声明过别的父会话：我们接管了它。写一条日志，免得排障时想不到。
			log.warn("feishu.approval.ps_forwarding_env_overridden", { overridden: result.overridden, parentSessionId });
		}
	}

	/**
	 * 起停转发应答方。幂等：已起且父会话 id 未变则不动；id 变了则重建
	 * （心跳与收件箱目录都挂在 id 上，不能混用）。
	 *
	 * 何时只能起：必须等 transport/outbox 起来（弹卡要能发出去）且 PermissionBridge 已就位。
	 */
	async function syncPsForwardingServer(): Promise<void> {
		const { enabled, parentSessionId } = psForwardingConfigured();
		if (!enabled || !piPermissionSystemInstalled() || !permissionBridge) {
			if (psForwarding) {
				await psForwarding.stop();
				psForwarding = undefined;
				psForwardingParentId = undefined;
			}
			return;
		}
		if (psForwarding && psForwardingParentId === parentSessionId) {
			psForwarding.start();
			return;
		}
		if (psForwarding) {
			await psForwarding.stop();
			psForwarding = undefined;
		}
		// 「始终批准」规则表：开启时审批卡多一个 always 按钮，命中规则的请求直接放行。
		// 每轮同步都重建（配置可能被 /feishu policy 之类改过），成本是一次小文件读。
		alwaysApproved = config.approval.forwarding?.alwaysApprove === false
			? undefined
			: new AlwaysApprovedStore({ file: resolvePaths(homeDir).alwaysApprovedFile });
		psForwarding = new PsForwardingServer({
			forwardingDir: psForwardingRootDir(resolveAgentDir()),
			parentSessionId,
			alwaysApproved,
			routeForSessionId: (sessionId) => convManager?.routeForSessionId(sessionId),
			allowedOperatorIds: () => effectiveAdmins(config),
			requestDecision: async (input) => {
				const result = await permissionBridge!.requestExternal(input, {
					// 审批卡等待上限沿用 approval.timeoutMs；但不得越过 PS 自己的转发总超时，
					// 否则我们会在对方已经放弃后才写响应（子会话拿不到，白留一个孤儿文件）。
					timeoutMs: Math.min(config.approval.timeoutMs, PS_FORWARDING_UPSTREAM_TIMEOUT_MS - 30_000),
					auditDecision: "ps_forwarding_ask",
				});
				// operatorId 一并带回：转发路径的「始终批准」要记下是谁放行的。
				return { verdict: result.verdict, choice: result.choice, operatorId: result.operatorId };
			},
			onAudit: (event) => log.info("feishu.approval.ps_forwarding.audit", event),
			log: (level, msg, meta) => log[level](msg, meta),
		});
		psForwardingParentId = parentSessionId;
		psForwarding.start();
	}

	/**
	 * 工具调用审批（outer hook 与子会话内联扩展共用）：返回 { block, reason } 阻断执行。
	 * P0-02：同一实现在两个位置调用，避免“组件有实现但运行时没接上”。
	 */
	async function gateToolCall(input: BridgeGateInput): Promise<{ block?: boolean; reason?: string } | undefined> {
		if (!permissionBridge) return undefined;
		// 管理员/归属人免审批（approval.adminSkipApproval=true 时生效）。
		// 必须用显式传入的 senderId：conversationKey 只在「群聊+按人隔离」形态下带用户 ID，
		// 话题（`oc:t:th`）与私聊（裸 `oc`）都取不到，早期从 key 正则提取会漏掉这两种情况。
		if (config.approval?.adminSkipApproval) {
			const sender = input.senderId;
			if (sender && effectiveAdmins(config).includes(sender)) {
				log.info("feishu.approval.admin_skip", { toolName: input.toolName, conversationKey: input.conversationKey });
				return undefined;
			}
		}

		// 让权给 @gotgenes/pi-permission-system：它的 tool_call 闸门在桥之前执行，
		// deny 时桥的 handler 根本不会被调用（实测：PS 先 → 桥后，首个 block 立即返回）。
		// 因此桥这一步只需"放行自己不再判断"，策略规则由该扩展的配置文件维护。
		//
		// 它的 ask **不经过这里** —— 走 approval.forwarding（PS 的父会话转发）：桥当应答方，
		// 把请求文件变成审批卡，用户点完写回响应文件（见 approval/ps-forwarding.ts）。
		// 所以这里继续直接放行，不能改成落到桥的弹卡逻辑：PS 的 ask 是在它自己的闸门里
		// 等待父会话应答的，等它放行后本函数会被再调用一次，那时再弹一张卡就是对同一次
		// 调用弹两次卡（两次判定还可能不一致）。
		if (config.approval?.policyEngine === "pi-permission-system") {
			if (piPermissionSystemInstalled()) {
				return undefined;
			}
			// 失败关闭：扩展没装成 → 桥的审批是唯一防线，绝不能同时关掉
			log.error("feishu.approval.policy_engine_unavailable", {
				expected: "@gotgenes/pi-permission-system",
				fallback: "bridge",
			});
		}

		// 命令级策略：只读命令免审、危险命令直接拒绝，其余才弹卡。
		// 没有这一层时 bash 只能「全审」—— 每个 ls 都要点一次审批，用户会无脑点批准，审批就失去意义。
		if (input.toolName === "bash" && config.approval?.commandPolicy?.enabled) {
			const command = extractBashCommand(input.paramsText);
			if (command) {
				const verdict = classifyCommand(command, config.approval.commandPolicy);
				if (verdict.verdict === "allow") {
					log.info("feishu.approval.command_allow", { reason: verdict.reason, chatId: input.chatId });
					return undefined;
				}
				if (verdict.verdict === "deny") {
					log.warn("feishu.approval.command_deny", { reason: verdict.reason, chatId: input.chatId });
					// 直接拒绝，不弹卡：避免"手滑点批准"执行破坏性命令
					return { block: true, reason: `该命令被安全策略拒绝：${verdict.reason}。如确需执行，请人工在宿主机操作。` };
				}
				log.info("feishu.approval.command_ask", { reason: verdict.reason, chatId: input.chatId });
				// 把判定理由带进卡片：参考 hermes 的 `Reason: {description}`，
				// 让审批人知道"为什么这条命令需要批"，而不是只看到一个命令。
				input.reason = verdict.reason;
			}
		}
		const result = await permissionBridge.gate(input);
		if (result.decision === "allow") return undefined;
		if (result.decision === "deny") return { block: true, reason: "工具调用被策略拒绝" };
		const verdict = await result.verdict;
		if (verdict === "approved") return undefined;
		return { block: true, reason: verdict === "timeout" ? "飞书审批超时，已拒绝" : "飞书审批已拒绝" };
	}

	pi.on("tool_call", async (event, ctx) => {
		const input = event as { toolCallId?: string; toolName?: string; input?: Record<string, unknown> };
		const sessionId = ctx.sessionManager.getSessionId();
		const route = convManager?.routeForSessionId(sessionId);
		if (!route || !input.toolCallId || !input.toolName) return undefined;
		convManager?.markPendingToolBoundary(sessionId);
		return gateToolCall({
			conversationKey: route.conversationKey,
			sessionId,
			runId: route.runId ?? input.toolCallId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			paramsText: redactParams(input.input, input.toolName),
			chatId: route.chatId,
			threadId: route.threadId,
			sourceMessageId: route.sourceMessageId,
			senderId: route.senderId,
			allowedOperatorIds: effectiveAdmins(config),
		});
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
		// 父子声明要在任何桥会话创建之前落地（PS 每次工具调用时实时读进程环境）
		syncPsForwardingEnv();
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
			// 转发应答方要等 transport/outbox 就绪（弹卡要发得出去）。失败不阻塞桥启动：
			// 转发只是审批的升级路径，没起来退化成 PS 自己的判定（无人应答 → 拒绝）。
			try {
				await syncPsForwardingServer();
			} catch (error) {
				log.warn("feishu.approval.ps_forwarding_start_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// P1-08：空闲会话回收巡检（无 active run/排队/审批且超 TTL 才回收句柄）
			convManager?.startLifecycle();
			// 水合应用归属人（owner/creator）与应用协作者作为隐式管理员：自己驱动 agent
			// 时不必手工维护 open_id，且换应用后自动刷新（open_id 是按应用视角生成的）。
			// 注意：这些人只豁免群策略层；群内 @ 仍按 adminBypassMention（默认 false）判定。
			try {
				const info = await transport?.rawRequest({
					url: `/open-apis/application/v6/applications/${config.appId}`,
					method: "GET",
					params: { lang: "zh_cn" },
				});
				const app = ((info as { data?: { app?: Record<string, unknown> } })?.data?.app ?? {}) as Record<string, unknown>;
				const ownerId = ((app.owner as { owner_id?: string } | undefined)?.owner_id)
					?? (typeof app.creator_id === "string" ? app.creator_id : undefined);

				// 协作者（owner 也在该列表中）—— 与归属人合并去重。
				// 该接口可能因 scope 不足而失败，此时退化为仅有归属人，不影响启动。
				let collaboratorIds: string[] = [];
				try {
					const collab = await transport?.rawRequest({
						url: `/open-apis/application/v6/applications/${config.appId}/collaborators`,
						method: "GET",
						params: { user_id_type: "open_id", page_size: 50 },
					});
					const list = ((collab as { data?: { collaborators?: unknown[] } })?.data?.collaborators ?? []) as Array<Record<string, unknown>>;
					collaboratorIds = list
						.map((c) => (typeof c.user_id === "string" ? c.user_id : undefined))
						.filter((v): v is string => Boolean(v));
				} catch (collabError) {
					log.warn("feishu.config.app_collaborators_hydrate_failed", {
						error: collabError instanceof Error ? collabError.message : String(collabError),
						hint: "协作者水合失败，仅归属人生效；管理员仍按 config.admins 生效",
					});
				}

				const hydrated = [...new Set([ownerId, ...collaboratorIds].filter((v): v is string => Boolean(v)))];
				config.implicitAdmins = hydrated;
				log.info("feishu.config.app_owner_hydrated", {
					hasOwner: Boolean(ownerId),
					collaboratorCount: collaboratorIds.length,
					totalImplicitAdmins: hydrated.length,
					adminBypassMention: config.adminBypassMention === true,
				});
			} catch (error) {
				log.warn("feishu.config.app_owner_hydrate_failed", {
					error: error instanceof Error ? error.message : String(error),
					hint: "缺少 application:application:readonly scope 时无法水合归属人；管理员仍按 config.admins 生效",
				});
				config.implicitAdmins = [];
			}
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
			// 先停应答方：未决的转发请求已被 shutdown() 判拒绝，等它们把响应写完再撤心跳，
			// 否则子会话要等满 10 分钟才知道没人服务。
			await psForwarding?.stop();
			try { await pipeline?.stop(); } catch { /* best effort */ }
			// P1-08：先停空闲回收巡检，避免关闭过程中回收句柄
			convManager?.stopLifecycle();
			// P2-01：未决提问全部失效（不假装重启后能恢复）
			const clarifyCancelled = clarificationStore?.shutdown() ?? 0;
			if (clarifyCancelled > 0) log.info("feishu.clarify.shutdown", { cancelled: clarifyCancelled });
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

	/** P2-04：诊断上下文（只含计数与枚举，供 doctor/导出复用）。 */
	function diagnosticsContext() {
		updateStatus();
		return {
			lastErrorClass: status.lastError ? "last_error_present" : undefined,
			outbox: status.outbox,
			conversations: status.conversations,
			pendingApprovals: status.pendingApprovals ?? 0,
			budget: convManager?.budgetSnapshot(),
			piVersion: process.env.PI_VERSION,
			uptimeMs: Math.round(process.uptime() * 1_000),
			transport: { running: Boolean(transport?.isRunning()), connected: Boolean(transport?.isConnected()) },
			forwarding: {
				enabled: Boolean(psForwarding),
				parentSessionId: psForwardingParentId,
				// 心跳新鲜度 = 父会话真的在服务。缺了它子会话会判「父会话不在服务」而提前放弃，
				// 而这种情况在日志里只表现为"等到超时"，很难定位 —— 所以 doctor 里明说。
				serving: psForwarding ? psForwarding.isServing() : undefined,
				alwaysApproved: alwaysApproved
					? {
						enabled: config.approval.forwarding?.alwaysApprove !== false,
						count: alwaysApproved.size,
						patterns: alwaysApproved.list().map((rule) => rule.pattern),
					}
					: undefined,
			},
		};
	}

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
			// P1-07：预算/熔断状态（限流冷却时显示恢复时间，明确 final 不受影响）
			const budget = convManager?.budgetSnapshot();
			if (budget) {
				const live = budget.categories.live ?? { tokens: 0, rejected: 0 };
				const notice = convManager?.budgetCooldownNotice?.();
				lines.push(notice
					? `限流预算: ${notice}`
					: `限流预算: live 令牌 ${live.tokens} / 跳过 ${live.rejected} / 连续失败 ${budget.failures}`);
			}
			if (status.lastMessageAt) {
				// 用配置时区而不是容器时区：容器常是 UTC，直接 toLocaleTimeString() 会差 8 小时。
				lines.push(`最近消息: ${formatTimeInZone(status.lastMessageAt, config.timezone)}`);
			}
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
	// 撤销入口：「始终批准」是一条**持久放行**，必须能看、能撤。
	// 没有它，一次点击就等于永久挖掉一块闸门而无人能收回。
	pi.registerCommand("feishu:always", {
		description: "查看/撤销「始终批准」规则：/feishu:always [revoke <规则名>]",
		handler: (_args, _ctx, args: string[]) => {
			// TUI 是本地操作（能开 TUI 的人本来就持有进程），不做身份校验；
			// 飞书侧的同名命令 /feishu always 有管理员校验。
			if (!alwaysApproved) {
				return "「始终批准」未启用（需要在 pi-permission-system 转发模式下运行）。";
			}
			const rules = alwaysApproved.list();
			const [action, ...rest] = args ?? [];
			if (action === "revoke") {
				const pattern = rest.join(" ").trim();
				if (!pattern) return "用法：/feishu:always revoke <规则名>（规则名见 /feishu:always）";
				const removed = alwaysApproved.remove(pattern);
				log.info("feishu.approval.always_revoked", { pattern, removed });
				return removed
					? `已撤销规则「${pattern}」—— 下次同类请求会重新弹卡。`
					: `没有找到规则「${pattern}」。`;
			}
			if (rules.length === 0) return "当前没有「始终批准」的规则（所有 ask 都会弹卡）。";
			const lines = rules.map((rule) => {
				const when = formatTimeInZone(rule.approvedAt, config.timezone);
				return `· ${rule.pattern}（${when}${rule.approvedBy ? ` · ${rule.approvedBy}` : ""}）`;
			});
			return [
				`「始终批准」规则共 ${rules.length} 条：`,
				...lines,
				"用 /feishu:always revoke <规则名> 撤销。",
			].join("\n");
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
		const toolCallId = typeof (ev as { toolCallId?: unknown }).toolCallId === "string" ? (ev as { toolCallId: string }).toolCallId : undefined;
		convManager?.onToolEvent(sessionId, toolName, "start", (ev.args ?? {}) as Record<string, unknown>, toolCallId);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const sessionId = (ctx as { sessionManager?: { getSessionId(): string } })?.sessionManager?.getSessionId() ?? "";
		const toolName = (event as { toolName?: string })?.toolName ?? "tool";
		const endToolCallId = typeof (event as { toolCallId?: unknown }).toolCallId === "string" ? (event as { toolCallId: string }).toolCallId : undefined;
		convManager?.onToolEvent(sessionId, toolName, "end", undefined, endToolCallId);
	});

	pi.on("session_start", async () => {
		homeDir = process.env.FEISHU_BRIDGE_HOME ?? pi.getAgentDir();
		config = loadConfig(homeDir);
		// PS 父会话转发的父子声明越早越好：它要在任何桥会话被创建之前就位。
		syncPsForwardingEnv();
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

/** 从脱敏后的工具参数里取出 bash 命令文本。 */
function extractBashCommand(paramsText: string): string | undefined {
	try {
		const parsed = JSON.parse(paramsText) as { command?: unknown };
		return typeof parsed?.command === "string" ? parsed.command : undefined;
	} catch {
		return undefined;
	}
}

/** pi 配置目录（PI_CODING_AGENT_DIR）：PS 的转发目录就在它下面。 */
function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.cwd(), "pi-agent");
}

/**
 * 检查 @gotgenes/pi-permission-system 是否真的装在 agent 目录里。
 * 用途：policyEngine=pi-permission-system 时的失败关闭判定 —— 若扩展缺席，
 * 桥的审批就是唯一防线，此时必须继续用自己的策略而不是静默放行。
 * 父会话转发（approval.forwarding）也复用该判定：扩展不在就没有 ask 会转发过来。
 */
function piPermissionSystemInstalled(): boolean {
	const agentDir = resolveAgentDir();
	const candidates = [
		join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"),
		join(agentDir, "extensions", "pi-permission-system"),
	];
	return candidates.some((dir) => {
		try {
			return existsSync(join(dir, "package.json"));
		} catch {
			return false;
		}
	});
}
