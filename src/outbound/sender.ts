/**
 * 出站发送核心（sender）：markdown 格式化 → chunking → reply/create + uuid 幂等 → 失败回退。
 * 设计依据：docs/DESIGN.md §3.5（B1 出站侧根治）；参考 hermes send/_build_reply_message_body。
 */
import { randomUUID } from "node:crypto";
import type { BridgeConfig, SendOptions, SendResult } from "../types.js";
import type { FeishuTransport } from "../inbound/transport.js";
import { readVerifiedArtifact, type ValidatedArtifact } from "./artifact.js";
import { chunkMarkdown } from "./markdown-chunks.js";
import { isReplyFallbackCode, normalizeApiError, normalizeApiResponse } from "./api-errors.js";

export const MAX_MESSAGE_LENGTH = 16_000;
const MARKDOWN_HINT_RE = /(```|^#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s|\|.*\|)/m;

export interface SenderDeps {
	config: BridgeConfig;
	transport: FeishuTransport;
	/** 发送成功后回调（用于 LastSentCache 记录 replyToBot 判定）。 */
	onSent?: (chatId: string, messageId: string) => void;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface SendResponse {
	code?: number;
	msg?: string;
	retry_after?: number;
	retry_after_ms?: number;
	data?: { message_id?: string };
}

export interface PreparedSend {
	chatId: string;
	msgType: "text" | "post";
	payload: string;
	plainTextPayload: string;
	opts: SendOptions;
	uuid: string;
	contentFallbackUuid: string;
	routeFallbackUuid: string;
}

export interface PreparedMediaSend extends ValidatedArtifact {
	type: "media";
	chatId: string;
	opts: SendOptions;
	uuid: string;
	routeFallbackUuid: string;
	uploadKey?: string;
	uploadedAsFile?: boolean;
}

export type PreparedDelivery = PreparedSend | PreparedMediaSend;
export type DeliveryCheckpoint = (patch: Partial<PreparedMediaSend>) => void;

export function isPreparedMedia(request: PreparedDelivery): request is PreparedMediaSend {
	return (request as PreparedMediaSend).type === "media";
}

export function feishuMessageTypeForMedia(mediaType: PreparedMediaSend["mediaType"]): "image" | "file" | "media" | "audio" {
	return mediaType === "video" ? "media" : mediaType;
}

function responseSucceeded(res: unknown): res is SendResponse {
	const r = res as SendResponse | undefined;
	return Boolean(r && typeof r === "object" && r.code === 0);
}

function errorToResult(error: unknown): SendResult {
	// P0-07：统一归一化 —— 同时看 HTTP status、业务码、响应体与 Retry-After 响应头。
	const normalized = normalizeApiError(error);
	return {
		success: false,
		error: normalized.message,
		retryable: normalized.retryable,
		errorCode: normalized.code ?? normalized.status,
		retryAfterMs: normalized.retryAfterMs,
		errorClass: normalized.errorClass,
	};
}

/** 截断为 maxLen 字符（P0-06：grapheme 边界切分 + 围栏跨片保留，不再拆坏 emoji/代码块）。 */
export function truncateMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
	return chunkMarkdown(text, maxLen);
}

/**
 * markdown 文本 → 飞书 post 富文本 payload（简化版：``` 围栏转 code_block，其余按行 text）。
 * 无 markdown 特征时返回 undefined → 调用方用 text 类型发送。
 */
export function buildMarkdownPostPayload(content: string): string | undefined {
	const lines = content.split("\n");
	const rows: unknown[][] = [];
	let inFence = false;
	let fenceLang = "";
	let fenceLines: string[] = [];
	const flushFence = (): void => {
		if (fenceLines.length > 0) {
			rows.push([{ tag: "code_block", language: fenceLang || "", lines: fenceLines }]);
			fenceLines = [];
		}
	};
	let hasCode = false;
	for (const rawLine of lines) {
		const fence = rawLine.match(/^```(\w*)\s*$/);
		if (fence) {
			hasCode = true;
			if (inFence) {
				flushFence();
				inFence = false;
			} else {
				flushFence();
				inFence = true;
				fenceLang = fence[1] ?? "";
			}
			continue;
		}
		if (inFence) {
			fenceLines.push(rawLine);
			continue;
		}
		if (rawLine.trim()) rows.push([{ tag: "text", text: rawLine }]);
	}
	if (inFence) flushFence();
	if (!hasCode && !MARKDOWN_HINT_RE.test(content)) return undefined;
	return JSON.stringify({
		zh_cn: {
			title: "",
			content: rows.length > 0 ? rows : [[{ tag: "text", text: content.slice(0, 200) }]],
		},
	});
}

/** 去 markdown 纯文本（post 被拒降级用）。 */
export function stripMarkdownToPlainText(text: string): string {
	return text
		.replace(/```[\w]*\n?/g, "")
		.replace(/^#{1,6}\s*/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s*[-*]\s+/gm, "• ")
		.trim();
}

export class Sender {
	private sending = new Map<string, Promise<SendResult>>();

	constructor(private deps: SenderDeps) {}

	/**
	 * 发送一条（或多条 chunk）消息到 chat。
	 * @returns 最后 chunk 的结果；多 chunk 时首 chunk 失败即抛（调用方处理）。
	 */
	async send(chatId: string, content: string, opts: SendOptions = {}): Promise<SendResult> {
		const prepared = this.prepare(chatId, content, opts);
		let last: SendResult = { success: false, error: "empty" };
		for (const request of prepared) {
			last = await this.sendPrepared(request);
			if (!last.success) return last;
		}
		return last;
	}

	/** 将一条逻辑消息渲染为可持久化的 API 请求；每个 chunk 有独立且稳定的 UUID。 */
	prepare(chatId: string, content: string, opts: SendOptions = {}): PreparedSend[] {
		const preferPost = Boolean(buildMarkdownPostPayload(content));
		return truncateMessage(content).map((chunk, index) => {
			const post = preferPost ? buildMarkdownPostPayload(chunk) : undefined;
			return {
				chatId,
				msgType: post ? "post" : "text",
				payload: post ?? JSON.stringify({ text: chunk }),
				plainTextPayload: JSON.stringify({ text: stripMarkdownToPlainText(chunk) }),
				opts: { ...opts, editMessageId: index === 0 ? opts.editMessageId : undefined },
				uuid: randomUUID(),
				contentFallbackUuid: randomUUID(),
				routeFallbackUuid: randomUUID(),
			};
		});
	}

	prepareMedia(chatId: string, artifact: ValidatedArtifact, opts: SendOptions = {}): PreparedMediaSend {
		return {
			type: "media",
			...artifact,
			chatId,
			opts: { ...opts },
			uuid: randomUUID(),
			routeFallbackUuid: randomUUID(),
		};
	}

	/** 发送一个已渲染请求；供 durable outbox 重试，同一对象的 UUID 始终不变。 */
	async sendPrepared(request: PreparedDelivery, checkpoint?: DeliveryCheckpoint): Promise<SendResult> {
		const key = request.uuid;
		const inflight = this.sending.get(key);
		if (inflight) return inflight; // 同内容并发去重（幂等辅助）

		const p = isPreparedMedia(request) ? this.doSendMedia(request, checkpoint) : this.doSendPrepared(request);
		this.sending.set(key, p);
		try {
			const result = await p;
			if (result.success && result.messageId) this.deps.onSent?.(request.chatId, result.messageId);
			return result;
		} finally {
			this.sending.delete(key);
		}
	}

	private async doSendMedia(request: PreparedMediaSend, checkpoint?: DeliveryCheckpoint): Promise<SendResult> {
		try {
			let uploadKey = request.uploadKey;
			if (!uploadKey) {
				const buffer = readVerifiedArtifact(request);
				if (request.mediaType === "image") uploadKey = await this.deps.transport.uploadImage(buffer);
				else {
					const nativeType = request.mediaType === "video" ? "mp4" : request.mediaType === "audio" ? "opus" : "stream";
					try {
						uploadKey = await this.deps.transport.uploadFile(request.fileName, buffer, nativeType);
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						if (nativeType === "stream" || !/(?:unsupported|not support|file.?type|invalid.*(?:mp4|opus)|234006)/i.test(detail)) throw error;
						this.deps.log?.("warn", "feishu.sender.media_fallback_file", { mediaType: request.mediaType, error: detail.slice(0, 160) });
						uploadKey = await this.deps.transport.uploadFile(request.fileName, buffer, "stream");
						request.uploadedAsFile = true;
					}
				}
				request.uploadKey = uploadKey;
				checkpoint?.({ uploadKey, uploadedAsFile: request.uploadedAsFile });
			}
			const msgType = request.uploadedAsFile ? "file" : feishuMessageTypeForMedia(request.mediaType);
			const content = JSON.stringify(request.mediaType === "image" ? { image_key: uploadKey } : { file_key: uploadKey });
			let response = await this.rawSend(request.chatId, msgType, content, request.opts, request.uuid);
			if (request.opts.replyTo && !responseSucceeded(response)) {
				const code = (response as SendResponse)?.code;
				if (code !== undefined && isReplyFallbackCode(code)) {
					response = await this.rawSend(request.chatId, msgType, content, { ...request.opts, replyTo: undefined }, request.routeFallbackUuid);
					return this.toResult(response, true);
				}
			}
			return this.toResult(response);
		} catch (error) {
			return errorToResult(error);
		}
	}

	private async doSendPrepared(request: PreparedSend): Promise<SendResult> {
		const { chatId, opts } = request;
		try {
			let msgType = request.msgType;
			let payload = request.payload;
			if (opts.editMessageId) {
				try {
					const edited = await this.rawEdit(opts.editMessageId, msgType, payload);
					if (responseSucceeded(edited)) return this.toResult(edited, false, false);
					const code = (edited as SendResponse)?.code;
					if (code !== undefined && !isReplyFallbackCode(code)) return this.toResult(edited);
				} catch (error) {
					const status = (error as { response?: { status?: number; data?: { code?: number } } }).response;
					const code = status?.data?.code ?? status?.status;
					if (code !== 404 && (code === undefined || !isReplyFallbackCode(code))) throw error;
				}
				const fallbackOpts = { ...opts, editMessageId: undefined };
				const fallback = await this.rawSend(chatId, msgType, payload, fallbackOpts, request.routeFallbackUuid);
				return this.toResult(fallback, true);
			}
			let res = await this.rawSend(chatId, msgType, payload, opts, request.uuid);
			// post 内容被 API 拒绝 → 降级 text 重发
			if (request.msgType === "post" && !responseSucceeded(res)) {
				const code = (res as SendResponse)?.code;
				if (code && code !== 0 && /post|content|param/i.test((res as SendResponse)?.msg ?? "")) {
					this.deps.log?.("warn", "feishu.sender.post_fallback", { code, msg: (res as SendResponse)?.msg });
					msgType = "text";
					payload = request.plainTextPayload;
					res = await this.rawSend(chatId, msgType, payload, opts, request.contentFallbackUuid);
				}
			}
			// reply 失败（撤回/不存在）→ 降级 create
			if (opts.replyTo && !responseSucceeded(res)) {
				const code = (res as SendResponse)?.code;
				if (code !== undefined && isReplyFallbackCode(code)) {
					this.deps.log?.("warn", "feishu.sender.reply_fallback", { code, replyTo: opts.replyTo, chatId });
					res = await this.rawSend(chatId, msgType, payload, { ...opts, replyTo: undefined }, request.routeFallbackUuid);
					return this.toResult(res, true);
				}
			}
			return this.toResult(res);
		} catch (err) {
			this.deps.log?.("error", "feishu.sender.error", { error: err instanceof Error ? err.message : String(err) });
			return errorToResult(err);
		}
	}

	private async rawEdit(messageId: string, msgType: "text" | "post", payload: string): Promise<unknown> {
		return this.withTimeout(this.deps.transport.rawRequest({
			url: `/open-apis/im/v1/messages/${messageId}`,
			method: "PUT",
			data: { content: payload, msg_type: msgType },
		}));
	}

	private toResult(res: unknown, fallback = false, messageIdRequired = true): SendResult {
		if (responseSucceeded(res)) {
			const messageId = (res as SendResponse)?.data?.message_id;
			if (!messageIdRequired || (typeof messageId === "string" && messageId.length > 0)) return { success: true, messageId, fallback };
			return { success: false, error: "0: missing message_id", fallback, retryable: true, errorCode: 0, errorClass: "content_rejected" };
		}
		// P0-07：非 0 业务码（HTTP 成功）也走同一套分类与 retry-after 解析。
		const normalized = normalizeApiResponse(res);
		return {
			success: false,
			error: `${normalized.code ?? "?"}: ${normalized.message}`,
			fallback,
			retryable: normalized.retryable,
			errorCode: normalized.code,
			retryAfterMs: normalized.retryAfterMs,
			errorClass: normalized.errorClass,
		};
	}

	private async rawSend(chatId: string, msgType: "text" | "post" | "image" | "file" | "media" | "audio", payload: string, opts: SendOptions, uuidValue: string): Promise<unknown> {
		const req = opts.replyTo
			? this.deps.transport.rawRequest({
					url: `/open-apis/im/v1/messages/${opts.replyTo}/reply`,
					method: "POST",
					data: { content: payload, msg_type: msgType, uuid: uuidValue, reply_in_thread: Boolean(opts.threadId) },
				})
			: this.deps.transport.rawRequest({
					url: "/open-apis/im/v1/messages",
					method: "POST",
					params: opts.threadId ? { receive_id_type: "thread_id" } : { receive_id_type: "chat_id" },
					data: { receive_id: opts.threadId ?? chatId, msg_type: msgType, content: payload, uuid: uuidValue },
				});
		// 30s 超时保护：请求 settle 后必须清掉落败的 timer，否则每次成功发送
		// 都会让进程额外挂住 30 秒。
		return this.withTimeout(req);
	}

	private async withTimeout<T>(request: Promise<T>): Promise<T> {
		const setTimer = this.deps.setTimer ?? setTimeout;
		const clearTimer = this.deps.clearTimer ?? clearTimeout;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timeoutTimer = setTimer(() => reject(new Error("request timeout after 30s")), 30_000);
		});
		try {
			return await Promise.race([request, timeout]);
		} finally {
			if (timeoutTimer) clearTimer(timeoutTimer);
		}
	}
}
