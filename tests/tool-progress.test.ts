/**
 * P1-02 工具进度与思考摘要：
 * - 进度展示工具名、耗时（≥1s）与脱敏摘要；
 * - 以 toolCallId 配对：并行工具互不影响，结束只移除对应条目；
 * - 工具风暴折叠为「另有 N 个工具在运行」；
 * - 命令/参数脱敏（绝不原样展示 token）；
 * - 思考摘要默认关闭；关闭展示不影响执行与 final 投递。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager, sanitizeCommand, summarizeToolArgs } from "../src/session/conversation-manager.js";
import { buildConversationKey } from "../src/session/conversation-key.js";
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

function message(messageId: string): FeishuInboundMessage {
	return {
		messageId, chatId: "oc_real_chat", chatType: "p2p", senderId: "ou_user", isBot: false,
		msgType: "text", text: "x", mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-progress-"));
}

/** 构造一个已建立句柄的 manager，并把进度节流压到 0 以便断言。 */
async function withManager(options: {
	dir: string;
	edits: string[];
	showThinking?: boolean;
	onCreate?: () => void;
}): Promise<ConversationManager> {
	const backend: SessionBackend = {
		async createSession() {
			options.onCreate?.();
			return {
				sessionId: "sid-progress",
				async prompt() { return "ok"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config({ progress: { showThinking: options.showThinking ?? false } }),
		sessionDir: options.dir,
		sessionBackend: backend,
		sender: { async send() { return { success: true, messageId: "om_progress" }; } } as never,
		editMessage: async (_id, text) => { options.edits.push(text); return true; },
	});
	(manager as unknown as { progressMinIntervalMs: number }).progressMinIntervalMs = 0;
	return manager;
}

/** 初始化会话句柄并准备进度消息 id（进度状态只在 run 中创建，测试里直接注入）。 */
async function prime(manager: ConversationManager): Promise<void> {
	await manager.modelConversation(message("m1"));
	const st = (manager as unknown as { progressBySession: Map<string, { messageId?: string; lastUpdateAt: number; toolStack: string[] }> }).progressBySession;
	const key = buildConversationKey(message("m1"), config());
	const existing = st.get(key);
	if (existing) existing.messageId = "om_progress";
	else st.set(key, { messageId: "om_progress", lastUpdateAt: 0, toolStack: [] });
}


/** 进度写入经 P0-04 串行写入器异步落定，断言前需要让它 flush。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

test("P1-02：进度消息展示工具名、脱敏摘要与耗时", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "bash", "start", { command: "npm run build --token=supersecret" }, "tc-1");
		await settle();
		assert.ok(edits.length > 0, "工具开始应触发进度更新");
		const first = edits[edits.length - 1];
		assert.ok(first.includes("执行命令") || first.includes("bash"), first);
		assert.ok(first.includes("npm run build"), first);
		assert.ok(!first.includes("supersecret"), `参数必须脱敏：${first}`);
		assert.ok(first.includes("***"), first);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-02：toolCallId 配对 —— 并行工具互不影响，结束只移除对应条目", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "read", "start", { file_path: "/workspace/a.ts" }, "tc-a");
		manager.onToolEvent("sid-progress", "grep", "start", { pattern: "TODO" }, "tc-b");
		await settle();
		const both = edits[edits.length - 1];
		assert.ok(both.includes("读取文件"), both);
		assert.ok(both.includes("搜索内容"), both);

		manager.onToolEvent("sid-progress", "read", "end", undefined, "tc-a");
		await settle();
		const afterRead = edits[edits.length - 1];
		assert.ok(!afterRead.includes("读取文件"), `read 结束后不应再显示：${afterRead}`);
		assert.ok(afterRead.includes("搜索内容"), "并行中的 grep 必须保留");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-02：重复的同一 toolCallId start 不重复入栈（SDK 重试/重放）", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 1" }, "tc-dup");
		manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 1" }, "tc-dup");
		await settle();
		const last = edits[edits.length - 1];
		assert.equal((last.match(/执行命令|bash/g) ?? []).length, 1, `重复 start 只能有一条：${last}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-02：工具风暴折叠为「另有 N 个工具在运行」", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		for (let i = 0; i < 7; i += 1) {
			manager.onToolEvent("sid-progress", "bash", "start", { command: `echo ${i}` }, `tc-${i}`);
		}
		await settle();
		const last = edits[edits.length - 1];
		assert.ok(last.includes("另有"), `应提示折叠：${last}`);
		assert.ok(last.split("\n").length <= 12, "进度消息不得无限增长");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-02：思考摘要默认关闭，开启后才显示", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits, showThinking: false });
		await prime(manager);
		const st = (manager as unknown as { progressBySession: Map<string, { thinking?: string }> }).progressBySession;
		const key = [...st.keys()][0];
		st.get(key)!.thinking = "正在分析这段代码";
		manager.onToolEvent("sid-progress", "read", "start", { file_path: "/a" }, "tc-t");
		await settle();
		assert.ok(!edits[edits.length - 1].includes("正在分析"), "默认关闭时不得展示思考内容");
	} finally { rmSync(dir, { recursive: true, force: true }); }

	const dir2 = tempDir();
	try {
		const edits2: string[] = [];
		const manager2 = await withManager({ dir: dir2, edits: edits2, showThinking: true });
		await prime(manager2);
		const st2 = (manager2 as unknown as { progressBySession: Map<string, { thinking?: string }> }).progressBySession;
		const key2 = [...st2.keys()][0];
		st2.get(key2)!.thinking = "正在分析这段代码";
		manager2.onToolEvent("sid-progress", "read", "start", { file_path: "/a" }, "tc-t");
		await settle();
		assert.ok(edits2[edits2.length - 1].includes("正在分析这段代码"), "开启开关后应展示摘要");
	} finally { rmSync(dir2, { recursive: true, force: true }); }
});

test("P1-02：参数摘要只取有信息量字段并脱敏", () => {
	assert.equal(summarizeToolArgs("bash", { command: "ls -la" }), "ls -la");
	assert.equal(summarizeToolArgs("read", { file_path: "/workspace/a.ts", extra: 1 }), "/workspace/a.ts");
	assert.equal(summarizeToolArgs("grep", { pattern: "TODO" }), "TODO");
	assert.equal(summarizeToolArgs("bash", undefined), undefined);
	assert.equal(summarizeToolArgs("bash", { command: "   " }), undefined);
	const secret = summarizeToolArgs("bash", { command: "curl -H 'authorization: bearer sk-abcdef' https://x" });
	assert.ok(secret && !secret.includes("sk-abcdef"), `必须脱敏：${secret}`);
});

test("P1-02：sanitizeCommand 覆盖常见秘密形态", () => {
	assert.ok(!sanitizeCommand("PASSWORD=hunter2 ./run").includes("hunter2"));
	assert.ok(!sanitizeCommand("--token abc123").includes("abc123"));
	assert.ok(sanitizeCommand("npm test").includes("npm test"), "普通命令保持可读");
	assert.ok(sanitizeCommand("x".repeat(500)).length <= 180, "必须截断");
});

test("P1-02：进度展示开关不影响最终投递", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const sent: string[] = [];
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-final",
					async prompt() { return "最终回答"; },
					subscribe() { return () => {}; },
					async abort() {}, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config({ progress: { showThinking: true } }),
			sessionDir: dir, sessionBackend: backend,
			sender: {
				async send(_chatId: string, text: string) {
					sent.push(text);
					return { success: true, messageId: "om_x" };
				},
			} as never,
			editMessage: async (_id, text) => { edits.push(text); return true; },
		});
		await manager.route(message("final-1"));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const finals = sent.filter((text) => text.includes("最终回答"));
		assert.equal(finals.length, 1, `final 必须投递且只投一次：${JSON.stringify(sent)}`);
		assert.ok(!finals[0].includes("正在处理"), "进度不得混进 final");
		assert.ok(sent.some((text) => text.includes("正在处理")), "运行期间应有进度消息（不影响 final）");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
