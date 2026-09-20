/**
 * normalize 单元测试：文本/富文本/合并转发/提及判定（含 @_all、ID 优先、name 兜底）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFeishuMessage, buildMentionsMap, mentionsBot, stripEdgeSelfMentions, renderPostElements } from "../src/inbound/normalize.js";

const BOT = { openId: "ou_bot_123", name: "小助手" };

function base(over: Record<string, unknown> = {}) {
	return {
		messageId: "om_1",
		chatId: "oc_1",
		chatType: "group",
		messageType: "text",
		content: '{"text":"hello"}',
		sender: { sender_id: { open_id: "ou_user_1" }, sender_type: "user" },
		bot: BOT,
		...over,
	} as never;
}

test("text 消息规范化", () => {
	const msg = normalizeFeishuMessage(base({ content: '{"text":"你好"}' }));
	assert.equal(msg.text, "你好");
	assert.equal(msg.msgType, "text");
	assert.equal(msg.chatType, "group");
	assert.equal(msg.senderId, "ou_user_1");
});

test("p2p 与 sender_type=app", () => {
	const msg = normalizeFeishuMessage(base({ chatType: "p2p", sender: { sender_id: { open_id: "ou_bot_2" }, sender_type: "app" } }));
	assert.equal(msg.chatType, "p2p");
	assert.equal(msg.isBot, true);
});

test("post 富文本 → markdown", () => {
	const content = JSON.stringify({ content: [[{ tag: "text", text: "第一行" }, { tag: "a", text: "链接", href: "https://x.com" }], [{ tag: "text", text: "**粗体**", style: ["bold"] }]] });
	const msg = normalizeFeishuMessage(base({ messageType: "post", content }));
	assert.equal(msg.msgType, "post");
	assert.match(msg.text, /第一行/);
	assert.match(msg.text, /链接/);
	assert.match(msg.text, /\*\*粗体\*\*/);
});

test("媒体消息生成结构化 ResourceRef，不伪造可访问 URL", () => {
	const image = normalizeFeishuMessage(base({ messageId: "om_img", messageType: "image", content: '{"image_key":"img_key"}' }));
	assert.deepEqual(image.resources, [{ kind: "image", key: "img_key", messageId: "om_img" }]);
	assert.equal(image.text, "[图片附件]");
	assert.doesNotMatch(image.text, /image_key:|file:\/\//);

	const file = normalizeFeishuMessage(base({ messageId: "om_file", messageType: "file", content: '{"file_key":"file_key","file_name":"report.txt"}' }));
	assert.deepEqual(file.resources, [{ kind: "file", key: "file_key", messageId: "om_file", name: "report.txt" }]);

	const post = normalizeFeishuMessage(base({
		messageId: "om_post_media",
		messageType: "post",
		content: JSON.stringify({ content: [[{ tag: "img", image_key: "post_img" }, { tag: "file", file_key: "post_file" }]] }),
	}));
	assert.deepEqual(post.resources, [
		{ kind: "image", key: "post_img", messageId: "om_post_media" },
		{ kind: "file", key: "post_file", messageId: "om_post_media" },
	]);
	assert.doesNotMatch(post.text, /post_img|post_file|file:\/\//);
});

test("文件消息保留声明大小与 MIME，post @_all 正规化", () => {
	const file = normalizeFeishuMessage(base({
		messageType: "file",
		content: JSON.stringify({ file_key: "fk", file_name: "a.txt", file_size: 12, mime_type: "text/plain" }),
	}));
	assert.deepEqual(file.resources, [{ kind: "file", key: "fk", messageId: "om_1", name: "a.txt", mimeType: "text/plain", size: 12 }]);
	const post = normalizeFeishuMessage(base({
		messageType: "post",
		content: JSON.stringify({ content: [[{ tag: "at", user_id: "@_all" }, { tag: "text", text: " 大家" }]] }),
	}));
	assert.equal(post.text, "@all 大家");
});

test("code_block 渲染", () => {
	const out = renderPostElements({ content: [[{ tag: "code_block", language: "ts", lines: ["const a = 1;", "console.log(a)"] }]] });
	assert.match(out, /```ts/);
	assert.match(out, /const a = 1;/);
});

test("merge_forward 合并转发展开", () => {
	const content = JSON.stringify({
		items: [
			{ name: "张三", msg_type: "text", content: '{"text":"第一条"}' },
			{ name: "李四", msg_type: "text", content: '{"text":"第二条"}' },
		],
	});
	const msg = normalizeFeishuMessage(base({ messageType: "merge_forward", content }));
	assert.equal(msg.msgType, "merge_forward");
	assert.match(msg.text, /张三/);
	assert.match(msg.text, /第一条/);
	assert.match(msg.text, /李四/);
	assert.match(msg.text, /第二条/);
});

test("reply 链路字段解析（parent_id 优先）", () => {
	const msg = normalizeFeishuMessage(base({ parentId: "om_parent", upperMessageId: "om_upper", rootId: "om_root", threadId: "om_thread" }));
	assert.equal(msg.replyToMessageId, "om_parent");
	assert.equal(msg.threadId, "om_thread");
});

test("mention ID 匹配（open_id）", () => {
	const mentions = buildMentionsMap([{ id: { open_id: "ou_bot_123" }, name: "小助手" }], BOT);
	assert.equal(mentions[0].isSelf, true);
});

test("mention ID 不匹配时不允许 name 翻案（Hermes ID 优先）", () => {
	const mentions = buildMentionsMap([{ id: { open_id: "ou_other" }, name: "小助手" }], BOT);
	assert.equal(mentions[0].isSelf, false);
});

test("mention 缺 ID → name 兜底命中", () => {
	const mentions = buildMentionsMap([{ name: "小助手" }], BOT);
	assert.equal(mentions[0].isSelf, true);
});

test("mention user_id 匹配", () => {
	const mentions = buildMentionsMap([{ id: { user_id: "user_bot_9" } }], { userId: "user_bot_9" });
	assert.equal(mentions[0].isSelf, true);
});

test("@_all 视为提及", () => {
	assert.equal(mentionsBot('{"@_all"}', []), true);
	assert.equal(mentionsBot("hi", []), false);
	assert.equal(mentionsBot("hi", [{ isSelf: true }]), true);
});

test("stripEdgeSelfMentions 剥离开头 @", () => {
	const text = "@小助手 查一下天气";
	const out = stripEdgeSelfMentions(text, [{ isSelf: true, name: "小助手" }]);
	assert.equal(out, "查一下天气");
});

test("@_user_N 占位剥离（转发消息场景）", () => {
	const out = stripEdgeSelfMentions("@_user_123 内容", []);
	assert.equal(out, "内容");
});

test("share_chat 共享名片", () => {
	const msg = normalizeFeishuMessage(base({ messageType: "share_chat", content: '{"chat_name":"测试群"}' }));
	assert.match(msg.text, /测试群/);
});

test("unknown 类型不崩", () => {
	const msg = normalizeFeishuMessage(base({ messageType: "系统", content: "" }));
	assert.equal(msg.msgType, "unknown");
});

test("mention 占位符 → 真实名（hermes _render_post_element 对齐）", async () => {
	const bot = { openId: "ou_bot", userId: "", name: "飞书 CLI" };
	// 文本消息：@_user_2 替换为真实名
	const msg = normalizeFeishuMessage({
		messageId: "m1", chatId: "oc_g", chatType: "group",
		messageType: "text", content: JSON.stringify({ text: "@_user_2 帮我看看" }),
		mentions: [
			{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "飞书 CLI" },
			{ key: "@_user_2", id: { open_id: "ou_zhang" }, name: "张三" },
		],
		sender: { sender_id: { open_id: "ou_li" }, sender_name: "李四" },
		bot,
	});
	assert.equal(msg.text, "@张三 帮我看看"); // @_user_2 → 真实名（非自身，保留）
	// 直接测 resolveMentionPlaceholders
	const { resolveMentionPlaceholders } = await import("../src/inbound/normalize.js");
	assert.equal(
		resolveMentionPlaceholders("给 @_user_2 说 @_user_3 好", [
			{ key: "@_user_2", id: { open_id: "ou_zhang" }, name: "张三", isSelf: false },
			{ key: "@_user_3", id: { open_id: "ou_wang" }, name: "王五", isSelf: false },
		]),
		"给 @张三 说 @王五 好",
	);
	// 查不到 → @user；@_all → @all
	assert.equal(resolveMentionPlaceholders("@_user_9 @_all", []), "@user @all");
	// post 渲染：<at> 直接输出占位符再由 resolver 替换（不再拼 @_user_ 前缀）
	const { renderTextElement } = await import("../src/inbound/normalize.js");
	assert.equal(renderTextElement({ tag: "at", user_id: "@_user_2" }), "@_user_2");
});

// ── 前导空白导致的「命令失效」回归（本轮真 bug）──────────────────────────
// 现象：用户在群里发 `/thinking high --global`，桥却弹了审批。
// 根因：飞书送来的文本以空白开头（用户在 @ 前敲了空格），而剥离 mention 的正则
// 锚在行首 —— 匹配不上 → mention 留在文本里 → 这条消息不再被识别为命令
// （normalized 变成 "@机器人名"）→ 命令被当成普通问题丢给模型 → 模型执行 env 探索。

test("stripEdgeSelfMentions：前导空白不该让剥离失效（@_user_N 形式）", () => {
	const withSpace = stripEdgeSelfMentions(" @_user_1 /thinking high --global", [{ isSelf: true, name: "小助手" }]);
	assert.equal(withSpace, "/thinking high --global", "有前导空格也必须剥干净，否则命令识别不了");
	const noSpace = stripEdgeSelfMentions("@_user_1 /thinking high --global", [{ isSelf: true, name: "小助手" }]);
	assert.equal(noSpace, "/thinking high --global");
});

test("stripEdgeSelfMentions：前导空白 + 按名字剥离也要生效", () => {
	const refs = [{ isSelf: true, name: "CY智能助手" }];
	assert.equal(stripEdgeSelfMentions("  @CY智能助手 /models", refs), "/models");
	assert.equal(stripEdgeSelfMentions("@CY智能助手 /models", refs), "/models");
});

test("剥离后必须能通过命令判定（trim 后以 / 开头）", () => {
	const refs = [{ isSelf: true, name: "小助手" }];
	for (const raw of [" @_user_1 /model -g", " @_user_1 /thinking", "\t@_user_1 /stop"]) {
		const stripped = stripEdgeSelfMentions(raw, refs);
		assert.ok(stripped.startsWith("/"), `剥离后应以 / 开头，实际=${JSON.stringify(stripped)}`);
	}
});
