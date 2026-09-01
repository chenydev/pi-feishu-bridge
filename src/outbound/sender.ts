/**
 * 出站发送核心（sender）：markdown 格式化 → chunking → reply/create + uuid 幂等 → 失败回退。
 * 设计依据：docs/DESIGN.md §3.5（B1 出站侧根治）；参考 hermes send/_build_reply_message_body。
 */
import { randomUUID } from "node:crypto";
import type { BridgeConfig, SendOptions, SendResult } from "../types.js";
import type { FeishuTransport } from "../inbound/transport.js";

export const MAX_MESSAGE_LENGTH = 16_000;
const MARKDOWN_HINT_RE = /(```|^#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s|\|.*\|)/m;

export interface SenderDeps {
	config: BridgeConfig;
	transport: FeishuTransport;
	/** 发送成功后回调（用于 LastSentCache 记录 replyToBot 判定）。 */
	onSent?: (chatId: string, messageId: string) => void;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

interface SendResponse {
	code?: number;
	msg?: string;
	data?: { message_id?: string };
}

function responseSucceeded(res: unknown): res is SendResponse {
	const r = res as SendResponse | undefined;
	return Boolean(r && typeof r === "object" && (r.code === 0 || r.code === undefined));
}

/** 撤回/不存在/权限等 reply 失败码 → 回退为 create（hermes _FEISHU_REPLY_FALLBACK_CODES 思路）。 */
const REPLY_FALLBACK_CODES = new Set<number>([230003, 230004, 230005, 230007, 230008, 230018, 1001002]);

/** 截断为 maxLen 字符（按 UTF-16 码元，保守处理多字节）。 */
export function truncateMessage(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > maxLen) {
		let cut = rest.lastIndexOf("\n", maxLen);
		if (cut <= 0) cut = maxLen;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) chunks.push(rest);
	return chunks;
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
		const chunks = truncateMessage(content);
		const preferPost = Boolean(buildMarkdownPostPayload(content));
		let last: SendResult = { success: false, error: "empty" };
		for (const chunk of chunks) {
			last = await this.sendChunk(chatId, chunk, opts, preferPost);
			if (!last.success) return last;
			if (last.messageId) {
				this.deps.onSent?.(chatId, last.messageId);
			}
		}
		return last;
	}

	private async sendChunk(chatId: string, chunk: string, opts: SendOptions, preferPost: boolean): Promise<SendResult> {
		const key = `${chatId}:${opts.replyTo ?? "new"}:${chunk.slice(0, 40)}`;
		const inflight = this.sending.get(key);
		if (inflight) return inflight; // 同内容并发去重（幂等辅助）

		const p = this.doSendChunk(chatId, chunk, opts, preferPost);
		this.sending.set(key, p);
		try {
			return await p;
		} finally {
			this.sending.delete(key);
		}
	}

	private async doSendChunk(chatId: string, chunk: string, opts: SendOptions, preferPost: boolean): Promise<SendResult> {
		let msgType = "text" as "text" | "post";
		let payload = JSON.stringify({ text: chunk }, (_, v) => v);
		if (preferPost) {
			const post = buildMarkdownPostPayload(chunk);
			if (post) {
				msgType = "post";
				payload = post;
			}
		}
		const uuidValue = randomUUID();

		try {
			let res = await this.rawSend(chatId, msgType, payload, opts, uuidValue);
			// post 内容被 API 拒绝 → 降级 text 重发
			if (msgType === "post" && !responseSucceeded(res)) {
				const code = (res as SendResponse)?.code;
				if (code && code !== 0 && /post|content|param/i.test((res as SendResponse)?.msg ?? "")) {
					this.deps.log?.("warn", "feishu.sender.post_fallback", { code, msg: (res as SendResponse)?.msg });
					res = await this.rawSend(chatId, "text", JSON.stringify({ text: stripMarkdownToPlainText(chunk) }), opts, randomUUID());
				}
			}
			// reply 失败（撤回/不存在）→ 降级 create
			if (opts.replyTo && !responseSucceeded(res)) {
				const code = (res as SendResponse)?.code;
				if (code !== undefined && REPLY_FALLBACK_CODES.has(code)) {
					this.deps.log?.("warn", "feishu.sender.reply_fallback", { code, replyTo: opts.replyTo, chatId });
					res = await this.rawSend(chatId, msgType, payload, { ...opts, replyTo: undefined }, randomUUID());
					return this.toResult(res, true);
				}
			}
			return this.toResult(res);
		} catch (err) {
			this.deps.log?.("error", "feishu.sender.error", { error: err instanceof Error ? err.message : String(err) });
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private toResult(res: unknown, fallback = false): SendResult {
		if (responseSucceeded(res)) {
			const messageId = (res as SendResponse)?.data?.message_id;
			return { success: true, messageId, fallback };
		}
		const r = res as SendResponse;
		return { success: false, error: `${r?.code ?? "?"}: ${r?.msg ?? "unknown"}`, fallback };
	}

	private async rawSend(chatId: string, msgType: "text" | "post", payload: string, opts: SendOptions, uuidValue: string): Promise<unknown> {
		if (opts.replyTo) {
			return this.deps.transport.rawRequest({
				url: `/open-apis/im/v1/messages/${opts.replyTo}/reply`,
				method: "POST",
				data: { content: payload, msg_type: msgType, uuid: uuidValue, reply_in_thread: Boolean(opts.threadId) },
			});
		}
		const body: Record<string, unknown> = { receive_id: opts.threadId ?? chatId, msg_type: msgType, content: payload, uuid: uuidValue };
		const params = opts.threadId ? { receive_id_type: "thread_id" } : { receive_id_type: "chat_id" };
		return this.deps.transport.rawRequest({ url: "/open-apis/im/v1/messages", method: "POST", params, data: body });
	}
}
