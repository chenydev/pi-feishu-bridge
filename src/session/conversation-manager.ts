/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 设计依据：docs/DESIGN.md §2.2（B3 根治：pi-remote-feishu ConversationRouter 思想）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeConfig, FeishuInboundMessage, SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";

/** 工具友好名（hermes build_status_phrase / pi-feishu toolDisplayName 风格）。 */
function toolLabel(tool: string): string {
	const map: Record<string, string> = {
		read: "读取文件", write: "写入文件", edit: "编辑文件", bash: "执行命令", terminal: "执行命令",
		grep: "搜索内容", find: "查找文件", fetch_content: "抓取网页", web_search: "搜索网页",
		browser: "浏览网页", subagent_spawn: "启动子代理", memory_search: "搜索记忆",
		"mcp": "调用 MCP", "plan_mode_question": "确认方案", "ask_user_question": "向你提问",
	};
	return map[tool] ?? tool;
}

/** pending 中断恢复文件（hermes resume_pending 简化版）：agent 运行中进程被杀，
 * 重启后据此重发未完成消息。 */
interface PendingEntry {
	chatId: string;
	messageId: string;
	text: string;
	threadId?: string;
	replyToMessageId?: string;
	replyToText?: string;
	ts: number;
}

export interface ConversationManagerDeps {
	config: BridgeConfig;
	/** 会话文件目录（绝对路径；避免相对路径落在 /workspace 无权限）。 */
	sessionDir: string;
	sessionBackend: SessionBackend;
	sender: Sender;
	/** 本 bot 最近已发消息缓存（回复"自己消息"判定，hermes reply_to_is_own_message 等价）。 */
	lastSent?: { has(messageId: string): boolean };
	/** 处理中表情（reaction）能力：入队时添加、回复发出后撤回。 */
	reactions?: {
		add(messageId: string, emoji: string): Promise<string | undefined>;
		remove(messageId: string, reactionId: string): Promise<boolean>;
	};
	/** 进度消息编辑/撤回（方案 A：处理中消息实时更新工具进度）。 */
	editMessage?: (messageId: string, text: string) => Promise<boolean>;
	recallMessage?: (messageId: string) => Promise<boolean>;
	/** agent 回复文本的发送器（默认 sender.send 到 chat，回复挂 bot 上一条消息）。 */
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/** 超时（默认 300s）后通知用户并释放。 */
	runTimeoutMs?: number;
	now?: () => number;
	/** pending 中断恢复文件路径（hermes resume_pending；不设则禁用）。 */
	pendingFile?: string;
}

interface BridgeSession {
	conversationKey: string;
	/** 原始 chatId（发送目标）；key 用于会话隔离。 */
	chatId: string;
	/** 话题 id（话题会话的发送目标 threadId）。 */
	threadId?: string;
	agent?: Awaited<ReturnType<SessionBackend["createSession"]>>;
	/** agent 运行时 sessionId（tool 事件映射用，pi.on ctx.sessionManager.getSessionId()）。 */
	sessionId?: string;
	sessionFile: string;
	queue: Array<QueuedMessage>;
	activeRun: boolean;
	lastReplyId?: string;
	createdAt: number;
}

interface QueuedMessage {
	chatId: string;
	messageId: string;
	text: string;
	replyToMessageId?: string;
	replyToText?: string;
	/** 话题（thread_id）透传：hermes 话题模式。 */
	threadId?: string;
	/** 处理中表情：reaction_id（add 时返回）。 */
	reactionId?: string;
	emojiReactionId?: string;
}

const MAX_QUEUE = 50;

export class ConversationManager {
	private sessions = new Map<string, BridgeSession>();
	private runTimeoutMs: number;
	private now: () => number;
	/** 最近一次注入的引用块（发送前清洗模型复述用）。 */
	private lastQuoteBlock = "";
	/** 进度消息状态（方案 A）：progressMessageId + 节流时间。 */
	private readonly progressBySession = new Map<string, { messageId?: string; lastUpdateAt: number; toolStack: string[] }>();
	private readonly progressMinIntervalMs = 1500;
	private readonly progressMaxLines = 4;
	private readonly pendingFile: string;
	private readonly pendingEnabled: boolean;

	constructor(private deps: ConversationManagerDeps) {
		this.runTimeoutMs = deps.runTimeoutMs ?? 300_000;
		this.now = deps.now ?? Date.now;
		this.pendingFile = deps.pendingFile ?? "";
		this.pendingEnabled = Boolean(deps.pendingFile);
	}

	/** 工具事件 → 进度消息更新（pi.on("tool_execution_start/end") 转接）。 */
	onToolEvent(sessionId: string, toolName: string, kind: "start" | "end", isError?: boolean): void {
		const sess = [...this.sessions.values()].find((s) => s.sessionId === sessionId);
		if (!sess) return;
		const st = this.progressBySession.get(sessionId) ?? { lastUpdateAt: 0, toolStack: [] };
		if (kind === "start") st.toolStack.push(toolName);
		else {
			const i = st.toolStack.lastIndexOf(toolName);
			if (i >= 0) st.toolStack.splice(i, 1);
		}
		this.progressBySession.set(sessionId, st);
		void this.renderProgress(sess, st);
	}

	private async renderProgress(sess: BridgeSession, st: { messageId?: string; lastUpdateAt: number; toolStack: string[] }): Promise<void> {
		if (!this.deps.editMessage) return;
		const now = Date.now();
		if (now - st.lastUpdateAt < this.progressMinIntervalMs) return; // 节流
		st.lastUpdateAt = now;
		if (!st.messageId) return; // 进度消息还没发（或已撤回）
		const lines = st.toolStack.slice(-this.progressMaxLines).map((t) => `🔧 ${toolLabel(t)}`);
		const text = lines.length ? `🤖 正在处理…
${lines.join("\n")}` : "🤖 正在处理…";
		await this.deps.editMessage(st.messageId, text);
	}

	/** 启动时恢复上次中断的未完成消息（hermes resume_pending）。 */
	async recoverPending(): Promise<number> {
		if (!this.pendingEnabled) return 0;
		let entries: PendingEntry[] = [];
		try {
			if (existsSync(this.pendingFile)) {
				entries = readFileSync(this.pendingFile, "utf8").split("\n").filter(Boolean).map((l) => {
					try { return JSON.parse(l) as PendingEntry; } catch { return undefined; }
				}).filter((e): e is PendingEntry => Boolean(e));
			}
		} catch {
			return 0;
		}
		try {
			writeFileSync(this.pendingFile, "", "utf8"); // 清空，避免恢复过程中重复入队
		} catch {
			/* ignore */
		}
		for (const e of entries) {
			this.deps.log?.("warn", "feishu.conv.recover_pending", { chatId: e.chatId, messageId: e.messageId });
			const msg: FeishuInboundMessage = {
				messageId: e.messageId,
				chatId: e.chatId,
				chatType: "group",
				senderId: "",
				isBot: false,
				msgType: "text",
				text: e.text,
				mentions: [],
				replyToMessageId: e.replyToMessageId,
				replyToText: e.replyToText,
				threadId: e.threadId,
				raw: undefined,
				ts: e.ts,
			};
			await this.route(msg);
		}
		return entries.length;
	}

	private markPending(item: QueuedMessage): void {
		if (!this.pendingEnabled) return;
		try {
			mkdirSync(dirname(this.pendingFile), { recursive: true });
			const entry: PendingEntry = {
				chatId: item.chatId, messageId: item.messageId, text: item.text,
				threadId: item.threadId, replyToMessageId: item.replyToMessageId, replyToText: item.replyToText,
				ts: Date.now(),
			};
			writeFileSync(this.pendingFile, JSON.stringify(entry) + "\n", { flag: "a" });
		} catch {
			/* ignore */
		}
	}

	private clearPending(item: QueuedMessage): void {
		if (!this.pendingEnabled) return;
		try {
			if (!existsSync(this.pendingFile)) return;
			const lines = readFileSync(this.pendingFile, "utf8").split("\n").filter(Boolean);
			const rest = lines.filter((l) => {
				try { return (JSON.parse(l) as PendingEntry).messageId !== item.messageId; } catch { return false; }
			});
			writeFileSync(this.pendingFile, rest.length ? rest.join("\n") + "\n" : "", "utf8");
		} catch {
			/* ignore */
		}
	}

	count(): number {
		return this.sessions.size;
	}

	listKeys(): string[] {
		return [...this.sessions.keys()];
	}

	/**
	 * 路由入站消息：同 chat 串行（排队），跨 chat 并行。
	 * 回复链路：入站 replyToText 注入提示词；出站 send 挂 chat 上一条 bot 消息。
	 */
	async route(msg: FeishuInboundMessage): Promise<void> {
		// 会话 key（对齐 hermes build_session_key）：
		// 1. 话题消息：chatId:t:threadId → 话题独立会话（thread_sessions_per_user=false：
		//    话题内所有参与者共享同一话题会话——B 回复 A 的话题消息复用同一上下文）
		// 2. 群普通消息：groupSessionsPerUser=true → chatId:u:senderId
		//    （B 在主聊天发无关联新消息 → B 自己的新会话）
		// 3. 私聊：chatId（p2p chat）
		const key = msg.threadId
			? `${msg.chatId}:t:${msg.threadId}`
			: msg.chatType === "group" && this.deps.config.groupSessionsPerUser
				? `${msg.chatId}:u:${msg.senderId || "unknown"}`
				: msg.chatId;
		let sess = this.sessions.get(key);
		if (!sess) {
			sess = {
				conversationKey: key,
				chatId: msg.chatId,
				threadId: msg.threadId,
				sessionFile: join(this.deps.sessionDir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`),
				queue: [],
				activeRun: false,
				createdAt: this.now(),
			};
			this.sessions.set(key, sess);
		}

		const queued: QueuedMessage = {
			chatId: msg.chatId,
			messageId: msg.messageId,
			text: msg.text,
			replyToMessageId: msg.replyToMessageId,
			replyToText: msg.replyToText,
			threadId: msg.threadId,
		};
		// 处理中表情（hermes 式）：入队即添加，runOne 结束后撤回
		if (this.deps.config.reaction.enabled && this.deps.reactions) {
			const reactionId = await this.deps.reactions.add(msg.messageId, this.deps.config.reaction.processingEmoji);
			queued.reactionId = msg.messageId;
			queued.emojiReactionId = reactionId ?? "";
		}
		if (sess.queue.length >= MAX_QUEUE) {
			this.deps.log?.("warn", "feishu.conv.queue_full", { chatId: key });
			await this.notify(key, "消息过多，当前队列已满，请稍后再试。");
			return;
		}
		sess.queue.push(queued);
		if (!sess.activeRun) {
			sess.activeRun = true;
			void this.pump(sess);
		}
	}

	private async pump(sess: BridgeSession): Promise<void> {
		try {
			while (sess.queue.length > 0) {
				const item = sess.queue.shift();
				if (!item) break;
				await this.runOne(sess, item);
			}
		} finally {
			sess.activeRun = false;
		}
	}

	private async runOne(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		this.markPending(item);
		const sid = sess.sessionId ?? "unknown";
		const st = this.progressBySession.get(sid) ?? { lastUpdateAt: 0, toolStack: [] };
		this.progressBySession.set(sid, st);
		// 方案 A：处理中进度消息（完成后撤回）
		if (this.deps.sender) {
			const sent = await this.deps.sender.send(item.chatId, "🤖 正在处理…", {});
			if (sent.success && sent.messageId) st.messageId = sent.messageId;
		}
		try {
			if (!sess.agent) {
				sess.agent = await this.deps.sessionBackend.createSession({
					chatId: sess.chatId,
					conversationKey: sess.conversationKey,
					sessionFile: sess.sessionFile,
				});
				sess.sessionId = sess.agent.sessionId;
			}

			// 流式/完成事件：从 subscribe 事件提取回复文本（pi SDK 的 prompt() 返回值
			// 结构不可靠，pi-feishu-link 同样走事件通道：message_update.text_delta 累积、
			// message_end.content 完整提取）。
			let streamedText = "";
			let sentFromEvent = false;
			const sendReply = async (text: string): Promise<void> => {
				if (sentFromEvent || !text.trim()) return;
				sentFromEvent = true;
				try {
					this.deps.log?.("debug", "feishu.conv.send_reply_start", { chatId: sess.chatId, textLen: text.length });
					// 模型偶发复述注入的引用块/提示：剥离后发送
					const cleaned = stripInjectedPrompt(text, this.lastQuoteBlock);
					if (!cleaned.trim()) {
						// 纯引用残留（无实际内容）：静默跳过，不报错
						this.deps.log?.("debug", "feishu.conv.empty_after_strip", { chatId: sess.chatId });
						return;
					}
					// 回复挂用户消息（hermes: reply_to = source.message_id）；
					// 话题会话发送到话题（threadId 优先会话级，其次消息级）
					const res = await this.deps.sender.send(sess.chatId, cleaned, {
						replyTo: item.messageId,
						threadId: sess.threadId ?? item.threadId,
					});
					this.deps.log?.("info", "feishu.conv.reply_sent", {
						chatId: sess.chatId,
						success: res.success,
						messageId: res.messageId,
						error: res.error,
						fallback: res.fallback,
						textLen: text.trim().length,
					});
				} catch (err) {
					this.deps.log?.("error", "feishu.conv.send_error", {
						chatId: sess.chatId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};
			sess.agent.subscribe((ev) => {
				this.deps.log?.("debug", "feishu.conv.event", {
					chatId: sess.chatId,
					type: (ev as { type?: string })?.type ?? "?",
				});
				const e = ev as {
					type?: string;
					delta?: string;
					assistantMessageEvent?: { type?: string; delta?: string };
					message?: { role?: string; content?: unknown; id?: string };
					content?: unknown;
				};
				if (e.type === "message_update") {
					if (e.assistantMessageEvent?.type === "text_delta" && typeof e.assistantMessageEvent.delta === "string") {
						streamedText += e.assistantMessageEvent.delta;
					} else if (typeof e.delta === "string") {
						streamedText += e.delta;
					}
				} else if (e.type === "message_end") {
					// 关键：user 消息也会触发 message_end（role=user），必须先到会抢占
					// sentFromEvent 导致 assistant 完整回复被跳过（对齐 pi-feishu-link
					// handleMessageEnd 的 role==='assistant' 检查）
					if (e.message?.role !== "assistant") return;
					const text = extractText(e.message?.content ?? e.content);
					this.deps.log?.("debug", "feishu.conv.message_end_extract", {
						chatId: sess.chatId,
						textLen: text?.length ?? 0,
						hasMessage: Boolean(e.message),
						hasContent: Boolean(e.content),
					});
					if (text) void sendReply(text);
				}
			});

			// 组装提示词（回复链路可见性：B1）——对齐 hermes 的回复注入格式：
			// `[Replying to: "原文"]` 方括号元信息（非对话内容，模型不易复述）；
			// 区分回复自己消息 vs 回复他人消息；原文截断 500、占位转 @。
			let prompt = item.text;
			if (item.replyToMessageId && item.replyToText) {
				const quote = item.replyToText.slice(0, 500).replace(/@_user_\w+/g, "@").replace(/\n/g, " ");
				const replyingToSelf = Boolean(this.deps.lastSent?.has(item.replyToMessageId));
				prompt = replyingToSelf
					? `[你正在回复自己上一条消息，原文："${quote}"]\n\n${item.text}`
					: `[正在回复的消息原文："${quote}"]\n\n${item.text}`;
			}
			this.lastQuoteBlock = prompt;

			// 运行超时保护（300s；timer 必须清理，否则测试/进程悬挂）
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timeoutTimer = setTimeout(() => reject(new Error("run timeout")), this.runTimeoutMs);
			});
			const result = await Promise.race([sess.agent.prompt(prompt), timeout]);
			if (timeoutTimer) clearTimeout(timeoutTimer);

			// 兜底：事件通道未送出则用累积流式文本/返回值
			if (!sentFromEvent) {
				const text = streamedText.trim() || extractAssistantText(result);
				this.deps.log?.("debug", "feishu.conv.fallback_send", {
					chatId: sess.chatId,
					streamedLen: streamedText.length,
					fallbackLen: text?.length ?? 0,
				});
				if (text) await sendReply(text);
			}
			await this.removeProcessingReaction(sess, item);
			await this.finishProgress(sess, st);
			this.clearPending(item);
		} catch (err) {
			await this.finishProgress(sess, st);
			this.clearPending(item);
			const msg = err instanceof Error ? err.message : String(err);
			if (msg === "run timeout") {
				await this.notify(sess.chatId, "任务处理超时已中止，请重试。");
			} else {
				this.deps.log?.("error", "feishu.conv.run_error", { chatId: sess.chatId, error: msg });
				await this.notify(sess.chatId, `处理出错：${msg.slice(0, 200)}`);
			}
		}
	}

	/** 撤回进度消息（方案 A：正式回复前撤回，避免刷屏）。 */
	private async finishProgress(sess: BridgeSession, st: { messageId?: string; lastUpdateAt: number; toolStack: string[] }): Promise<void> {
		if (!this.deps.recallMessage) return;
		if (st.messageId) {
			await this.deps.recallMessage(st.messageId);
			st.messageId = undefined;
		}
		this.progressBySession.delete(sess.sessionId ?? "unknown");
	}

	private async removeProcessingReaction(sess: BridgeSession, item: QueuedMessage): Promise<void> {
		if (!this.deps.reactions || !item.messageId || !item.emojiReactionId) return;
		try {
			await this.deps.reactions.remove(item.messageId, item.emojiReactionId);
		} catch {
			/* ignore */
		}
	}

	/** 供桥层在每次成功发送后更新 lastReplyId（真实回复链）。 */
	updateLastReplyId(chatId: string, messageId: string): void {
		const sess = this.sessions.get(chatId);
		if (sess) sess.lastReplyId = messageId;
	}

	private async notify(chatId: string, text: string): Promise<void> {
		try {
			await this.deps.sender.send(chatId, text);
		} catch {
			/* ignore */
		}
	}

	stop(): void {
		this.sessions.clear();
	}
}

/**
 * 剥离模型复述的注入提示（引用块 + 空行 + 原始用户消息残留）：
 * - 删除开头的 `> 引用` 连续块
 * - 删除"以下是用户回复…"等引导句残留
 */
export function stripInjectedPrompt(text: string, quoteBlock: string): string {
	let out = text;
	// 精确剥离本次注入块（若被完整复述）
	if (quoteBlock && out.includes(quoteBlock)) out = out.replace(quoteBlock, "");
	// 兜底：剥离开头引用块行（> ...）及其后空行
	out = out.replace(/^(> [^\n]*\n?)+/, "");
	out = out.replace(/^\n+/, "");
	// 兜底：剥离 hermes 式回复注入残留（[正在回复…] / [你正在回复…] / 旧格式引导句）
	out = out.replace(/^\[(?:正在回复|你正在回复)[^\]]*\]\s*\n?/, "");
	out = out.replace(/^(以下是用户回复[^\n]*\n?)+/, "");
	out = out.replace(/^\[系统提示[^\]]*\]\s*\n?/, "");
	return out.trim();
}

/** 从事件 content 提取文本（pi 的 assistant message content 结构：string 或 [{type:'text',text}] 数组）。 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: string }).type === "text"
				? ((p as { text?: string }).text ?? "")
				: "",
		)
		.join("")
		.trim();
}

/** 从 agent 结果中提取助手文本（兼容字符串/含 message 的对象）。 */
export function extractAssistantText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (typeof r.text === "string" && r.text.trim()) return r.text;
		const msg = r.message as Record<string, unknown> | undefined;
		if (msg && typeof msg.text === "string" && msg.text.trim()) return msg.text;
	}
	return undefined;
}
