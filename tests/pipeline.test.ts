/**
 * pipeline 全链路 + 工具类测试：dedup / batch / 回复原文拉取 / 准入 → dispatch。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DedupCache, TextBatcher } from "../src/inbound/pipeline-utils.js";
import { InboundPipeline } from "../src/inbound/pipeline.js";
import { LastSentCache } from "../src/inbound/admit.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage } from "../src/types.js";
import type { FeishuTransport } from "../src/inbound/transport.js";

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, ...over };
}

test("DedupCache：重复拒绝", () => {
	const d = new DedupCache(16);
	assert.equal(d.check("m1"), true);
	assert.equal(d.check("m1"), false);
	assert.equal(d.check("m2"), true);
});

test("DedupCache：容量淘汰最旧", () => {
	const d = new DedupCache(2);
	assert.equal(d.check("a"), true);
	assert.equal(d.check("b"), true);
	assert.equal(d.check("c"), true); // 触发淘汰：删 a
	assert.equal(d.check("b"), false); // b 仍在
	assert.equal(d.check("c"), false);
	assert.equal(d.check("a"), true); // a 已被淘汰，重新接受
});

test("TextBatcher：窗口内合并 / 窗口外新开", () => {
	const b = new TextBatcher(1000);
	const mk = (chat: string, text: string): FeishuInboundMessage =>
		({ chatId: chat, chatType: "group", msgType: "text", text, messageId: Math.random().toString(), senderId: "u", isBot: false, mentions: [], ts: Date.now(), raw: undefined }) as FeishuInboundMessage;
	assert.equal(b.offer(mk("oc_1", "a")), false);
	assert.equal(b.offer(mk("oc_1", "b")), true);
	assert.equal(b.offer(mk("oc_2", "x")), false);
	const win1 = b.flush("oc_1");
	assert.ok(win1);
	assert.deepEqual(win1.parts, ["a", "b"]);
	const win2 = b.flush("oc_2");
	assert.deepEqual(win2?.parts, ["x"]);
});

test("非 text 消息不进批处理", () => {
	const b = new TextBatcher(1000);
	const img = { chatId: "oc_1", chatType: "group", msgType: "image", text: "", messageId: "m", senderId: "u", mentions: [], ts: Date.now(), raw: undefined } as unknown as FeishuInboundMessage;
	assert.equal(b.offer(img), false);
});

// ------------------------------------------------------------ 全链路 ----

class FakeTransport {
	queue: Array<{ url: string; method: string; data?: unknown }> = [];
	quotedText: string | undefined;
	async getMessageText(id: string): Promise<string | undefined> {
		return this.quotedText ?? "被回复原文";
	}
	async rawRequest(opts: { url: string; method: string; data?: unknown }): Promise<unknown> {
		this.queue.push(opts);
		return { code: 0, data: { message_id: "om_new" } };
	}
	async authedRequest(opts: { url: string; method: string }): Promise<unknown> {
		return { bot: { open_id: "ou_bot_123", bot_name: "小助手" } };
	}
}

function fakeMsg(over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return {
		messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_user",
		isBot: false,
		msgType: "text",
		text: "hi",
		mentions: [],
		ts: Date.now(),
		raw: undefined,
		...over,
	};
}

test("全链路：@ 消息 dispatch（含回复原文拉取）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const transport = new FakeTransport() as unknown as FeishuTransport;
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: { enabled: false, textWindowMs: 3000 } }),
		transport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});

	const msg = fakeMsg({ text: "你好", mentions: [{ isSelf: true }], replyToMessageId: "om_parent" });
	await pipeline.handle(msg);
	assert.equal(dispatched.length, 1);
	assert.equal(dispatched[0].text, "你好");
	assert.equal(dispatched[0].replyToText, "被回复原文"); // B1：原文拉取
});

test("全链路：未 @ 群消息丢弃（mention 策略）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: { enabled: false, textWindowMs: 3000 } }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ text: "没 @ 的消息" }));
	assert.equal(dispatched.length, 0);
	assert.equal(pipeline.getStats().dropped, 1);
});

test("全链路：重复 message_id 只 dispatch 一次", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", batch: { enabled: false, textWindowMs: 3000 } }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	const msg = fakeMsg({ messageId: "om_same", mentions: [{ isSelf: true }] });
	await pipeline.handle(msg);
	await pipeline.handle(msg);
	assert.equal(dispatched.length, 1);
	assert.equal(pipeline.getStats().duplicate, 1);
});

test("全链路：群批量合并后再 dispatch", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", batch: { enabled: true, textWindowMs: 30 } }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ messageId: "om_b1", text: "第一条" }));
	await pipeline.handle(fakeMsg({ messageId: "om_b2", text: "第二条" }));
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(dispatched.length, 1);
	assert.equal(dispatched[0].text, "第一条\n第二条");
});

test("全链路：回复 bot 上一条消息免 @ 放行（B1 场景）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const lastSent = new LastSentCache(8);
	lastSent.record("om_bot_last");
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", groupAlsoOnReply: true, batch: { enabled: false, textWindowMs: 3000 } }),
		transport: new FakeTransport() as unknown as FeishuTransport,
		lastSent,
		onDispatch: async (m) => { dispatched.push(m); },
	});
	const msg = fakeMsg({ text: "回复的内容", replyToMessageId: "om_bot_last" });
	await pipeline.handle(msg);
	assert.equal(dispatched.length, 1);
});

test("全链路：@_all 放行", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: { enabled: false, textWindowMs: 3000 } }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ text: "@_all 大家好" }));
	assert.equal(dispatched.length, 1);
});

test("stripInjectedPrompt：剥离复述的 hermes 式回复注入", async () => {
	const { stripInjectedPrompt } = await import("../src/session/conversation-manager.js");
	const quoteBlock = "[正在回复的消息原文：\"@ 测试\"]\n\n你好呀";
	const out = stripInjectedPrompt("[正在回复的消息原文：\"@ 测试\"]\n\n好的！", quoteBlock);
	assert.ok(!out.includes("正在回复的消息原文"));
	assert.equal(out, "好的！");
});

test("会话隔离：话题消息独立会话 key（hermes thread_id 参与 key）", async () => {
	// 通过 ConversationManager 验证：话题消息与普通消息不同会话文件
	const { ConversationManager } = await import("../src/session/conversation-manager.js");
	const sessionFiles: string[] = [];
	const sentTo: Array<{ chat: string; thread?: string }> = [];
	const mgr = new ConversationManager({
		config: cfg({ groupPolicy: "open" }),
		sessionDir: "/tmp/feishu-test-sessions",
		sessionBackend: {
			async createSession(opts: { sessionFile?: string }) {
				sessionFiles.push(opts.sessionFile ?? "");
				return {
					sessionId: "s",
					async prompt() { return undefined; },
					subscribe() { return () => {}; },
					modelId: "m",
				};
			},
		},
		sender: {
			async send(chat: string, _text: string, opts?: { threadId?: string }) { sentTo.push({ chat, thread: opts?.threadId }); return { success: true }; },
		} as never,
	} as never);
	const base = { messageId: "m1", chatId: "oc_g", chatType: "group" as const, senderId: "u", isBot: false, msgType: "text" as const, text: "hi", mentions: [], ts: Date.now(), raw: undefined };
	await mgr.route({ ...base, messageId: "m1" } as never);
	await mgr.route({ ...base, messageId: "m2", threadId: "om_t1", chatType: "topic" } as never);
	// 两个不同 key → 两个 sessionFile；话题文件含 t 标记
	assert.equal(sessionFiles.length, 2);
	assert.ok(sessionFiles[0] !== sessionFiles[1]);
	assert.match(sessionFiles[1], /oc_g_t_om_t1/);
});

test("会话隔离：群内按用户隔离 + 话题内共享（hermes 模型）", async () => {
	const { ConversationManager } = await import("../src/session/conversation-manager.js");
	const sessionFiles: string[] = [];
	const mgr = new ConversationManager({
		config: cfg({ groupPolicy: "open" }),
		sessionDir: "/tmp/feishu-test-sessions2",
		sessionBackend: {
			async createSession(opts: { sessionFile?: string }) {
				sessionFiles.push(opts.sessionFile ?? "");
				return {
					sessionId: "s",
					async prompt() { return undefined; },
					subscribe() { return () => {}; },
					modelId: "m",
				};
			},
		},
		sender: {
			async send(chat: string, _text: string, _opts?: unknown) { return { success: true }; },
		},
	} as never);
	const mk = (over: Record<string, unknown> = {}) => ({ messageId: `m${Math.random().toString(36).slice(2, 8)}`, chatId: "oc_g", chatType: "group", senderId: "ou_a", isBot: false, msgType: "text", text: "hi", mentions: [], ts: Date.now(), raw: undefined, ...over }) as never;
	// A 主聊天 → 会话1（含 ou_a）
	await mgr.route(mk({ senderId: "ou_a" }));
	// B 主聊天新消息 → 会话2（含 ou_b）
	await mgr.route(mk({ senderId: "ou_b" }));
	// 话题 S1：A 和 B 回复同一话题 → 同一会话3（共享话题）
	await mgr.route(mk({ senderId: "ou_a", threadId: "om_t9", chatType: "topic" }));
	await mgr.route(mk({ senderId: "ou_b", threadId: "om_t9", chatType: "topic" }));
	assert.equal(sessionFiles.length, 3);
	assert.match(sessionFiles[0], /oc_g_u_ou_a/);
	assert.match(sessionFiles[1], /oc_g_u_ou_b/);
	assert.ok(sessionFiles[0] !== sessionFiles[1]);
	// A/B 话题消息共享同一会话文件
	assert.equal(sessionFiles[2], sessionFiles[3] ?? sessionFiles[2]);
});
