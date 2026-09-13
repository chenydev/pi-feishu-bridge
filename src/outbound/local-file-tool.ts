import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SendOptions } from "../types.js";
import type { ExtensionToolResult } from "../pi-types.js";
import type { EnqueueOptions } from "./outbox.js";
import type { ValidatedArtifact } from "./artifact.js";
import { stageArtifact, validateLocalArtifact } from "./artifact.js";

export interface ActiveFeishuRoute {
	conversationKey: string;
	chatId: string;
	threadId?: string;
	sourceMessageId?: string;
}

export interface LocalFileOutbox {
	hasDedupeKey(key: string): boolean;
	enqueueMedia(chatId: string, artifact: ValidatedArtifact, opts: SendOptions, meta: EnqueueOptions): string;
	enqueue(chatId: string, text: string, opts: SendOptions, meta: EnqueueOptions): string[];
}

export async function queueLocalFile(params: {
	toolCallId: string;
	path: unknown;
	caption: unknown;
	cwd: string;
	homeDir: string;
	route?: ActiveFeishuRoute;
	outbox?: LocalFileOutbox;
}): Promise<ExtensionToolResult> {
	const requestedPath = typeof params.path === "string" ? params.path : "";
	const caption = typeof params.caption === "string" ? params.caption.trim().slice(0, 2_000) : "";
	if (!requestedPath) return { content: [{ type: "text", text: "错误：path 必填" }], isError: true };
	if (!params.route || !params.outbox) {
		return { content: [{ type: "text", text: "无法发送：当前不是由飞书消息触发的活动会话" }], isError: true };
	}
	const mediaDedupeKey = `${params.toolCallId}:media`;
	if (params.outbox.hasDedupeKey(mediaDedupeKey)) {
		return { content: [{ type: "text", text: "该文件发送请求已经排队，无需重复提交" }] };
	}

	let staged: ValidatedArtifact | undefined;
	let mediaEnqueued = false;
	try {
		const validated = validateLocalArtifact(requestedPath, params.cwd);
		staged = stageArtifact(validated, join(params.homeDir, "feishu-bridge", "media-outbox"));
		const sendOptions = { replyTo: params.route.sourceMessageId, threadId: params.route.threadId };
		params.outbox.enqueueMedia(params.route.chatId, staged, sendOptions, {
			dedupeKey: mediaDedupeKey, laneKey: params.route.conversationKey, kind: "media",
		});
		mediaEnqueued = true;
		let captionWarning = "";
		if (caption) {
			try {
				params.outbox.enqueue(params.route.chatId, caption, sendOptions, {
					dedupeKey: `${params.toolCallId}:caption`, laneKey: params.route.conversationKey, kind: "notify",
				});
			} catch (error) {
				captionWarning = `；说明文字排队失败：${error instanceof Error ? error.message : String(error)}`;
			}
		}
		return {
			content: [{ type: "text", text: `已可靠排队发送 ${staged.fileName}${caption ? "及说明文字" : ""}${captionWarning}` }],
			details: { fileName: staged.fileName, mediaType: staged.mediaType, byteLength: staged.byteLength },
		};
	} catch (error) {
		if (staged?.deleteAfterSend && !mediaEnqueued) {
			try { unlinkSync(staged.localPath); } catch { /* best effort */ }
		}
		return { content: [{ type: "text", text: `发送失败：${error instanceof Error ? error.message : String(error)}` }], isError: true };
	}
}
