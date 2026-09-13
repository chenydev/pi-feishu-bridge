import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queueLocalFile, type LocalFileOutbox } from "../src/outbound/local-file-tool.js";
import type { ValidatedArtifact } from "../src/outbound/artifact.js";

test("本地文件工具：绑定活动会话、复制 spool、媒体与 caption 同 lane 排队", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "feishu-tool-cwd-"));
	const homeDir = mkdtempSync(join(tmpdir(), "feishu-tool-home-"));
	const media: Array<{ artifact: ValidatedArtifact; opts: unknown; meta: unknown }> = [];
	const texts: Array<{ text: string; meta: unknown }> = [];
	try {
		writeFileSync(join(cwd, "report.txt"), "report");
		const dedupe = new Set<string>();
		const outbox: LocalFileOutbox = {
			hasDedupeKey: (key) => dedupe.has(key),
			enqueueMedia: (_chatId, artifact, opts, meta) => { dedupe.add(meta.dedupeKey); media.push({ artifact, opts, meta }); return "m"; },
			enqueue: (_chatId, text, _opts, meta) => { texts.push({ text, meta }); return ["t"]; },
		};
		const route = { conversationKey: "oc:u:ou", chatId: "oc", threadId: "ot", sourceMessageId: "om" };
		const result = await queueLocalFile({ toolCallId: "tc1", path: "report.txt", caption: "说明", cwd, homeDir, route, outbox });
		assert.equal(result.isError, undefined);
		assert.equal(media.length, 1);
		assert.notEqual(media[0].artifact.localPath, join(cwd, "report.txt"));
		assert.equal(existsSync(media[0].artifact.localPath), true);
		assert.equal(statSync(media[0].artifact.localPath).mode & 0o777, 0o600);
		assert.deepEqual(media[0].opts, { replyTo: "om", threadId: "ot" });
		assert.deepEqual(texts, [{ text: "说明", meta: { dedupeKey: "tc1:caption", laneKey: "oc:u:ou", kind: "notify" } }]);
		const duplicate = await queueLocalFile({ toolCallId: "tc1", path: "report.txt", caption: "说明", cwd, homeDir, route, outbox });
		assert.match(duplicate.content[0].text, /无需重复/);
		assert.equal(media.length, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
	}
});

test("本地文件工具：非飞书活动会话 fail closed", async () => {
	const result = await queueLocalFile({ toolCallId: "tc", path: "x", caption: "", cwd: "/tmp", homeDir: "/tmp" });
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /不是由飞书消息触发/);
});
