import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PendingStore } from "../src/session/pending-store.js";
import type { FeishuInboundMessage } from "../src/types.js";

function inbound(id: string, over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return {
		messageId: id,
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_sender",
		senderName: "用户",
		isBot: false,
		msgType: "text",
		text: "hello",
		mentions: [],
		resources: [],
		threadId: "om_thread",
		replyToMessageId: "om_parent",
		replyToText: "quoted",
		raw: { ignored: true },
		ts: 123,
		...over,
	};
}

test("PendingStore：完整记录跨重启恢复，ack 只删除目标记录", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-"));
	const file = join(dir, "pending.jsonl");
	try {
		const first = new PendingStore(file, { now: () => 1_000 });
		first.claim(inbound("m1"), "oc_group:t:om_thread");
		first.claim(inbound("m2", { chatType: "p2p", chatId: "oc_dm", senderId: "ou_dm", threadId: undefined }), "oc_dm");
		assert.equal(first.depth(), 2);

		const restarted = new PendingStore(file, { now: () => 1_100 });
		const recovered = restarted.recoverable();
		assert.equal(recovered.length, 2);
		assert.equal(recovered[0].conversationKey, "oc_group:t:om_thread");
		assert.equal(recovered[0].message.senderId, "ou_sender");
		assert.equal(recovered[0].message.replyToText, "quoted");
		assert.equal(recovered[0].attempts, 2);
		restarted.ack("m1");
		assert.equal(restarted.depth(), 1);

		const crashedAgain = new PendingStore(file, { now: () => 1_200 });
		assert.deepEqual(crashedAgain.recoverable().map((record) => record.id), ["m2"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PendingStore：损坏行不影响其他记录，快照保持可解析", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-corrupt-"));
	const file = join(dir, "pending.jsonl");
	try {
		const store = new PendingStore(file);
		store.claim(inbound("m1"), "lane");
		writeFileSync(file, `${readFileSync(file, "utf8")}{broken\n`, "utf8");
		const restarted = new PendingStore(file);
		assert.equal(restarted.depth(), 1);
		restarted.ack("m1");
		assert.equal(readFileSync(file, "utf8"), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("PendingStore：工具边界前持久标记 manual replay", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-pending-manual-"));
	const file = join(dir, "pending.jsonl");
	try {
		const store = new PendingStore(file);
		store.claim(inbound("manual"), "oc:u:ou");
		store.markManual("manual");
		const row = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(row.replayPolicy, "manual");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
