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
import { LastSentCache } from "../src/inbound/admit.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage } from "../src/types.js";
import type { FeishuTransport } from "../src/inbound/transport.js";

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, ...over };
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
