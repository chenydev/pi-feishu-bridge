/**
 * 会话管理器：Map<conversationKey, BridgeSession>，每 chat 独立 session/queue/activeRun。
 * 设计依据：docs/DESIGN.md §2.2（B3 根治：pi-remote-feishu ConversationRouter 思想）。
 */
import type { BridgeConfig, FeishuInboundMessage, SessionBackend } from "../types.js";
import type { Sender } from "../outbound/sender.js";

export interface ConversationManagerDeps {
	config: BridgeConfig;
	sessionBackend: SessionBackend;
	sender: Sender;
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
}

const MAX_QUEUE = 50;

export class ConversationManager {
	private sessions = new Map<string, BridgeSession>();
	private runTimeoutMs: number;
	private now: () => number;

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
				sessionFile: `${this.deps.config.sessionDir}/${key}.jsonl`,
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
				// 流式事件（首版仅记日志；完整流式见 DESIGN §10 待决）
				sess.agent.subscribe((ev) => {
					const e = ev as { type?: string };
					this.deps.log?.("debug", "feishu.conv.agent_event", { chatId: sess.chatId, type: e?.type ?? "?" });
				});
			}

			// 组装提示词（回复链路可见性：B1）
			let prompt = item.text;
			if (item.replyToMessageId && item.replyToText) {
				prompt = `用户回复了消息（原文：${item.replyToText.slice(0, 500)}）：\n${prompt}`;
			}

			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("run timeout")), this.runTimeoutMs),
			);
			const done = this.deps.sessionBackend && sess.agent ? sess.agent.prompt(prompt) : Promise.resolve();
			const result = await Promise.race([done, timeout]);

			const text = extractAssistantText(result);
			if (text) {
				await this.deps.sender.send(sess.chatId, text, {
					replyTo: sess.lastReplyId ?? item.replyToMessageId,
				});
			}
			// 记录本 bot 最近发送的消息 id（replyToBot 判定 + 下次回复挂链）
			// 由 sender.onSent 回调维护；此处同步最近一次 reply id：
			// 由桥层统一维护 LastSentCache，本处只更新 sess.lastReplyId
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
