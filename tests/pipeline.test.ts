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
	return { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok", "bad", "good"], ...over };
}

const BATCH = { enabled: true, textWindowMs: 30, maxMessages: 8, maxChars: 4_000 };
const NO_BATCH = { ...BATCH, enabled: false, textWindowMs: 3000 };

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

test("TextBatcher：窗口内合并 / 不同 key 新开", () => {
	const b = new TextBatcher(1000);
	const mk = (chat: string, text: string): FeishuInboundMessage =>
		({ chatId: chat, chatType: "group", msgType: "text", text, messageId: Math.random().toString(), senderId: "u", isBot: false, mentions: [], resources: [], ts: Date.now(), raw: undefined }) as FeishuInboundMessage;
	assert.equal(b.offer("k1", mk("oc_1", "a")), false);
	assert.equal(b.offer("k1", mk("oc_1", "b")), true);
	assert.equal(b.offer("k2", mk("oc_2", "x")), false);
	const win1 = b.flush("k1");
	assert.ok(win1);
	assert.deepEqual(win1.parts, ["a", "b"]);
	const win2 = b.flush("k2");
	assert.deepEqual(win2?.parts, ["x"]);
});

test("非 text 消息不进批处理", () => {
	const b = new TextBatcher(1000);
	const img = { chatId: "oc_1", chatType: "group", msgType: "image", text: "", messageId: "m", senderId: "u", mentions: [], ts: Date.now(), raw: undefined } as unknown as FeishuInboundMessage;
	assert.equal(b.offer("k1", img), false);
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
		resources: [],
		ts: Date.now(),
		raw: undefined,
		...over,
	};
}

test("全链路：@ 消息 dispatch（含回复原文拉取）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const transport = new FakeTransport() as unknown as FeishuTransport;
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: NO_BATCH }),
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
		config: cfg({ groupPolicy: "mention", batch: NO_BATCH }),
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
		config: cfg({ groupPolicy: "open", batch: NO_BATCH, implicitAdmins: ["ou_user"] }),
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
		config: cfg({ groupPolicy: "open", requireMention: false, batch: BATCH }),
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

test("全链路：批处理开启时群非文本消息立即 dispatch", async () => {
	for (const msgType of ["image", "post", "file"] as const) {
		const dispatched: FeishuInboundMessage[] = [];
		const pipeline = new InboundPipeline({
			config: cfg({ groupPolicy: "open", requireMention: false, batch: BATCH }),
			transport: {} as FeishuTransport,
			lastSent: new LastSentCache(8),
			onDispatch: async (m) => { dispatched.push(m); },
		});
		await pipeline.handle(fakeMsg({ messageId: `om_${msgType}`, msgType, text: `[${msgType}]` }));
		assert.equal(dispatched.length, 1, `${msgType} 不应被 text batch 吞掉`);
		await pipeline.stop();
	}
});

test("全链路：同群不同用户不合并", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", requireMention: false, groupSessionsPerUser: true, batch: BATCH }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ messageId: "om_u1", senderId: "ou_a", text: "A" }));
	await pipeline.handle(fakeMsg({ messageId: "om_u2", senderId: "ou_b", text: "B" }));
	await pipeline.stop();
	assert.deepEqual(dispatched.map((m) => m.text), ["A", "B"]);
});

test("全链路：同会话不同回复目标不合并且保持顺序", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const transport = new FakeTransport() as unknown as FeishuTransport;
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", requireMention: false, batch: BATCH }),
		transport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ messageId: "om_r1", text: "R1", replyToMessageId: "om_p1" }));
	await pipeline.handle(fakeMsg({ messageId: "om_r2", text: "R2", replyToMessageId: "om_p2" }));
	await pipeline.stop();
	assert.deepEqual(dispatched.map((m) => [m.text, m.replyToMessageId]), [["R1", "om_p1"], ["R2", "om_p2"]]);
});

test("全链路：达到 maxMessages 时先 flush，stop 再 flush 剩余窗口", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({
			groupPolicy: "open",
			requireMention: false,
			batch: { enabled: true, textWindowMs: 10_000, maxMessages: 2, maxChars: 100 },
		}),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ messageId: "om_1", text: "1" }));
	await pipeline.handle(fakeMsg({ messageId: "om_2", text: "2" }));
	await pipeline.handle(fakeMsg({ messageId: "om_3", text: "3" }));
	assert.deepEqual(dispatched.map((m) => m.text), ["1\n2"]);
	await pipeline.stop();
	assert.deepEqual(dispatched.map((m) => m.text), ["1\n2", "3"]);
});

test("全链路：达到 maxChars 前先 flush，主聊天与话题窗口隔离", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", requireMention: false, groupSessionsPerUser: false, batch: { ...BATCH, maxChars: 5 } }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (msg) => { dispatched.push(msg); },
	});
	await pipeline.handle(fakeMsg({ messageId: "chars-1", text: "1234", mentions: [{ isSelf: true }] }));
	await pipeline.handle(fakeMsg({ messageId: "chars-2", text: "56", mentions: [{ isSelf: true }] }));
	await pipeline.handle(fakeMsg({ messageId: "topic-1", text: "T", chatType: "topic", threadId: "thread-1", mentions: [{ isSelf: true }] }));
	await pipeline.stop();
	assert.deepEqual(dispatched.map((msg) => msg.text), ["1234", "56", "T"]);
	assert.equal(dispatched[2].threadId, "thread-1");
});

test("全链路：回复 bot 上一条消息免 @ 放行（B1 场景）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const lastSent = new LastSentCache(8);
	lastSent.record("om_bot_last");
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", groupAlsoOnReply: true, batch: NO_BATCH }),
		transport: new FakeTransport() as unknown as FeishuTransport,
		lastSent,
		onDispatch: async (m) => { dispatched.push(m); },
	});
	const msg = fakeMsg({ text: "回复的内容", replyToMessageId: "om_bot_last" });
	await pipeline.handle(msg);
	assert.equal(dispatched.length, 1);
});

test("全链路：@_all 默认被过滤（不唤醒 agent）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: NO_BATCH }), // ignoreAtAll 默认 true
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ text: "@_all 大家好" }));
	assert.equal(dispatched.length, 0, "@所有人 默认必须被过滤");
});

test("全链路：ignoreAtAll=false 时 @_all 放行（可配置）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: NO_BATCH, ignoreAtAll: false }),
		transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onDispatch: async (m) => { dispatched.push(m); },
	});
	await pipeline.handle(fakeMsg({ text: "@_all 大家好" }));
	assert.equal(dispatched.length, 1, "显式关闭过滤后应放行");
});

test("全链路：@all 默认被过滤（占位解析后同样不唤醒）", async () => {
	const dispatched: FeishuInboundMessage[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "mention", batch: NO_BATCH }), transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8), onDispatch: async (msg) => { dispatched.push(msg); },
	});
	await pipeline.handle(fakeMsg({ text: "@all 大家好", mentions: [] }));
	assert.equal(dispatched.length, 0, "@all 默认必须被过滤");
});

test("入站命令：显式消费且不进入 batch/Agent，未知斜杠命令仍正常 dispatch", async () => {
	const commands: string[] = [];
	const dispatched: string[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", batch: NO_BATCH, implicitAdmins: ["ou_user"] }), transport: {} as FeishuTransport,
		lastSent: new LastSentCache(8),
		onCommand: async (msg) => { commands.push(msg.text); return msg.text === "/feishu status"; },
		onDispatch: async (msg) => { dispatched.push(msg.text); },
	});
	await pipeline.handle(fakeMsg({ messageId: "cmd-1", chatType: "p2p", text: "/feishu status" }));
	await pipeline.handle(fakeMsg({ messageId: "cmd-2", chatType: "p2p", text: "/skill:test" }));
	assert.deepEqual(commands, ["/feishu status", "/skill:test"]);
	assert.deepEqual(dispatched, ["/skill:test"]);
});

test("pipeline stop：一个窗口失败不阻止其他窗口 flush", async () => {
	const dispatched: string[] = [];
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", requireMention: false, batch: { ...BATCH, textWindowMs: 60_000 } }),
		transport: {} as FeishuTransport, lastSent: new LastSentCache(8),
		onDispatch: async (msg) => { if (msg.chatId === "bad") throw new Error("bad window"); dispatched.push(msg.chatId); },
	});
	await pipeline.handle(fakeMsg({ messageId: "stop-bad", chatId: "bad" }));
	await pipeline.handle(fakeMsg({ messageId: "stop-good", chatId: "good" }));
	await assert.rejects(() => pipeline.stop(), /failed to flush/);
	assert.deepEqual(dispatched, ["good"]);
});

test("pipeline stop：等待正在解析引用的消息并在返回前完成 dispatch", async () => {
	let releaseQuote: (() => void) | undefined;
	const dispatched: FeishuInboundMessage[] = [];
	const transport = {
		async getMessageText() {
			await new Promise<void>((resolve) => { releaseQuote = resolve; });
			return "迟到引用";
		},
	} as unknown as FeishuTransport;
	const pipeline = new InboundPipeline({
		config: cfg({ groupPolicy: "open", requireMention: false, batch: BATCH }),
		transport,
		lastSent: new LastSentCache(8),
		onDispatch: async (msg) => { dispatched.push(msg); },
	});
	const handling = pipeline.handle(fakeMsg({ messageId: "late-quote", replyToMessageId: "parent", mentions: [{ isSelf: true }] }));
	await new Promise((resolve) => setImmediate(resolve));
	const stopping = pipeline.stop();
	releaseQuote?.();
	await Promise.all([handling, stopping]);
	assert.equal(dispatched.length, 1);
	assert.equal(dispatched[0].replyToText, "迟到引用");
	await pipeline.handle(fakeMsg({ messageId: "after-stop" }));
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

test("进度消息：发送→工具事件更新→完成撤回（方案 A）", async () => {
	const { ConversationManager } = await import("../src/session/conversation-manager.js");
	const sent: string[] = [];
	const edited: string[] = [];
	const recalled: string[] = [];
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const mgr = new ConversationManager({
		config: cfg({ groupPolicy: "open" }),
		sessionDir: "/tmp/feishu-test-progress",
		sessionBackend: {
			async createSession(opts: { sessionFile?: string }) {
				return {
					sessionId: "sid1",
					async prompt() { await sleep(3000); return "final-reply"; },
					subscribe: () => () => {},
					modelId: "m",
				};
			},
		},
		sender: {
			async send(_chat: string, text: string) { sent.push(text); return { success: true, messageId: `om_prog_${sent.length}` }; },
		},
		editMessage: async (_id: string, text: string) => { edited.push(text); return true; },
		recallMessage: async (id: string) => { recalled.push(id); return true; },
	} as never);
	await mgr.route({ messageId: "m1", chatId: "oc_g", chatType: "group", senderId: "u", isBot: false, msgType: "text", text: "hi", mentions: [], ts: Date.now(), raw: undefined } as never);
	await sleep(150);
	// 处理中：工具事件 → 进度消息更新
	mgr.onToolEvent("sid1", "bash", "start");
	await sleep(1700); // 节流 1.5s
	mgr.onToolEvent("sid1", "bash", "end");
	assert.ok(edited.length >= 1, "工具事件应触发进度消息编辑");
	assert.match(edited[0], /🔧/);
	await sleep(1800); // prompt resolve → sendReply → 撤回进度消息
	assert.equal(sent[0], "🤖 正在处理…");
	assert.ok(recalled.length >= 1, "完成后应撤回进度消息");
	assert.match(sent.join(" "), /final-reply/);
});
