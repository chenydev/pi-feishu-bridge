/**
 * P0-01 入站接管持久化：
 * - dedupe 标记已落盘但账本无记录（崩溃窗口）→ 重投必须重新准入，而不是被去重吞掉；
 * - 已接管的消息重投 → 按重复丢弃，不重复执行；
 * - 批处理窗口内消息必须先落账；合并后账本只留主记录（恢复时重放合并内容）；
 * - dispatch 失败 → 账本保留交给启动恢复，避免“重投 + 恢复”双跑。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InboundPipeline, type IntakeLedger } from "../src/inbound/pipeline.js";
import { DedupeStore } from "../src/inbound/dedupe-store.js";
import { PendingStore } from "../src/session/pending-store.js";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { buildConversationKey } from "../src/session/conversation-key.js";
import { LastSentCache } from "../src/inbound/admit.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";
import type { FeishuTransport } from "../src/inbound/transport.js";

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], ...over };
}

const NO_BATCH = { enabled: false, textWindowMs: 3000, maxMessages: 8, maxChars: 4_000 };
const BATCH = { enabled: true, textWindowMs: 30, maxMessages: 8, maxChars: 4_000 };

function fakeMsg(over: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
	return {
		messageId: `om_${Math.random().toString(36).slice(2, 8)}`,
		chatId: "oc_group",
		chatType: "group",
		senderId: "ou_user",
		isBot: false,
		msgType: "text",
		text: "hi",
		mentions: [{ isSelf: true }],
		resources: [],
		ts: Date.now(),
		raw: undefined,
		...over,
	};
}

/** 与 index.ts 接线一致：真实 PendingStore 适配 IntakeLedger。 */
function ledgerFrom(store: PendingStore): IntakeLedger {
	return {
		claim: (msg, key) => { store.claim(msg, key); },
		has: (id) => store.has(id),
		merge: (primaryId, memberIds, merged) => {
			store.mergeInto(primaryId, memberIds, merged as Omit<FeishuInboundMessage, "raw">, merged.sourceMessageIds ?? memberIds);
		},
	};
}

interface Harness {
	dir: string;
	dedupeFile: string;
	pendingFile: string;
	store: PendingStore;
	pipeline(options?: { batch?: typeof NO_BATCH; onDispatch?: (m: FeishuInboundMessage) => Promise<void> }): InboundPipeline;
	dispatched: FeishuInboundMessage[];
	cleanup(): void;
}

function harness(): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-intake-"));
	const dedupeFile = join(dir, "dedupe.jsonl");
	const pendingFile = join(dir, "pending.jsonl");
	const store = new PendingStore(pendingFile);
	const dispatched: FeishuInboundMessage[] = [];
	return {
		dir,
		dedupeFile,
		pendingFile,
		store,
		dispatched,
		pipeline(options = {}) {
			return new InboundPipeline({
				config: cfg({ groupPolicy: "open", requireMention: false, batch: options.batch ?? NO_BATCH }),
				transport: {} as FeishuTransport,
				lastSent: new LastSentCache(8),
				dedupeStore: new DedupeStore({ file: dedupeFile, capacity: 64, ttlMs: 60_000 }),
				intake: ledgerFrom(store),
				onDispatch: options.onDispatch ?? (async (m) => { dispatched.push(m); }),
			});
		},
		cleanup() { rmSync(dir, { recursive: true, force: true }); },
	};
}

test("P0-01：dedupe 标记已落盘但账本无记录（崩溃窗口）→ 重投重新准入", async () => {
	const h = harness();
	try {
		// 进程 A：只写了去重标记就崩溃（准入/接管都没走到）
		new DedupeStore({ file: h.dedupeFile, capacity: 64, ttlMs: 60_000 }).check("om_crash");

		// 进程 B 重启：同一 dedupe 文件 + 空账本，平台重投同一条消息
		const pipeline = h.pipeline();
		await pipeline.handle(fakeMsg({ messageId: "om_crash" }));

		assert.equal(h.dispatched.length, 1, "orphan 重投必须重新准入，而不是被去重吞掉");
		assert.equal(pipeline.getStats().recovered, 1);
		assert.equal(pipeline.getStats().duplicate, 0);
		assert.ok(h.store.has("om_crash"), "重投后应已持久接管");
	} finally { h.cleanup(); }
});

test("P0-01：已接管消息重投按重复丢弃，不重复执行", async () => {
	const h = harness();
	try {
		await h.pipeline().handle(fakeMsg({ messageId: "om_once" }));
		assert.equal(h.dispatched.length, 1);
		assert.ok(h.store.has("om_once"));

		const second = h.pipeline();
		await second.handle(fakeMsg({ messageId: "om_once" }));

		assert.equal(h.dispatched.length, 1, "已接管消息不得重复 dispatch");
		assert.equal(second.getStats().duplicate, 1);
		assert.equal(second.getStats().recovered, 0);
	} finally { h.cleanup(); }
});

test("P0-01：批处理窗口内消息先落账，合并后账本只留主记录", async () => {
	const h = harness();
	try {
		const pipeline = h.pipeline({ batch: BATCH });
		await pipeline.handle(fakeMsg({ messageId: "om_b1", text: "第一条" }));
		await pipeline.handle(fakeMsg({ messageId: "om_b2", text: "第二条" }));

		// 窗口未到期时两条都必须在账本里（这是原实现丢失的那段）
		assert.ok(h.store.has("om_b1") && h.store.has("om_b2"), "窗口内消息必须已被持久接管");

		pipeline.flushBatch(`${fakeMsg().chatId}:u:ou_user`);
		await new Promise((r) => setTimeout(r, 60));

		const restarted = new PendingStore(h.pendingFile);
		const recovered = restarted.recoverable();
		assert.equal(recovered.length, 1, "合并后账本只应有一条记录");
		assert.equal(recovered[0].message.text, "第一条\n第二条");
		assert.deepEqual(recovered[0].sourceMessageIds, ["om_b1", "om_b2"]);
		assert.ok(restarted.has("om_b1") && restarted.has("om_b2"), "成员 id 仍应判定为已接管");
	} finally { h.cleanup(); }
});

test("P0-01：dispatch 失败时保留账本，重投不重复执行", async () => {
	const h = harness();
	try {
		const failing = h.pipeline({ onDispatch: async () => { throw new Error("boom"); } });
		await assert.rejects(() => failing.handle(fakeMsg({ messageId: "om_fail" })));
		assert.ok(h.store.has("om_fail"), "失败消息必须留在账本等待启动恢复");

		const second = h.pipeline();
		await second.handle(fakeMsg({ messageId: "om_fail" }));
		assert.equal(h.dispatched.length, 0, "重投不得绕过账本再跑一次");
		assert.equal(second.getStats().duplicate, 1);
	} finally { h.cleanup(); }
});

test("P0-01：接管后崩溃，新进程可从账本恢复该消息", async () => {
	const h = harness();
	try {
		const failing = h.pipeline({ onDispatch: async () => { throw new Error("runtime crash"); } });
		await assert.rejects(() => failing.handle(fakeMsg({ messageId: "om_recover", text: "别丢了我" })));

		const recovered = new PendingStore(h.pendingFile).recoverable();
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].message.messageId, "om_recover");
		assert.equal(recovered[0].message.text, "别丢了我");
	} finally { h.cleanup(); }
});

test("P0-01：未启用 intake 时保持原行为（命中即丢弃）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-intake-off-"));
	try {
		const dispatched: FeishuInboundMessage[] = [];
		const mk = () => new InboundPipeline({
			config: cfg({ groupPolicy: "open", requireMention: false, batch: NO_BATCH }),
			transport: {} as FeishuTransport,
			lastSent: new LastSentCache(8),
			dedupeStore: new DedupeStore({ file: join(dir, "dedupe.jsonl"), capacity: 64, ttlMs: 60_000 }),
			onDispatch: async (m) => { dispatched.push(m); },
		});
		await mk().handle(fakeMsg({ messageId: "om_off" }));
		const second = mk();
		await second.handle(fakeMsg({ messageId: "om_off" }));
		assert.equal(dispatched.length, 1);
		assert.equal(second.getStats().duplicate, 1);
		assert.equal(second.getStats().recovered, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------- 命令类消息不重放 ----
// 对齐 hermes：重启恢复不重放原命令（hermes 用 recovery note 替换原文，
// 桥的选择是直接跳过命令类消息 —— 重放 /new 会再清一次上下文）。

test("命令类消息标为 never：重启后不重放（/new 不会被执行两次）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pending-cmd-"));
	const file = join(dir, "pending.jsonl");
	const store = new PendingStore(file, { now: () => 1_000_000 });
	const msg = {
		messageId: "cmd-new-1", chatId: "oc_group", chatType: "group" as const,
		senderId: "ou_user", isBot: false, msgType: "text" as const,
		text: "/new", mentions: [], resources: [], raw: undefined, ts: 1,
	};
	store.claim(msg, "oc_group:u:ou_user");
	store.markNever("cmd-new-1");

	// 换一个 owner（模拟重启），可恢复项里不应再出现这条命令
	const after = new PendingStore(file, { now: () => 2_000_000 });
	const recoverable = after.recoverable();
	assert.equal(recoverable.length, 0, "命令类消息不应出现在可重放集合中");
});

test("普通消息仍是 auto：重启后可重放（保证入站不丢）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pending-cmd-"));
	const file = join(dir, "pending.jsonl");
	const store = new PendingStore(file, { now: () => 1_000_000 });
	store.claim({
		messageId: "normal-1", chatId: "oc_group", chatType: "group" as const,
		senderId: "ou_user", isBot: false, msgType: "text" as const,
		text: "帮我查下日志", mentions: [], resources: [], raw: undefined, ts: 1,
	}, "oc_group:u:ou_user");

	const after = new PendingStore(file, { now: () => 2_000_000 });
	assert.equal(after.recoverable().length, 1, "普通消息应仍可重放");
});

// ------------------------------------------------- 恢复提示注入（对齐 hermes）----
// hermes: "Do NOT re-execute old tool calls — skip any unfinished work from
// the conversation history." 桥把它作为一次性方括号元信息注入到恢复后的
// 第一条消息前 —— 用户看不到（不是飞书消息），但模型的行为会受约束。

test("崩溃恢复后注入恢复提示：不改原文、且只注入一次", async () => {
	const dir = mkdtempSync(join(tmpdir(), "recovery-note-"));
	const file = join(dir, "pending.jsonl");
	const store = new PendingStore(file, { now: () => 1_000_000 });
	const msg: FeishuInboundMessage = {
		messageId: "recover-1", chatId: "oc_group", chatType: "group",
		senderId: "ou_user", isBot: false, msgType: "text",
		text: "继续刚才的任务", mentions: [], resources: [], raw: undefined, ts: 1,
	};
	// 必须用真实的 key 规则（groupSessionsPerUser 默认 false 时 key 就是裸 chatId），
	// 手写 "oc_group:u:ou_user" 会和 runtime 算出的 key 不一致，导致注入匹配不上。
	const key = buildConversationKey(msg, cfg());
	store.claim(msg, key);
	store.markManual("recover-1");   // 模拟"已越过工具边界"

	const captured: string[] = [];
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-recovery", async prompt(t: string) { captured.push(t); return "ok"; },
				subscribe() { return () => {}; }, async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: cfg(), sessionDir: dir, sessionBackend: backend,
		sender: { async send() { return { success: true }; }, async update() { return { success: true }; } } as never,
		pendingFile: file,
	});

	// recoverPending 会为 manual 记录写通知 + 登记恢复提示
	await manager.recoverPending();
	// 再走一轮普通消息，触发提示注入
	await manager.route({ ...msg, messageId: "recover-next" });
	await new Promise((r) => setTimeout(r, 60));

	const injected = captured.find((t) => t.includes("不要重新执行对话历史中未完成的工具调用"));
	assert.ok(injected, "恢复后应有提示注入");
	assert.match(injected, /继续刚才的任务/, "原消息文本必须保留在提示之后，不被替换");
	// 只注入一次
	captured.length = 0;
	await manager.route({ ...msg, messageId: "recover-third" });
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(!captured.some((t) => t.includes("不要重新执行")), "提示不应重复注入");
});
