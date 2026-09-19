/**
 * P2-05 调度公平性：
 * - 热点会话连续执行若干 turn 后，若其他会话在等待则让出执行槽（不把队列跑完才释放）；
 * - 让出只发生在两个完整 run 之间（不打断工具执行/审批）；
 * - 每个 conversation 的显式队列仍保持 FIFO 顺序；
 * - waiting 队列去重，不会被同一会话重复占用。
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
		...DEFAULT_CONFIG,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 3));
	}
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-fair-"));
}

test("P2-05：热点会话让出执行槽，冷门会话不被无限阻塞", async () => {
	const dir = tempDir();
	try {
		const order: string[] = [];
		const backend: SessionBackend = {
			async createSession(opts) {
				return {
					sessionId: `sid-${opts.chatId}`,
					async prompt(text: string) {
						order.push(text.replace(/\n[\s\S]*$/, "").slice(0, 24));
						await new Promise((resolve) => setTimeout(resolve, 5));
						return "ok";
					},
					subscribe() { return () => {}; },
					async abort() {}, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config({ maxActiveSessions: 1 }),
			sessionDir: dir, sessionBackend: backend,
			sender: { async send() { return { success: true, messageId: "om_x" }; } } as never,
		});
		(manager as unknown as { pumpTurnBatch: number }).pumpTurnBatch = 2;

		// 热点会话：排 6 条；冷门会话：1 条
		for (let i = 0; i < 6; i += 1) void manager.route(message(`hot-${i}`, "oc_hot"));
		await new Promise((resolve) => setTimeout(resolve, 15));
		void manager.route(message("cold-1", "oc_cold"));

		await waitUntil(() => order.length >= 7, 5_000);
		const coldIndex = order.findIndex((entry) => entry.includes("cold-1"));
		assert.ok(coldIndex >= 0, `冷门会话必须被调度：${JSON.stringify(order)}`);
		assert.ok(coldIndex <= 3, `冷门会话不应等到热点队列跑完（实际第 ${coldIndex + 1} 个）：${JSON.stringify(order)}`);

		// 热点队列仍按 FIFO 完成
		await waitUntil(() => manager.schedulerSnapshot().queues.every((queue) => queue.queued === 0), 5_000);
		const hotOrder = order.filter((entry) => entry.includes("hot-")).map((entry) => Number.parseInt(entry.replace(/\D/g, "").slice(-1), 10));
		for (let i = 1; i < hotOrder.length; i += 1) {
			assert.ok(hotOrder[i] > hotOrder[i - 1], `同会话必须保持 FIFO：${JSON.stringify(hotOrder)}`);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-05：waiting 队列不重复占用同一会话", async () => {
	const dir = tempDir();
	try {
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid",
					async prompt() { await new Promise((resolve) => setTimeout(resolve, 10)); return "ok"; },
					subscribe() { return () => {}; },
					async abort() {}, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config({ maxActiveSessions: 1 }),
			sessionDir: dir, sessionBackend: backend,
			sender: { async send() { return { success: true, messageId: "om_x" }; } } as never,
		});
		// 同一会话入队 3 条：调度等待队列中不应出现重复引用
		for (let i = 0; i < 3; i += 1) void manager.route(message(`m-${i}`));
		await new Promise((resolve) => setTimeout(resolve, 30));
		const waiting = (manager as unknown as { waitingPumps: unknown[] }).waitingPumps;
		assert.equal(new Set(waiting).size, waiting.length, "waiting 队列必须去重");
		assert.ok(manager.schedulerSnapshot().queues.length >= 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-05：shutdown 时不让出（清理路径不受公平性影响）", async () => {
	const dir = tempDir();
	try {
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid",
					async prompt() { return "ok"; },
					subscribe() { return () => {}; },
					async abort() {}, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config({ maxActiveSessions: 1 }),
			sessionDir: dir, sessionBackend: backend,
			sender: { async send() { return { success: true, messageId: "om_x" }; } } as never,
		});
		void manager.route(message("s-1"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		await manager.shutdown();
		assert.equal(manager.schedulerSnapshot().waiting, 0, "shutdown 后等待队列必须清空");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
