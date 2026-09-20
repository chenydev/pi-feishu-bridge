/**
 * P1-08 空闲会话回收：
 * - 只有「无 active run、无排队/steer、无未决审批、不在初始化中且空闲超 TTL」才回收；
 * - 回收只释放执行句柄，不删除 Pi 历史/pending/outbox，下次消息懒恢复；
 * - 驻留上限按 LRU 回收，与 maxActiveSessions 的并发上限语义分开。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"],
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
		...over,
	};
}

function message(messageId: string, chatId = "oc_real_chat"): FeishuInboundMessage {
	return {
		messageId, chatId, chatType: "p2p", senderId: "ou_user", isBot: false,
		msgType: "text", text: `prompt-${messageId}`, mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
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

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-idle-"));
}

/** 记录 dispose 次数、可挂起 prompt 的假 backend。 */
function trackingBackend(state: { created: number; disposed: number; hanging?: () => Promise<string> }) {
	const backend: SessionBackend = {
		async createSession() {
			state.created += 1;
			return {
				sessionId: `sid-${state.created}`,
				async prompt() {
					if (state.hanging) return await state.hanging();
					return "ok";
				},
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() { state.disposed += 1; },
				modelId: "m",
			};
		},
	};
	return backend;
}

test("P1-08：空闲超 TTL 回收句柄，下次消息懒恢复且历史文件沿用 P0-05 指针", async () => {
	const dir = tempDir();
	try {
		const sent: Array<{ chatId: string; text: string }> = [];
		const state = { created: 0, disposed: 0 };
		let now = 1_000_000;
		const manager = new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: trackingBackend(state),
			sender: sender(sent) as never,
			pendingFile: join(dir, "pending.jsonl"),
			conversationFile: join(dir, "conversations.jsonl"),
		});
		// 注入虚拟时钟：用 deps.now 控制空闲判定
		(manager as unknown as { now: () => number }).now = () => now;
		(manager as unknown as { idleTtlMs: number }).idleTtlMs = 1_000;

		const msg = message("idle-1");
		await manager.modelConversation(msg); // 建立会话句柄
		assert.equal(state.created, 1);
		assert.equal(manager.residentCount(), 1);

		now += 500;
		assert.equal(await manager.reclaimIdle(), 0, "未超 TTL 不得回收");

		now += 1_000;
		assert.equal(await manager.reclaimIdle(), 1, "超 TTL 应回收");
		assert.equal(state.disposed, 1, "回收必须 dispose 句柄");
		assert.equal(manager.residentCount(), 0);

		// 懒恢复：下一条消息重新建会话（不报错、历史文件由指针决定）
		await manager.modelConversation(message("idle-2"));
		assert.equal(state.created, 2, "回收后下一条消息应懒恢复会话");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-08：有未决审批时不回收", async () => {
	const dir = tempDir();
	try {
		const sent: Array<{ chatId: string; text: string }> = [];
		const state = { created: 0, disposed: 0 };
		let now = 1_000_000;
		const manager = new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: trackingBackend(state),
			sender: sender(sent) as never,
			pendingApprovalCount: () => 1, // 模拟审批卡挂起
		});
		(manager as unknown as { now: () => number }).now = () => now;
		(manager as unknown as { idleTtlMs: number }).idleTtlMs = 1;

		await manager.modelConversation(message("approval-1"));
		now += 10_000;
		assert.equal(await manager.reclaimIdle(), 0, "有未决审批时不得回收");
		assert.equal(manager.residentCount(), 1);
		assert.equal(state.disposed, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-08：运行中/排队中的会话不被回收", async () => {
	const dir = tempDir();
	try {
		const sent: Array<{ chatId: string; text: string }> = [];
		const state: { created: number; disposed: number; hanging?: () => Promise<string> } = { created: 0, disposed: 0 };
		let release!: (value: string) => void;
		state.hanging = () => new Promise<string>((resolve) => { release = resolve; });

		const manager = new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: trackingBackend(state),
			sender: sender(sent) as never,
			pendingFile: join(dir, "pending.jsonl"),
		});
		(manager as unknown as { idleTtlMs: number }).idleTtlMs = 0;

		void manager.route(message("busy-1"));
		await waitUntil(() => state.created === 1);
		// 运行中：即使 TTL=0 也不得回收
		assert.equal(await manager.reclaimIdle(Date.now() + 60_000), 0, "运行中不得回收");
		release("done");
		await waitUntil(() => manager.residentCount() >= 0 && sent.length > 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-08：驻留上限按 LRU 回收，超限时先回收最久未活动的", async () => {
	const dir = tempDir();
	try {
		const sent: Array<{ chatId: string; text: string }> = [];
		const state = { created: 0, disposed: 0 };
		const manager = new ConversationManager({
			config: config({ sessionLifecycle: { idleTtlMs: 10 * 60_000, maxResidentSessions: 2, sweepIntervalMs: 60_000 } }),
			sessionDir: dir,
			sessionBackend: trackingBackend(state),
			sender: sender(sent) as never,
		});
		for (const id of ["a", "b", "c"]) {
			await manager.modelConversation(message(`m-${id}`, `oc_${id}`));
		}
		assert.equal(manager.residentCount(), 3);
		const reclaimed = await manager.reclaimIdle();
		assert.equal(reclaimed, 1, "超驻留上限应回收 1 个（3 → 2）");
		assert.equal(manager.residentCount(), 2);
		assert.equal(state.disposed, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-08：startLifecycle/stopLifecycle 幂等且不阻塞", async () => {
	const dir = tempDir();
	try {
		const sent: Array<{ chatId: string; text: string }> = [];
		const state = { created: 0, disposed: 0 };
		const manager = new ConversationManager({
			config: config({ sessionLifecycle: { idleTtlMs: 0, maxResidentSessions: 8, sweepIntervalMs: 1_000 } }),
			sessionDir: dir,
			sessionBackend: trackingBackend(state),
			sender: sender(sent) as never,
		});
		await manager.modelConversation(message("tick-1"));
		manager.startLifecycle();
		manager.startLifecycle();
		await waitUntil(() => state.disposed === 1, 3_000);
		manager.stopLifecycle();
		manager.stopLifecycle();
		assert.equal(manager.residentCount(), 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
