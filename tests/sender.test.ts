/**
 * sender 单元测试：chunking、markdown→post、reply 回退、降级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateMessage, buildMarkdownPostPayload, stripMarkdownToPlainText } from "../src/outbound/sender.js";
import { Sender } from "../src/outbound/sender.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";
import type { FeishuTransport } from "../src/inbound/transport.js";

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
