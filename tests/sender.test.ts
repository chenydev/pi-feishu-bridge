/**
 * sender 单元测试：chunking、markdown→post、reply 回退、降级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateMessage, buildMarkdownPostPayload, stripMarkdownToPlainText } from "../src/outbound/sender.js";
import { Sender } from "../src/outbound/sender.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";
import type { FeishuTransport } from "../src/inbound/transport.js";
import { validateLocalArtifact } from "../src/outbound/artifact.js";

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, ...over };
}

test("truncateMessage：按换行切分", () => {
	const text = "a".repeat(100) + "\n" + "b".repeat(50);
	const chunks = truncateMessage(text, 80);
	assert.equal(chunks.length, 2);
	assert.ok(chunks[0].length <= 80);
	assert.equal(chunks[0] + chunks[1].replace(/^\n/, ""), text);
});

test("truncateMessage：无换行硬切", () => {
	const chunks = truncateMessage("x".repeat(200), 50);
	assert.ok(chunks.length >= 4);
});

test("buildMarkdownPostPayload：代码块 → post", () => {
	const payload = buildMarkdownPostPayload("```ts\nconst a = 1;\n```");
	assert.ok(payload);
	const parsed = JSON.parse(payload as string);
	const row = parsed.zh_cn.content[0][0];
	assert.equal(row.tag, "code_block");
	assert.equal(row.language, "ts");
	assert.deepEqual(row.lines, ["const a = 1;"]);
});

test("buildMarkdownPostPayload：普通文本 → undefined（用 text 类型）", () => {
	assert.equal(buildMarkdownPostPayload("普通文本"), undefined);
});

test("buildMarkdownPostPayload：标题 → post", () => {
	assert.ok(buildMarkdownPostPayload("# 标题\n内容"));
});

test("stripMarkdownToPlainText：去 markdown 符号", () => {
	assert.equal(stripMarkdownToPlainText("**加粗** `代码` [链接](https://x.com)"), "加粗 代码 链接");
});

// ------------------------------------------------------------ fake transport ----

class RecordingTransport {
	calls: Array<{ url: string; method: string; params?: unknown; data?: unknown }> = [];
	replies: Array<unknown> = [];
	uploads = 0;
	uploadFileTypes: string[] = [];
	async uploadImage(_buffer: Buffer): Promise<string> { this.uploads += 1; return "img_key"; }
	async uploadFile(_name: string, _buffer: Buffer, fileType = "stream"): Promise<string> { this.uploads += 1; this.uploadFileTypes.push(fileType); return "file_key"; }
	async rawRequest(opts: { url: string; method: string; params?: unknown; data?: unknown }): Promise<unknown> {
		this.calls.push(opts);
		const r = this.replies.shift();
		return r ?? { code: 0, data: { message_id: "om_out" } };
	}
}

function makeSender(over: Partial<BridgeConfig> = {}, onSent?: (chat: string, id: string) => void): { rec: RecordingTransport; sender: Sender } {
	const rec = new RecordingTransport();
	const t = rec as unknown as FeishuTransport;
	const sender = new Sender({ config: cfg(over), transport: t, onSent });
	return { rec, sender };
}

test("sender：普通文本走 create", async () => {
	const { rec, sender } = makeSender();
	const res = await sender.send("oc_1", "你好");
	assert.equal(res.success, true);
	assert.equal(rec.calls[0].url, "/open-apis/im/v1/messages");
	assert.match((rec.calls[0].data as { content: string }).content, /你好/);
});

test("sender：媒体上传 checkpoint 后重试不重复上传，消息 UUID 稳定", async () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-sender-media-"));
	try {
		const path = join(dir, "result.txt");
		writeFileSync(path, "result");
		const { rec, sender } = makeSender();
		const request = sender.prepareMedia("oc_1", {
			localPath: path, fileName: "result.txt", mediaType: "file", byteLength: 6,
			sha256: "f6a214f7a5fcda0c2cee9660b7fc29f5649e3c68aad48e20e950137c98913a68",
		}, { replyTo: "om_parent" });
		let checkpoint = "";
		const first = await sender.sendPrepared(request, (patch) => { checkpoint = patch.uploadKey ?? ""; });
		const second = await sender.sendPrepared(request);
		assert.equal(first.success, true);
		assert.equal(second.success, true);
		assert.equal(checkpoint, "file_key");
		assert.equal(rec.uploads, 1);
		assert.equal((rec.calls[0].data as { msg_type: string }).msg_type, "file");
		assert.deepEqual(rec.calls.map((call) => (call.data as { uuid: string }).uuid), [request.uuid, request.uuid]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sender：reply 走 reply API 并挂 uuid", async () => {
	const { rec, sender } = makeSender();
	const res = await sender.send("oc_1", "回复内容", { replyTo: "om_parent" });
	assert.equal(res.success, true);
	assert.equal(rec.calls[0].url, "/open-apis/im/v1/messages/om_parent/reply");
	const data = rec.calls[0].data as { uuid?: string; msg_type?: string };
	assert.ok(data.uuid, "uuid 幂等");
	assert.equal(data.msg_type, "text");
});

test("sender：post 被拒降级 text 重发", async () => {
	const { rec, sender } = makeSender();
	rec.replies = [
		{ code: 190001, msg: "invalid post content" },
		{ code: 0, data: { message_id: "om_out2" } },
	];
	const res = await sender.send("oc_1", "# 标题\n正文");
	assert.equal(res.success, true);
	assert.equal(rec.calls.length, 2);
	assert.equal((rec.calls[1].data as { msg_type: string }).msg_type, "text");
});

test("sender：reply 撤回回退 create（B1 出站侧）", async () => {
	const { rec, sender } = makeSender();
	rec.replies = [
		{ code: 230003, msg: "message not found" },
		{ code: 0, data: { message_id: "om_new" } },
	];
	const res = await sender.send("oc_1", "你好", { replyTo: "om_gone" });
	assert.equal(res.success, true);
	assert.equal(res.fallback, true);
	assert.equal(rec.calls.length, 2);
	assert.equal(rec.calls[1].url, "/open-apis/im/v1/messages");
});

test("sender：onSent 回调记录已发消息 id", async () => {
	const sent: Array<{ chat: string; id: string }> = [];
	const { sender } = makeSender({}, (chat, id) => { sent.push({ chat, id }); });
	await sender.send("oc_1", "你好");
	assert.deepEqual(sent, [{ chat: "oc_1", id: "om_out" }]);
});

test("sender：长文分块逐条发送", async () => {
	const { rec, sender } = makeSender();
	await sender.send("oc_1", "x".repeat(40_000));
	assert.ok(rec.calls.length >= 2);
});

test("sender：请求成功后立即清理超时 timer", async () => {
	const rec = new RecordingTransport();
	const created: object[] = [];
	const cleared: object[] = [];
	const sender = new Sender({
		config: cfg(),
		transport: rec as unknown as FeishuTransport,
		setTimer: (_fn, ms) => {
			assert.equal(ms, 30_000);
			const handle = {};
			created.push(handle);
			return handle as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle) => { cleared.push(handle as object); },
	});

	const res = await sender.send("oc_1", "你好");
	assert.equal(res.success, true);
	assert.equal(created.length, 1);
	assert.deepEqual(cleared, created);
});

test("sender：PreparedSend 重试保持主请求 UUID 稳定", async () => {
	const { rec, sender } = makeSender();
	rec.replies = [
		{ code: 500, msg: "temporary unavailable" },
		{ code: 0, data: { message_id: "om_retried" } },
	];
	const request = sender.prepare("oc_1", "可靠回复", {})[0];
	assert.ok(request);
	const first = await sender.sendPrepared(request);
	const second = await sender.sendPrepared(request);
	assert.equal(first.retryable, true);
	assert.equal(second.success, true);
	const uuids = rec.calls.map((call) => (call.data as { uuid: string }).uuid);
	assert.deepEqual(uuids, [request.uuid, request.uuid]);
});

test("sender：durable final 优先编辑 live 消息，失效后以稳定 UUID 回退 reply", async () => {
	const { rec, sender } = makeSender();
	let request = sender.prepare("oc_1", "最终答案", { editMessageId: "om_live", replyTo: "om_user" })[0];
	assert.ok(request);
	let result = await sender.sendPrepared(request);
	assert.equal(result.success, true);
	assert.equal(rec.calls[0].method, "PUT");
	assert.equal(rec.calls[0].url, "/open-apis/im/v1/messages/om_live");

	rec.calls.length = 0;
	rec.replies = [{ code: 230003, msg: "message not found" }, { code: 0, data: { message_id: "om_new" } }];
	request = sender.prepare("oc_1", "最终答案", { editMessageId: "om_gone", replyTo: "om_user" })[0];
	assert.ok(request);
	result = await sender.sendPrepared(request);
	assert.equal(result.success, true);
	assert.equal(result.fallback, true);
	assert.deepEqual(rec.calls.map((call) => call.method), ["PUT", "POST"]);
	assert.equal(rec.calls[1].url, "/open-apis/im/v1/messages/om_user/reply");
	assert.equal((rec.calls[1].data as { uuid: string }).uuid, request.routeFallbackUuid);
});

test("sender：MP4/Opus 使用原生上传与消息类型", async () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-sender-av-"));
	try {
		const video = join(dir, "v.mp4");
		const audio = join(dir, "a.opus");
		writeFileSync(video, Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]));
		writeFileSync(audio, Buffer.from("OggSvoice"));
		const { rec, sender } = makeSender();
		await sender.sendPrepared(sender.prepareMedia("oc", validateLocalArtifact(video, dir)));
		await sender.sendPrepared(sender.prepareMedia("oc", validateLocalArtifact(audio, dir)));
		assert.deepEqual(rec.uploadFileTypes, ["mp4", "opus"]);
		assert.deepEqual(rec.calls.map((call) => (call.data as { msg_type: string }).msg_type), ["media", "audio"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sender：原生视频类型不支持时降级普通文件并持久化 checkpoint", async () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-sender-media-fallback-"));
	try {
		const video = join(dir, "v.mp4");
		writeFileSync(video, Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]));
		class UnsupportedNativeTransport extends RecordingTransport {
			override async uploadFile(_name: string, _buffer: Buffer, fileType = "stream"): Promise<string> {
				this.uploadFileTypes.push(fileType);
				if (fileType === "mp4") throw new Error("unsupported file_type mp4 (234006)");
				return "fallback-file-key";
			}
		}
		const rec = new UnsupportedNativeTransport();
		const sender = new Sender({ config: cfg(), transport: rec as unknown as FeishuTransport });
		const request = sender.prepareMedia("oc", validateLocalArtifact(video, dir));
		let checkpoint: { uploadKey?: string; uploadedAsFile?: boolean } = {};
		const result = await sender.sendPrepared(request, (patch) => { checkpoint = patch; });
		assert.equal(result.success, true);
		assert.deepEqual(rec.uploadFileTypes, ["mp4", "stream"]);
		assert.equal((rec.calls[0].data as { msg_type: string }).msg_type, "file");
		assert.deepEqual(checkpoint, { uploadKey: "fallback-file-key", uploadedAsFile: true });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sender：明确 403 为 fatal，不进入无意义重试", async () => {
	class ForbiddenTransport extends RecordingTransport {
		override async rawRequest(): Promise<unknown> {
			const error = new Error("forbidden") as Error & { response: { status: number; data: { code: number } } };
			error.response = { status: 403, data: { code: 403 } };
			throw error;
		}
	}
	const sender = new Sender({ config: cfg(), transport: new ForbiddenTransport() as unknown as FeishuTransport });
	const result = await sender.send("oc", "answer");
	assert.equal(result.success, false);
	assert.equal(result.retryable, false);
	assert.equal(result.errorCode, 403);
});

test("sender：空响应或缺少 message_id 不得标记发送成功", async () => {
	const { rec, sender } = makeSender();
	rec.replies = [{}, { code: 0 }];
	let result = await sender.send("oc", "empty");
	assert.equal(result.success, false);
	assert.equal(result.retryable, true);
	result = await sender.send("oc", "missing-id");
	assert.equal(result.success, false);
	assert.equal(result.retryable, true);
	assert.match(result.error ?? "", /missing message_id/);
});
