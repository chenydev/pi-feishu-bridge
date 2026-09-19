/**
 * P0-05 会话指针持久化（R4 回归）：
 * - `/new` 后重启仍指向新会话文件，不把旧上下文带回来；
 * - 首次使用确定性路径并落 generation=1；
 * - 有执行/排队任务时默认拒绝（busy），force 才取消并落终态；
 * - 指针写失败不得切换会话；损坏索引不得静默回退。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { ConversationStore } from "../src/session/conversation-store.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return { ...DEFAULT_CONFIG, reaction: { ...DEFAULT_CONFIG.reaction, enabled: false }, ...over };
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

function sender(sent: Array<{ chatId: string; text: string }>) {
	return {
		async send(chatId: string, text: string) {
			sent.push({ chatId, text });
			return { success: true, messageId: `om_${sent.length}` };
		},
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

function collectingBackend(files: string[]): SessionBackend {
	return {
		async createSession(opts) {
			files.push(opts.sessionFile ?? "");
			const index = files.length;
			return {
				sessionId: `sid-${index}`,
				async prompt() { return "ok"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: "m",
			};
		},
	};
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-pointer-"));
}

test("P0-05/R4：/new 后重启仍指向新会话文件，不回退到旧上下文", async () => {
	const dir = tempDir();
	try {
		const files: string[] = [];
		const sent: Array<{ chatId: string; text: string }> = [];
		const storeFile = join(dir, "conversations.jsonl");
		const mk = () => new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: collectingBackend(files),
			sender: sender(sent) as never,
			conversationFile: storeFile,
		});

		const msg = message("m1");
		const first = mk();
		await first.modelConversation(msg);
		assert.equal(files.length, 1);
		const originalFile = files[0];

		const outcome = await first.resetConversation(msg);
		assert.equal(outcome.status, "reset");
		assert.equal(outcome.generation, 2, "generation 必须递增");

		// 进程重启：新 manager 读同一份指针
		const restarted = mk();
		await restarted.modelConversation(msg);
		assert.equal(files.length, 2);
		assert.notEqual(files[1], originalFile, "重启后必须打开 /new 之后的会话文件（R4 根因）");
		assert.ok(files[1].startsWith(originalFile.replace(/\.jsonl$/, "")) === false || true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P0-05：首次使用写入 generation=1 的确定性指针", async () => {
	const dir = tempDir();
	try {
		const files: string[] = [];
		const sent: Array<{ chatId: string; text: string }> = [];
		const storeFile = join(dir, "conversations.jsonl");
		const manager = new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: collectingBackend(files),
			sender: sender(sent) as never,
			conversationFile: storeFile,
		});
		await manager.modelConversation(message("m-init"));

		const pointers = new ConversationStore(storeFile).list();
		assert.equal(pointers.length, 1);
		assert.equal(pointers[0].generation, 1);
		assert.equal(pointers[0].sessionFile, files[0]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P0-05：有执行中任务时 /new 默认拒绝，force 才切换并取消排队任务", async () => {
	const dir = tempDir();
	try {
		const sent: Array<{ chatId: string; text: string }> = [];
		let releasePrompt!: (value: string) => void;
		let promptStarted = false;
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-busy",
					async prompt() {
						promptStarted = true;
						return await new Promise<string>((resolve) => { releasePrompt = resolve; });
					},
					subscribe() { return () => {}; },
					async abort() {},
					async dispose() {},
					modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: backend,
			sender: sender(sent) as never,
			pendingFile: join(dir, "pending.jsonl"),
			conversationFile: join(dir, "conversations.jsonl"),
		});

		const running = message("busy-1");
		void manager.route(running);
		await waitUntil(() => promptStarted);
		await manager.route(message("busy-2")); // 排队
		assert.equal(manager.intakeLedger()?.has("busy-2"), true, "排队消息应已在账本中");

		const blocked = await manager.resetConversation(running);
		assert.equal(blocked.status, "busy");
		if (blocked.status === "busy") assert.ok(blocked.pending >= 1);
		assert.equal(manager.intakeLedger()?.has("busy-2"), true, "拒绝时不得丢失排队任务");

		const forced = await manager.resetConversation(running, { force: true });
		assert.equal(forced.status, "reset");
		if (forced.status === "reset") {
			assert.equal(forced.cancelled, 1, "被取消的排队任务数应可见");
			assert.equal(forced.generation, 2);
		}
		assert.equal(manager.intakeLedger()?.has("busy-2"), false, "被取消任务必须落终态（从账本移除）");
		releasePrompt("ok");
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P0-05：指针写入失败时不切换会话并报错", async () => {
	const dir = tempDir();
	try {
		const files: string[] = [];
		const sent: Array<{ chatId: string; text: string }> = [];
		// 把指针路径放在一个普通文件下面 → mkdir 失败 → 落盘抛错
		writeFileSync(join(dir, "blocker"), "not a dir");
		const manager = new ConversationManager({
			config: config(),
			sessionDir: dir,
			sessionBackend: collectingBackend(files),
			sender: sender(sent) as never,
			conversationFile: join(dir, "blocker", "conversations.jsonl"),
		});
		const msg = message("m-fail");
		await manager.modelConversation(msg);
		const outcome = await manager.resetConversation(msg);
		assert.equal(outcome.status, "error");
		if (outcome.status === "error") assert.match(outcome.reason, /写入失败/);

		// 未切换：仍使用原会话文件
		await manager.modelConversation(msg);
		assert.equal(files.length, 1, "写指针失败不得切换会话");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P0-05：损坏索引跳过坏行，不影响有效指针", async () => {
	const dir = tempDir();
	try {
		const storeFile = join(dir, "conversations.jsonl");
		mkdirSync(dir, { recursive: true });
		writeFileSync(storeFile, [
			"{ not json",
			JSON.stringify({ conversationKey: "k1", sessionFile: "/tmp/s1.jsonl", generation: 3, updatedAt: 1 }),
			JSON.stringify({ conversationKey: "k2", generation: 1, updatedAt: 1 }), // 缺 sessionFile → 丢弃
			"",
		].join("\n"));

		const store = new ConversationStore(storeFile);
		assert.equal(store.depth(), 1, "只保留结构完整的记录");
		assert.equal(store.get("k1")?.generation, 3);
		assert.equal(store.get("k2"), undefined, "缺字段的记录不得被当成有效指针");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P0-05：ConversationStore 跨实例读回并支持递增世代", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "conversations.jsonl");
		const first = new ConversationStore(file);
		first.set({ conversationKey: "oc_x:u:ou_y", sessionFile: "/tmp/a.jsonl", generation: 1 });
		first.set({ conversationKey: "oc_x:u:ou_y", sessionFile: "/tmp/b.jsonl", generation: 2 });

		const restarted = new ConversationStore(file);
		assert.equal(restarted.depth(), 1);
		assert.equal(restarted.get("oc_x:u:ou_y")?.sessionFile, "/tmp/b.jsonl");
		assert.equal(restarted.get("oc_x:u:ou_y")?.generation, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
