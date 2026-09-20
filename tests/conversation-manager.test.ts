import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationManager, sanitizeCommand } from "../src/session/conversation-manager.js";
import { PendingStore } from "../src/session/pending-store.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"],
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		...over,
	};
}

function message(messageId: string): FeishuInboundMessage {
	return {
		messageId,
		chatId: "oc_real_chat",
		chatType: "p2p",
		senderId: "ou_user",
		isBot: false,
		msgType: "text",
		text: `prompt-${messageId}`,
		mentions: [],
		resources: [],
		raw: undefined,
		ts: Date.now(),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

function sender(sent: Array<{ chatId: string; text: string }>) {
	return {
		async send(chatId: string, text: string) {
			sent.push({ chatId, text });
			return { success: true, messageId: `om_${sent.length}` };
		},
	};
}

test("会话运行成功后退订事件，保留可复用 session", async () => {
	let subscribed = 0;
	let unsubscribed = 0;
	let disposed = 0;
	const sent: Array<{ chatId: string; text: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-success",
				async prompt() { return "done"; },
				subscribe() {
					subscribed += 1;
					return () => { unsubscribed += 1; };
				},
				async abort() {},
				async dispose() { disposed += 1; },
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(),
		sessionDir: "/tmp/feishu-conversation-success",
		sessionBackend: backend,
		sender: sender(sent) as never,
	});

	await manager.route(message("m-success"));
	await waitUntil(() => sent.some((item) => item.text === "done"));
	await waitUntil(() => unsubscribed === 1);

	assert.equal(subscribed, 1);
	assert.equal(unsubscribed, 1);
	assert.equal(disposed, 0);
});

test("工具命令摘要脱敏并截断", () => {
	const sanitized = sanitizeCommand(`API_TOKEN=secret curl -H "Authorization: Bearer abc" --password hunter2 ${"x".repeat(300)}`);
	assert.doesNotMatch(sanitized, /secret|abc|hunter2/);
	assert.match(sanitized, /API_TOKEN=\*\*/);
	assert.ok(sanitized.length <= 180);
});

test("prompt 失败时释放 session、退订事件并移除处理中表情", async () => {
	let unsubscribed = 0;
	let disposed = 0;
	const removed: Array<{ messageId: string; reactionId: string }> = [];
	const sent: Array<{ chatId: string; text: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-error",
				async prompt() { throw new Error("model failed"); },
				subscribe() { return () => { unsubscribed += 1; }; },
				async abort() {},
				async dispose() { disposed += 1; },
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config({ reaction: { enabled: true, processingEmoji: "Typing" } }),
		sessionDir: "/tmp/feishu-conversation-error",
		sessionBackend: backend,
		sender: sender(sent) as never,
		reactions: {
			async add() { return "reaction-1"; },
			async remove(messageId, reactionId) {
				removed.push({ messageId, reactionId });
				return true;
			},
		},
	});

	await manager.route(message("m-error"));
	await waitUntil(() => sent.some((item) => item.text.includes("model failed")));
	await waitUntil(() => removed.length === 1);

	assert.equal(disposed, 1);
	assert.equal(unsubscribed, 1);
	assert.deepEqual(removed, [{ messageId: "m-error", reactionId: "reaction-1" }]);
});

test("运行超时会 abort 并 dispose，下一条消息新建 session", async () => {
	let created = 0;
	let aborted = 0;
	let disposed = 0;
	let unsubscribed = 0;
	const sent: Array<{ chatId: string; text: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			created += 1;
			const ordinal = created;
			return {
				sessionId: `sid-${ordinal}`,
				prompt: ordinal === 1
					? async () => new Promise<never>(() => {})
					: async () => "recovered",
				subscribe() { return () => { unsubscribed += 1; }; },
				async abort() { aborted += 1; },
				async dispose() { disposed += 1; },
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(),
		sessionDir: "/tmp/feishu-conversation-timeout",
		sessionBackend: backend,
		sender: sender(sent) as never,
		runIdleTimeoutMs: 15,
	});

	await manager.route(message("m-timeout"));
	await waitUntil(() => sent.some((item) => item.text.includes("没有新进展")));
	await waitUntil(() => disposed === 1 && unsubscribed === 1);
	await manager.route(message("m-next"));
	await waitUntil(() => sent.some((item) => item.text === "recovered"));

	assert.equal(created, 2);
	assert.equal(aborted, 1);
	assert.equal(disposed, 1);
	assert.equal(unsubscribed, 2);
	assert.ok(sent.every((item) => item.chatId === "oc_real_chat"));
});

test("最终回复只写入 durable outbox，进度消息保持易失", async () => {
	const volatile: Array<{ chatId: string; text: string }> = [];
	const durable: Array<{ chatId: string; text: string; meta: { dedupeKey: string; laneKey: string; kind: string } }> = [];
	const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-durable",
				async prompt() { return "durable-final"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(),
		sessionDir: "/tmp/feishu-conversation-durable",
		sessionBackend: backend,
		sender: sender(volatile) as never,
		durableOutbox: {
			enqueue(chatId, text, _opts, meta) {
				durable.push({ chatId, text, meta });
				return ["envelope-1"];
			},
		},
		log: (_level, messageText, meta) => logs.push({ message: messageText, meta: meta as Record<string, unknown> }),
	});

	await manager.route(message("m-durable"));
	await waitUntil(() => durable.length === 1);

	assert.deepEqual(volatile.map((item) => item.text), ["🤖 正在处理…"]);
	assert.deepEqual(durable, [{
		chatId: "oc_real_chat",
		text: "durable-final",
		meta: { dedupeKey: "m-durable:final", laneKey: "oc_real_chat", kind: "final" },
	}]);
	const delivered = logs.find((entry) => entry.message === "feishu.conv.reply_sent")?.meta;
	assert.equal(delivered?.messageId, "m-durable");
	assert.equal(delivered?.conversationKey, "oc_real_chat");
	assert.equal(typeof delivered?.runId, "string");
	assert.equal(delivered?.envelopeId, "envelope-1");
});

test("流式 delta 编辑进度消息，durable final 接管同一消息并最终对账", async () => {
	let listener: (event: unknown) => void = () => {};
	const edits: Array<{ messageId: string; text: string }> = [];
	const recalls: string[] = [];
	const durable: Array<{ text: string; opts: { editMessageId?: string } }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-stream",
				async prompt() {
					listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "流式" } });
					await new Promise((resolve) => setTimeout(resolve, 10));
					listener({ type: "message_end", message: { role: "assistant", id: "a1", content: [{ type: "text", text: "最终答案" }] } });
				},
				subscribe(fn) { listener = fn; return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-conversation-stream", sessionBackend: backend,
		sender: sender(sent) as never,
		editMessage: async (messageId, text) => { edits.push({ messageId, text }); return true; },
		recallMessage: async (messageId) => { recalls.push(messageId); return true; },
		durableOutbox: {
			enqueue(_chatId, text, opts) { durable.push({ text, opts }); return ["final"]; },
		},
	});
	await manager.route(message("m-stream"));
	await waitUntil(() => durable.length === 1);
	assert.deepEqual(edits, [{ messageId: "om_1", text: "流式" }]);
	assert.deepEqual(durable, [{ text: "最终答案", opts: { replyTo: "m-stream", threadId: undefined, editMessageId: "om_1" } }]);
	assert.deepEqual(recalls, []);
});

test("会话控制：model/compact 透传公开 API，/new 使用新 session 文件", async () => {
	const files: string[] = [];
	let model = "old";
	const backend: SessionBackend = {
		async createSession(opts) {
			files.push(opts.sessionFile ?? "");
			return {
				sessionId: `sid-${files.length}`, async prompt() { return "ok"; }, subscribe() { return () => {}; },
				async abort() {}, async dispose() {}, get modelId() { return model; },
				async compact(instructions) { return `compact:${instructions ?? ""}`; },
				async setModel(value) { model = value; return true; },
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-control", sessionBackend: backend, sender: sender(sent) as never });
	const msg = message("control-1");
	await manager.route(msg);
	await waitUntil(() => sent.some((entry) => entry.text === "ok"));
	assert.match(await manager.modelConversation(msg), /^当前模型：old/);
	assert.equal(await manager.modelConversation(msg, "new"), "已切换模型：new");
	assert.equal(await manager.compactConversation(msg, "keep facts"), "compact:keep facts");
	await manager.resetConversation(msg);
	await manager.route({ ...msg, messageId: "control-2" });
	await waitUntil(() => files.length === 2);
	assert.notEqual(files[0], files[1]);
});

test("首次使用 /model 会初始化会话并返回实际默认模型", async () => {
	let created = 0;
	const backend: SessionBackend = {
		async createSession() {
			created += 1;
			return {
				sessionId: "sid-model-lazy", async prompt() { return "ok"; }, subscribe() { return () => {}; },
				async abort() {}, async dispose() {}, modelId: "deepseek-v4-flash",
				async setModel() { return true; },
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-model-lazy", sessionBackend: backend, sender: sender(sent) as never });
	const msg = message("model-lazy");

	assert.match(await manager.modelConversation(msg), /^当前模型：deepseek-v4-flash/);
	assert.equal(created, 1);
	await manager.route({ ...msg, messageId: "model-lazy-prompt" });
	await waitUntil(() => sent.some((entry) => entry.text === "ok"));
	assert.equal(created, 1);
});

test("首次使用 /model <模型> 会初始化、校验并供后续消息复用", async () => {
	let created = 0;
	let model = "old";
	const backend: SessionBackend = {
		async createSession() {
			created += 1;
			return {
				sessionId: "sid-model-switch", async prompt() { return `using:${model}`; }, subscribe() { return () => {}; },
				async abort() {}, async dispose() {}, get modelId() { return model; },
				async setModel(value) {
					if (value === "missing") return false;
					model = value;
					return true;
				},
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-model-switch", sessionBackend: backend, sender: sender(sent) as never });
	const msg = message("model-switch");

	assert.equal(await manager.modelConversation(msg, "missing"), "找不到已认证模型：missing");
	assert.equal(await manager.modelConversation(msg, "new"), "已切换模型：new");
	await manager.route({ ...msg, messageId: "model-switch-prompt" });
	await waitUntil(() => sent.some((entry) => entry.text === "using:new"));
	assert.equal(created, 1);
});

test("shutdown：清空 waiting pumps，活动任务结束后不再启动排队会话", async () => {
	let rejectPrompt: (error: Error) => void = () => {};
	let created = 0;
	const backend: SessionBackend = {
		async createSession() {
			created += 1;
			return {
				sessionId: `sid-${created}`,
				prompt: async () => new Promise((_resolve, reject) => { rejectPrompt = reject; }),
				subscribe: () => () => {},
				async abort() { rejectPrompt(new Error("aborted")); }, async dispose() {}, modelId: "m",
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({ config: config({ maxActiveSessions: 1 }), sessionDir: "/tmp/feishu-shutdown-waiting", sessionBackend: backend, sender: sender(sent) as never });
	await manager.route(message("shutdown-active"));
	await waitUntil(() => created === 1);
	await manager.route({ ...message("shutdown-waiting"), chatId: "other-chat" });
	await manager.shutdown();
	assert.equal(created, 1);
	await assert.rejects(() => manager.route(message("after-shutdown")), /shutting down/);
});

test("连续 100 轮订阅数量稳定", async () => {
	let subscribed = 0;
	let unsubscribed = 0;
	const sent: Array<{ chatId: string; text: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-100",
				async prompt() { return "ok"; },
				subscribe() { subscribed += 1; return () => { unsubscribed += 1; }; },
				async abort() {},
				async dispose() {},
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(),
		sessionDir: "/tmp/feishu-conversation-100",
		sessionBackend: backend,
		sender: sender(sent) as never,
	});
	for (let index = 0; index < 100; index += 1) {
		await manager.route(message(`m-${index}`));
		await waitUntil(() => unsubscribed === index + 1);
	}
	assert.equal(subscribed, 100);
	assert.equal(unsubscribed, 100);
});

test("全局 active session 上限不阻塞不同 conversation 的后续调度", async () => {
	const started: string[] = [];
	const finish = new Map<string, () => void>();
	const backend: SessionBackend = {
		async createSession(opts) {
			return {
				sessionId: opts.conversationKey,
				async prompt() {
					started.push(opts.conversationKey);
					return new Promise<string>((resolve) => finish.set(opts.conversationKey, () => resolve("ok")));
				},
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config({ maxActiveSessions: 2 }),
		sessionDir: "/tmp/feishu-conversation-cap",
		sessionBackend: backend,
		sender: sender([]) as never,
	});
	const forChat = (id: string): FeishuInboundMessage => ({ ...message(`m-${id}`), chatId: `oc_${id}` });
	await manager.route(forChat("a"));
	await manager.route(forChat("b"));
	await manager.route(forChat("c"));
	await waitUntil(() => started.length === 2);
	assert.deepEqual(new Set(started), new Set(["oc_a", "oc_b"]));
	finish.get("oc_a")?.();
	await waitUntil(() => started.length === 3);
	assert.equal(started[2], "oc_c");
	finish.get("oc_b")?.();
	finish.get("oc_c")?.();
});

test("shutdown 中止活动 turn 并清理 reaction/progress", async () => {
	let rejectPrompt: ((error: Error) => void) | undefined;
	let promptStarted = false;
	let aborted = 0;
	let disposed = 0;
	const removed: string[] = [];
	const recalled: string[] = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-shutdown",
				async prompt() {
					promptStarted = true;
					return new Promise<never>((_, reject) => { rejectPrompt = reject; });
				},
				subscribe() { return () => {}; },
				async abort() { aborted += 1; rejectPrompt?.(new Error("aborted")); },
				async dispose() { disposed += 1; },
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config({ reaction: { enabled: true, processingEmoji: "Typing" } }),
		sessionDir: "/tmp/feishu-conversation-shutdown",
		sessionBackend: backend,
		sender: sender([]) as never,
		reactions: {
			async add() { return "reaction-shutdown"; },
			async remove(messageId) { removed.push(messageId); return true; },
		},
		recallMessage: async (messageId) => { recalled.push(messageId); return true; },
	});
	await manager.route(message("m-shutdown"));
	await waitUntil(() => promptStarted);
	await manager.shutdown();
	assert.equal(aborted, 1);
	assert.equal(disposed, 1);
	assert.deepEqual(removed, ["m-shutdown"]);
	assert.ok(recalled.length >= 1);
});

test("shutdown 不再启动同会话排队消息，也不把主动中止发送成用户错误", async () => {
	let rejectActive: ((error: Error) => void) | undefined;
	const prompts: string[] = [];
	const sent: Array<{ chatId: string; text: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-queued-shutdown",
				async prompt(text) {
					prompts.push(text);
					return new Promise<never>((_, reject) => { rejectActive = reject; });
				},
				subscribe() { return () => {}; },
				async abort() { rejectActive?.(new Error("aborted")); },
				async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-queued-shutdown", sessionBackend: backend,
		sender: sender(sent) as never,
	});
	await manager.route(message("queued-one"));
	await waitUntil(() => prompts.length === 1);
	await manager.route(message("queued-two"));
	await manager.shutdown();
	assert.deepEqual(prompts, ["prompt-queued-one"]);
	assert.equal(sent.some((entry) => entry.text.includes("处理出错")), false);
});

test("turn_end 文本作为权威 final 进入 durable outbox", async () => {
	let listener: (event: unknown) => void = () => {};
	const durable: string[] = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-turn-end",
				async prompt() {
					listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "工具前文本" }] } });
					listener({ type: "turn_end", message: { id: "turn-final", content: [{ type: "text", text: "权威最终文本" }] } });
				},
				subscribe(fn) { listener = fn; return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-turn-end", sessionBackend: backend, sender: sender([]) as never,
		durableOutbox: { enqueue(_chatId, text) { durable.push(text); return ["final"]; } },
	});
	await manager.route(message("turn-end"));
	await waitUntil(() => durable.length === 1);
	assert.deepEqual(durable, ["权威最终文本"]);
});

test("assistant message_end error 即使 prompt 正常 resolve 也进入 durable error 通知", async () => {
	let listener: (event: unknown) => void = () => {};
	const durable: Array<{ text: string; kind?: string; meta?: unknown }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-event-error",
				async prompt() {
					listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "部分文本" } });
					listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Failed to extract accountId from token" } });
					return "";
				},
				subscribe(fn) { listener = fn; return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-event-error", sessionBackend: backend, sender: sender([]) as never,
		durableOutbox: { enqueue(_chatId, text, _opts, meta) { durable.push({ text, kind: meta?.kind, meta }); return ["error"]; } },
	});
	await manager.route(message("m-event-error"));
	await waitUntil(() => durable.length === 1);
	assert.equal(durable[0]?.text, "处理出错：Failed to extract accountId from token");
	assert.equal(durable[0]?.kind, "error");
});

test("assistant 成功轮覆盖此前的错误轮", async () => {
	let listener: (event: unknown) => void = () => {};
	const durable: Array<{ text: string; kind?: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-event-retry",
				async prompt() {
					listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary failure" } });
					listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "重试成功" }], stopReason: "stop" } });
					return "";
				},
				subscribe(fn) { listener = fn; return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-event-retry", sessionBackend: backend, sender: sender([]) as never,
		durableOutbox: { enqueue(_chatId, text, _opts, meta) { durable.push({ text, kind: meta?.kind }); return ["final"]; } },
	});
	await manager.route(message("m-event-retry"));
	await waitUntil(() => durable.length === 1);
	assert.deepEqual(durable, [{ text: "重试成功", kind: "final" }]);
});

test("shutdown 对挂起的外部进度发送有界返回", async () => {
	let backendCreated = 0;
	let releaseSend!: () => void;
	const backend: SessionBackend = {
		async createSession() { backendCreated += 1; throw new Error("must not create after shutdown"); },
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-shutdown-bounded", sessionBackend: backend,
		sender: { async send() {
			return new Promise((resolve) => { releaseSend = () => resolve({ success: false }); });
		} } as never,
		shutdownTimeoutMs: 10,
	});
	await manager.route(message("hung-progress"));
	await new Promise((resolve) => setImmediate(resolve));
	const startedAt = Date.now();
	await manager.shutdown();
	assert.ok(Date.now() - startedAt < 100);
	assert.equal(backendCreated, 0);
	releaseSend();
	await waitUntil(() => manager.queueStats().active === 0);
});

test("媒体资源解析后以 Pi ImageContent 传入 prompt，并在 turn 后清理", async () => {
	let capturedText = "";
	let capturedImages: unknown[] | undefined;
	let cleaned = 0;
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-image",
				async prompt(text, images) { capturedText = text; capturedImages = images; return "看到了"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: "vision",
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({
		config: config(),
		sessionDir: "/tmp/feishu-conversation-image",
		sessionBackend: backend,
		sender: sender(sent) as never,
		resourceResolver: {
			async resolve() {
				return {
					promptSuffix: "\n\n[附件 note.txt 内容]\nhello",
					images: [{ type: "image", data: "iVBORw==", mimeType: "image/png" }],
					cleanup() { cleaned += 1; },
				};
			},
		},
	});
	await manager.route({
		...message("m-image"),
		msgType: "image",
		text: "[图片附件]",
		resources: [{ kind: "image", key: "img", messageId: "m-image" }],
	});
	await waitUntil(() => sent.some((item) => item.text === "看到了"));
	await waitUntil(() => cleaned === 1);
	assert.match(capturedText, /note\.txt/);
	assert.deepEqual(capturedImages, [{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
	assert.equal(cleaned, 1);
});

test("忙碌时普通消息通过 Pi steer 注入当前 run，不创建第二个完整 turn", async () => {
	let resolvePrompt!: (value: string) => void;
	let promptCount = 0;
	const steered: string[] = [];
	const sent: Array<{ chatId: string; text: string }> = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-steer",
				async prompt() {
					promptCount += 1;
					return new Promise<string>((resolve) => { resolvePrompt = resolve; });
				},
				async steer(text) { steered.push(text); },
				subscribe: () => () => {}, async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-steer-default", sessionBackend: backend, sender: sender(sent) as never });
	await manager.route(message("steer-active"));
	await waitUntil(() => promptCount === 1);
	assert.equal(await manager.route(message("steer-next")), "steered");
	assert.deepEqual(steered, ["prompt-steer-next"]);
	assert.equal(promptCount, 1);
	resolvePrompt("steered-final");
	await waitUntil(() => sent.some((entry) => entry.text === "steered-final"));
	assert.equal(promptCount, 1);
});

test("steer 与当前消息共同进入 pending 工具边界，成功 final 后一起确认", async () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-steer-pending-"));
	const pendingFile = join(dir, "pending.jsonl");
	let resolvePrompt!: (value: string) => void;
	try {
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-steer-pending",
					async prompt() { return new Promise<string>((resolve) => { resolvePrompt = resolve; }); },
					async steer() {}, subscribe: () => () => {}, async abort() {}, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({ config: config(), sessionDir: join(dir, "sessions"), pendingFile, sessionBackend: backend, sender: sender([]) as never });
		await manager.route(message("pending-active"));
		await waitUntil(() => typeof resolvePrompt === "function");
		assert.equal(await manager.route(message("pending-steer")), "steered");
		manager.markPendingToolBoundary("sid-steer-pending");
		const records = readFileSync(pendingFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { replayPolicy: string });
		assert.deepEqual(records.map((record) => record.replayPolicy), ["manual", "manual"]);
		resolvePrompt("done");
		await waitUntil(() => new PendingStore(pendingFile).depth() === 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Pi 拒绝 steer 时消息降级为独立 FIFO turn", async () => {
	let releaseFirst!: () => void;
	const prompts: string[] = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-steer-fallback",
				async prompt(text) {
					prompts.push(text);
					if (prompts.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
					return "done";
				},
				async steer() { throw new Error("no longer streaming"); },
				subscribe: () => () => {}, async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-steer-fallback", sessionBackend: backend, sender: sender([]) as never });
	await manager.route(message("fallback-active"));
	await waitUntil(() => prompts.length === 1);
	assert.equal(await manager.route({ ...message("fallback-next"), text: "fallback work" }), "queued");
	releaseFirst();
	await waitUntil(() => prompts.length === 2);
	assert.deepEqual(prompts, ["prompt-fallback-active", "fallback work"]);
});

test("/queue 语义始终创建独立 FIFO turn，不调用 steer", async () => {
	let releaseFirst!: () => void;
	const prompts: string[] = [];
	let steerCount = 0;
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-explicit-queue",
				async prompt(text) {
					prompts.push(text);
					if (prompts.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
					return `done-${prompts.length}`;
				},
				async steer() { steerCount += 1; },
				subscribe: () => () => {}, async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-explicit-queue", sessionBackend: backend, sender: sender([]) as never });
	await manager.route(message("queue-active"));
	await waitUntil(() => prompts.length === 1);
	assert.equal(await manager.queueConversation({ ...message("queue-next"), text: "queued work" }), "queued");
	assert.equal(steerCount, 0);
	releaseFirst();
	await waitUntil(() => prompts.length === 2);
	assert.deepEqual(prompts, ["prompt-queue-active", "queued work"]);
});

test("/stop 抑制 aborted 错误且保留显式 /queue 后续任务", async () => {
	let rejectFirst!: (error: Error) => void;
	const prompts: string[] = [];
	const sent: Array<{ chatId: string; text: string }> = [];
	let created = 0;
	const backend: SessionBackend = {
		async createSession() {
			created += 1;
			return {
				sessionId: `sid-stop-${created}`,
				async prompt(text) {
					prompts.push(text);
					if (prompts.length === 1) return new Promise<string>((_resolve, reject) => { rejectFirst = reject; });
					return "queued-after-stop";
				},
				subscribe: () => () => {},
				async abort() { rejectFirst(new Error("aborted")); },
				async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-stop-queue", sessionBackend: backend, sender: sender(sent) as never });
	const active = message("stop-active");
	await manager.route(active);
	await waitUntil(() => prompts.length === 1);
	await manager.queueConversation({ ...message("stop-queued"), text: "queued task" });
	assert.equal(await manager.stopConversation(active), true);
	await waitUntil(() => prompts.length === 2);
	await waitUntil(() => sent.some((entry) => entry.text === "queued-after-stop"));
	assert.equal(sent.some((entry) => entry.text.includes("处理出错：aborted")), false);
	assert.deepEqual(prompts, ["prompt-stop-active", "queued task"]);
});

test("恢复：越过工具边界的 pending 不重跑 Agent，durable 通知后确认", async () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-recover-manual-"));
	const pendingFile = join(dir, "pending.jsonl");
	try {
		const original = new PendingStore(pendingFile);
		original.claim(message("manual-recover"), "oc_real_chat");
		original.markManual("manual-recover");
		let created = 0;
		const durable: Array<{ text: string; kind: string }> = [];
		const backend: SessionBackend = {
			async createSession() { created += 1; throw new Error("manual pending must not rerun"); },
		};
		const manager = new ConversationManager({
			config: config(), sessionDir: join(dir, "sessions"), pendingFile, sessionBackend: backend,
			sender: sender([]) as never,
			durableOutbox: {
				enqueue(_chatId, text, _opts, meta) { durable.push({ text, kind: meta.kind }); return ["recovery-notice"]; },
			},
		});
		assert.equal(await manager.recoverPending(), 1);
		assert.equal(created, 0);
		assert.equal(durable.length, 1);
		assert.match(durable[0].text, /避免重复副作用/);
		assert.equal(durable[0].kind, "error");
		assert.equal(new PendingStore(pendingFile).depth(), 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/model 不带参数：展示当前模型 + 可用候选 + 切换语法（对齐 hermes）", async () => {
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-model-list", async prompt() { return "ok"; }, subscribe() { return () => {}; },
				async abort() {}, async dispose() {}, modelId: "deepseek-flash",
				async setModel() { return true; },
				async listModels() {
					return [
						{ id: "deepseek-flash", provider: "deepseek" },
						{ id: "deepseek-v4-pro", provider: "deepseek" },
						{ id: "gpt-5.6-luna", provider: "openai" },
					];
				},
				thinkingLevel() { return "high"; },
			};
		},
	};
	const sent: Array<{ chatId: string; text: string }> = [];
	const manager = new ConversationManager({ config: config(), sessionDir: "/tmp/feishu-model-list", sessionBackend: backend, sender: sender(sent) as never });
	const out = await manager.modelConversation(message("model-list"));

	// 当前模型 + 思考等级
	assert.match(out, /^当前模型：deepseek-flash/);
	assert.match(out, /思考等级：high/);
	// 候选带 provider 前缀，且不重复当前模型
	assert.match(out, /deepseek\/deepseek-v4-pro/);
	assert.match(out, /openai\/gpt-5\.6-luna/);
	assert.ok(!out.includes("· deepseek/deepseek-flash"), "当前模型不应出现在可切换列表里");
	// 明确给出切换语法与相关命令
	assert.match(out, /切换：\/model <模型>/);
	assert.match(out, /\/models/);
	assert.match(out, /\/thinking/);
});

test("/model 无 listModels 能力（老 pi）时仍返回当前模型，不报错", async () => {
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-no-list", async prompt() { return "ok"; }, subscribe() { return () => {}; },
				async abort() {}, async dispose() {}, modelId: "legacy-model",
				async setModel() { return true; },
			};
		},
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-model-nolist",
		sessionBackend: backend, sender: sender([]) as never,
	});
	const out = await manager.modelConversation(message("model-nolist"));
	assert.match(out, /^当前模型：legacy-model/);
	assert.match(out, /切换：\/model <模型>/);
});

test("/model 候选超过上限时截断并提示其余数量", async () => {
	const many = Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, provider: "p" }));
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-many", async prompt() { return "ok"; }, subscribe() { return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m0",
				async setModel() { return true; },
				async listModels() { return many; },
			};
		},
	};
	const manager = new ConversationManager({
		config: config(), sessionDir: "/tmp/feishu-model-many",
		sessionBackend: backend, sender: sender([]) as never,
	});
	const out = await manager.modelConversation(message("model-many"));
	assert.match(out, /可切换（14）/);
	assert.match(out, /其余 4 个/);
});

test("引用带页脚的消息：注入提示词里的页脚被剥干净（两种形态都覆盖）", async () => {
	const prompts: string[] = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-quote-footer",
				async prompt(text) { prompts.push(text); return "done"; },
				subscribe: () => () => {}, async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const dir = mkdtempSync(join(tmpdir(), "feishu-quote-footer-"));
	try {
		const manager = new ConversationManager({
			config: config(), sessionDir: dir, sessionBackend: backend, sender: sender([]) as never,
		});
		const plainFooter = [
			"⚡ deepseek-flash · **1.5s** · 上下文 **2.1%（20.8k / 1.0M）**",
			"📊 本会话 输入 **62.3k** = 未命中 **613** + 缓存命中 **61.7k**（**99.0%**） | 输出 **57**",
			"💰 本会话 **<$0.01 / <¥0.01（估算）**",
		].join("\n");
		// 形态一：文本通道（无分割线）
		await manager.route({ ...message("q1"), replyToMessageId: "om_parent", replyToText: `答案是 42。\n\n${plainFooter}` });
		await waitUntil(() => prompts.length === 1);
		assert.ok(prompts[0]!.includes("答案是 42。"), prompts[0]);
		assert.ok(!prompts[0]!.includes("📊"), `页脚行不得进提示词：${prompts[0]}`);
		assert.ok(!prompts[0]!.includes("本会话"), `页脚行不得进提示词：${prompts[0]}`);
		assert.ok(!prompts[0]!.includes("deepseek-flash"), `页脚行不得进提示词：${prompts[0]}`);

		// 形态二：旧版带分割线
		await manager.route({ ...message("q2"), replyToMessageId: "om_parent2", replyToText: `答案是 42。\n\n———\n本轮 m · 1.0s · in 1 / out 1\n会话 in 2 / out 2` });
		await waitUntil(() => prompts.length === 2);
		assert.ok(!prompts[1]!.includes("———"), prompts[1]);
		assert.ok(!prompts[1]!.includes("本轮"), `旧版页脚也不得进提示词：${prompts[1]}`);

		// 形态三：整条都是页脚 → 注入占位提示，不塞空引用
		await manager.route({ ...message("q3"), replyToMessageId: "om_parent3", replyToText: "📊 本会话 输入 1.0k | 输出 10" });
		await waitUntil(() => prompts.length === 3);
		assert.ok(prompts[2]!.includes("[无法获取被回复消息原文]"), prompts[2]);
		assert.ok(!prompts[2]!.includes("本会话"), prompts[2]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("页脚群级开关：本群关了就不发页脚，别的群不受影响", async () => {
	const backend = (): SessionBackend => ({
		async createSession() {
			return {
				sessionId: "sid-footer-chat",
				async prompt() { return "答案正文。"; },
				subscribe: () => () => {}, async abort() {}, async dispose() {}, modelId: "deepseek-flash",
			};
		},
	});
	const footerCfg = { enabled: true, showCost: true, showCny: false, showContext: false, showSession: true };

	// ① 本群显式关闭 → 只有正文（进度消息不算）
	const sentOff: Array<{ chatId: string; text: string }> = [];
	const dirOff = mkdtempSync(join(tmpdir(), "feishu-footer-off-"));
	try {
		const manager = new ConversationManager({
			config: config({ footer: footerCfg, footerByChat: { oc_real_chat: false } }),
			sessionDir: dirOff, sessionBackend: backend(), sender: sender(sentOff) as never,
		});
		await manager.route(message("footer-off"));
		await waitUntil(() => sentOff.some((m) => m.text.includes("答案正文。")));
		// 文本通道不带分割线（那是卡片里的 hr），所以按页脚行特征判断
		assert.ok(sentOff.every((m) => !m.text.includes("⚡") && !m.text.includes("本会话")), `群级关闭后任何消息都不得带页脚：${JSON.stringify(sentOff)}`);
	} finally { rmSync(dirOff, { recursive: true, force: true }); }

	// ② 关的是别的群 → 本群照发（同时验证开关是"按群"的，不是全局一刀切）
	const sentOn: Array<{ chatId: string; text: string }> = [];
	const dirOther = mkdtempSync(join(tmpdir(), "feishu-footer-other-"));
	try {
		const manager = new ConversationManager({
			config: config({ footer: footerCfg, footerByChat: { oc_other: false } }),
			sessionDir: dirOther, sessionBackend: backend(), sender: sender(sentOn) as never,
		});
		await manager.route(message("footer-on"));
		await waitUntil(() => sentOn.some((m) => m.text.includes("答案正文。")));
		const body = sentOn.find((m) => m.text.includes("答案正文。"))!.text;
		assert.ok(body.includes("⚡ deepseek-flash"), `别的群的设置不该影响本群：${body}`);
	} finally { rmSync(dirOther, { recursive: true, force: true }); }
});
