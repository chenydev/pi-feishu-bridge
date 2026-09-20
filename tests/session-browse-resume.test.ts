/**
 * P1-04/P1-05 会话浏览与恢复：
 * - `/sessions` 只列出本会话索引内的历史（不泄露目录里其他会话），支持分页；
 * - `/name` 校验长度与控制字符；
 * - `/resume #N` 只接受列表选择 id（不接受任意路径），忙碌/缺失/越界/已是当前都拒绝；
 * - 指针写失败时保留当前会话；恢复后旧审批失效。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { ConversationStore } from "../src/session/conversation-store.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

function config(): BridgeConfig {
	return {
		...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"],
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
	};
}

function message(messageId: string): FeishuInboundMessage {
	return {
		messageId, chatId: "oc_real_chat", chatType: "p2p", senderId: "ou_user", isBot: false,
		msgType: "text", text: "x", mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
}

function sender() {
	return { async send() { return { success: true, messageId: "om_x" }; } };
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-browse-"));
}

/** 可控 backend：会话清单来自传入数组；记录 setSessionName 调用。 */
function backend(options: {
	sessions?: Array<{ path: string; id: string; name?: string; modified: number; messageCount: number }>;
	names?: string[];
} = {}): SessionBackend {
	const names = options.names ?? [];
	return {
		async createSession() {
			return {
				sessionId: "sid",
				async prompt() { return "ok"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: "m",
				async compact() { return "ok"; },
				async setModel() { return true; },
				async listSessions() { return options.sessions ?? []; },
				sessionName() { return names[names.length - 1]; },
				setSessionName(name: string) { names.push(name); },
			};
		},
	};
}

/** 造一个已有历史指针的会话（指针文件直接写入）。 */
function seedPointer(dir: string, conversationKey: string, files: string[], generation = 3): string {
	const storeFile = join(dir, "conversations.jsonl");
	const store = new ConversationStore(storeFile);
	store.set({
		conversationKey,
		sessionFile: files[0],
		generation,
		history: files.slice(1).map((file, index) => ({ sessionFile: file, generation: generation - index - 1, retiredAt: 1 })),
	});
	return storeFile;
}

const CONVERSATION_KEY = "oc_real_chat";

test("P1-04：/sessions 只列本会话索引内的历史并标注当前", async () => {
	const dir = tempDir();
	try {
		const current = join(dir, "cur.jsonl");
		const old = join(dir, "old.jsonl");
		const other = join(dir, "other-chat.jsonl");
		for (const file of [current, old, other]) writeFileSync(file, "");
		const storeFile = seedPointer(dir, CONVERSATION_KEY, [current, old]);
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backend({
				sessions: [
					{ path: current, id: "1", name: "修复登录", modified: Date.now() - 60_000, messageCount: 12 },
					{ path: old, id: "2", name: "旧会话", modified: Date.now() - 7_200_000, messageCount: 40 },
					{ path: other, id: "3", name: "别人的会话", modified: Date.now(), messageCount: 99 },
				],
			}),
			sender: sender() as never, conversationFile: storeFile,
		});
		const text = await manager.listSessionsFor(message("m1"));
		assert.ok(text.includes("#1 · 修复登录"), text);
		assert.ok(text.includes("· 当前"), "当前会话必须有标记");
		assert.ok(text.includes("#2 · 旧会话"));
		assert.ok(!text.includes("别人的会话"), "不得泄露目录里其他会话");
		assert.ok(!text.includes(dir), "不得暴露绝对路径");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-04：/sessions 分页与页码", async () => {
	const dir = tempDir();
	try {
		const files = Array.from({ length: 12 }, (_, i) => join(dir, `s-${i}.jsonl`));
		for (const file of files) writeFileSync(file, "");
		const storeFile = seedPointer(dir, CONVERSATION_KEY, [files[0], ...files.slice(1)]);
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backend({
				sessions: files.map((path, i) => ({ path, id: String(i), name: `会话${i}`, modified: Date.now() - i * 60_000, messageCount: i })),
			}),
			sender: sender() as never, conversationFile: storeFile,
		});
		const first = await manager.listSessionsFor(message("m1"));
		assert.ok(first.includes("共 12 段"), first);
		assert.ok(first.includes("第 1/2 页"));
		assert.ok(first.includes("/sessions 1"), "首页应提示下一页");
		const second = await manager.listSessionsFor(message("m1"), 1);
		assert.ok(second.includes("第 2/2 页"));
		const overflow = await manager.listSessionsFor(message("m1"), 99);
		assert.ok(overflow.includes("第 2/2 页"), "越界页回落到最后一页");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-04：/name 校验空值、超长与控制字符", async () => {
	const dir = tempDir();
	try {
		const names: string[] = [];
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backend({ names }), sender: sender() as never,
		});
		assert.match(await manager.renameConversation(message("m1")), /用法：\/name/);
		assert.match(await manager.renameConversation(message("m1"), "x".repeat(61)), /名称过长/);
		assert.match(await manager.renameConversation(message("m1"), "\u0000\u0007"), /不合法/);
		assert.equal(names.length, 0, "非法名称不得写入 transcript");

		const ok = await manager.renameConversation(message("m1"), "  修复登录  ");
		assert.match(ok, /已将会话命名为：修复登录/, "名称应 trim 后写入");
		assert.deepEqual(names, ["修复登录"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-05：/resume #N 切换指针并让旧审批失效", async () => {
	const dir = tempDir();
	try {
		const current = join(dir, "cur.jsonl");
		const old = join(dir, "old.jsonl");
		writeFileSync(current, "");
		writeFileSync(old, "");
		const storeFile = seedPointer(dir, CONVERSATION_KEY, [current, old]);
		const invalidations: Array<{ conversationKey: string; runId?: string; reason: string }> = [];
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backend({ sessions: [] }), sender: sender() as never,
			conversationFile: storeFile,
			onApprovalInvalidate: (event) => { invalidations.push(event); },
		});
		await manager.modelConversation(message("m1")); // 建立句柄（当前屏）

		const result = await manager.resumeConversation(message("m1"), "#2");
		assert.match(result, /已恢复会话 #2/, result);
		const pointer = new ConversationStore(storeFile).get(CONVERSATION_KEY);
		assert.equal(pointer?.sessionFile, old, "指针必须切到目标会话");
		assert.equal(pointer?.generation, 4, "generation 必须递增");
		assert.ok(invalidations.some((event) => event.reason === "reset"), "恢复后旧审批必须失效");
		assert.equal(manager.residentCount(), 0, "旧句柄必须被处置（下条消息懒恢复）");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-05：/resume 拒绝任意路径、无效 id、已是当前与缺失文件", async () => {
	const dir = tempDir();
	try {
		const current = join(dir, "cur.jsonl");
		writeFileSync(current, "");
		const missing = join(dir, "gone.jsonl");
		const storeFile = seedPointer(dir, CONVERSATION_KEY, [current, missing]);
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backend({ sessions: [] }), sender: sender() as never, conversationFile: storeFile,
		});

		assert.match(await manager.resumeConversation(message("m1"), "../../etc/passwd"), /用法：\/resume/);
		assert.match(await manager.resumeConversation(message("m1"), current), /用法：\/resume/);
		assert.match(await manager.resumeConversation(message("m1"), "#99"), /选择 id 无效/);
		assert.match(await manager.resumeConversation(message("m1"), "#1"), /已经是当前会话/);
		assert.match(await manager.resumeConversation(message("m1"), "#2"), /文件不存在/);
		const pointer = new ConversationStore(storeFile).get(CONVERSATION_KEY);
		assert.equal(pointer?.sessionFile, current, "被拒绝的恢复不得改动指针");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-05：没有会话索引时不 pretend（明确拒绝）", async () => {
	const dir = tempDir();
	try {
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backend({ sessions: [] }), sender: sender() as never,
		});
		assert.match(await manager.resumeConversation(message("m1"), "#1"), /未启用会话索引/);
		assert.match(await manager.listSessionsFor(message("m1")), /尚无历史记录/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
