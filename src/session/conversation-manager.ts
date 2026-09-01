/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 设计依据：docs/DESIGN.md §2.2（B3 根治：pi-remote-feishu ConversationRouter 思想）。
 */
import { join } from "node:path";
import type { BridgeConfig, FeishuInboundMessage, SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";

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
	/** agent 回复文本的发送器（默认 sender.send 到 chat，回复挂 bot 上一条消息）。 */
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/** 超时（默认 300s）后通知用户并释放。 */
	runTimeoutMs?: number;
	now?: () => number;
}

interface BridgeSession {
	conversationKey: string;
	chatId: string;
	agent?: Awaited<ReturnType<SessionBackend["createSession"]>>;
	sessionFile: string;
	queue: Array<QueuedMessage>;
	activeRun: boolean;
	lastReplyId?: string;
	createdAt: number;
}

interface QueuedMessage {
	messageId: string;
	text: string;
	replyToMessageId?: string;
	replyToText?: string;
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

	constructor(private deps: ConversationManagerDeps) {
		this.runTimeoutMs = deps.runTimeoutMs ?? 300_000;
		this.now = deps.now ?? Date.now;
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
		const key = msg.chatId;
		let sess = this.sessions.get(key);
		if (!sess) {
			sess = {
				conversationKey: key,
				chatId: key,
				sessionFile: join(this.deps.sessionDir, `${key}.jsonl`),
				queue: [],
				activeRun: false,
				createdAt: this.now(),
			};
			this.sessions.set(key, sess);
		}

		const queued: QueuedMessage = {
			messageId: msg.messageId,
			text: msg.text,
			replyToMessageId: msg.replyToMessageId,
			replyToText: msg.replyToText,
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
		try {
			if (!sess.agent) {
				sess.agent = await this.deps.sessionBackend.createSession({
					chatId: sess.chatId,
					conversationKey: sess.conversationKey,
					sessionFile: sess.sessionFile,
				});
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
					const res = await this.deps.sender.send(sess.chatId, cleaned, {
						replyTo: sess.lastReplyId ?? item.replyToMessageId,
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
					message?: { content?: unknown; id?: string };
					content?: unknown;
				};
				if (e.type === "message_update") {
					if (e.assistantMessageEvent?.type === "text_delta" && typeof e.assistantMessageEvent.delta === "string") {
						streamedText += e.assistantMessageEvent.delta;
					} else if (typeof e.delta === "string") {
						streamedText += e.delta;
					}
				} else if (e.type === "message_end") {
					// 诊断：打印事件原始结构（定位提取 textLen 过短问题）
					this.deps.log?.("debug", "feishu.conv.message_end_raw", {
						chatId: sess.chatId,
						raw: JSON.stringify(e).slice(0, 600),
					});
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

			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("run timeout")), this.runTimeoutMs),
			);
			const result = await Promise.race([sess.agent.prompt(prompt), timeout]);

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
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg === "run timeout") {
				await this.notify(sess.chatId, "任务处理超时已中止，请重试。");
			} else {
				this.deps.log?.("error", "feishu.conv.run_error", { chatId: sess.chatId, error: msg });
				await this.notify(sess.chatId, `处理出错：${msg.slice(0, 200)}`);
			}
		}
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
