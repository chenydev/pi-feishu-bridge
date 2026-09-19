/**
 * P2-02 受控工作区别名切换：
 * - 只接受配置登记的别名：拒绝绝对路径、`..`、未登记别名、非目录、不可访问路径；
 * - 未配置时功能整体关闭（默认）；
 * - 仅管理员可切换；忙碌（运行/排队）时拒绝；
 * - 切换协议：先校验 → 落盘指针 → 处置旧句柄 → 旧审批/澄清失效；
 * - **绝不修改进程 cwd**；失败保留当前工作区。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { ConversationStore } from "../src/session/conversation-store.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../src/types.js";

function config(aliases: Record<string, string> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG,
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
		workspaces: { aliases },
	};
}

function message(messageId: string): FeishuInboundMessage {
	return {
		messageId, chatId: "oc_real_chat", chatType: "p2p", senderId: "ou_admin", isBot: false,
		msgType: "text", text: "x", mentions: [], resources: [], raw: undefined, ts: Date.now(),
	};
}

function sender() {
	return { async send() { return { success: true, messageId: "om_x" }; } };
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-ws-"));
}

function backendWith(state: { created: number; disposed: number; cwds: string[] }): SessionBackend {
	return {
		async createSession(opts) {
			state.created += 1;
			if (opts.cwd) state.cwds.push(opts.cwd);
			return {
				sessionId: `sid-${state.created}`,
				async prompt() { return "ok"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() { state.disposed += 1; },
				modelId: "m",
			};
		},
	};
}

test("P2-02：默认关闭 —— 未配置别名时拒绝切换并给出说明", async () => {
	const dir = tempDir();
	try {
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backendWith({ created: 0, disposed: 0, cwds: [] }), sender: sender() as never,
		});
		const info = await manager.switchWorkspace(message("m1"), undefined, { isAdmin: true });
		assert.ok(info.includes("未配置受控工作区"), info);
		const denied = await manager.switchWorkspace(message("m1"), "workspace", { isAdmin: true });
		assert.ok(denied.includes("未登记的工作区别名"), denied);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：只接受别名 —— 绝对路径 / 相对路径 / .. 一律拒绝", async () => {
	const dir = tempDir();
	try {
		const ws = join(dir, "workspace");
		mkdirSync(ws, { recursive: true });
		const manager = new ConversationManager({
			config: config({ workspace: ws }), sessionDir: dir,
			sessionBackend: backendWith({ created: 0, disposed: 0, cwds: [] }), sender: sender() as never,
		});
		for (const hostile of [ws, "/etc", "../../etc", "./workspace", "workspace/..", "pan gu"]) {
			const result = await manager.switchWorkspace(message("m1"), hostile, { isAdmin: true });
			assert.ok(result.includes("只接受配置中的别名") || result.includes("未登记的工作区别名"),
				`恶意输入必须被拒：${hostile} → ${result}`);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：非目录 / 不存在 / 断链都拒绝", async () => {
	const dir = tempDir();
	try {
		const filePath = join(dir, "not-a-dir.txt");
		writeFileSync(filePath, "x");
		const link = join(dir, "broken");
		symlinkSync(join(dir, "missing-target"), link);
		const manager = new ConversationManager({
			config: config({ afile: filePath, gone: join(dir, "nope"), broken: link }), sessionDir: dir,
			sessionBackend: backendWith({ created: 0, disposed: 0, cwds: [] }), sender: sender() as never,
		});
		assert.ok((await manager.switchWorkspace(message("m1"), "afile", { isAdmin: true })).includes("不是目录"));
		assert.ok((await manager.switchWorkspace(message("m1"), "gone", { isAdmin: true })).includes("不可访问"));
		assert.ok((await manager.switchWorkspace(message("m1"), "broken", { isAdmin: true })).includes("不可访问"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：非管理员无权切换（但可以查看）", async () => {
	const dir = tempDir();
	try {
		const ws = join(dir, "workspace");
		mkdirSync(ws, { recursive: true });
		const manager = new ConversationManager({
			config: config({ workspace: ws }), sessionDir: dir,
			sessionBackend: backendWith({ created: 0, disposed: 0, cwds: [] }), sender: sender() as never,
		});
		const denied = await manager.switchWorkspace(message("m1"), "workspace", { isAdmin: false });
		assert.ok(denied.includes("仅管理员"), denied);
		const info = await manager.switchWorkspace(message("m1"), undefined, { isAdmin: false });
		assert.ok(info.includes("可用别名：workspace"), info);
		assert.ok(!info.includes(dir), "查看信息不得泄露绝对路径");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：切换成功 —— 落盘别名、处置旧句柄、下条消息用新 cwd 且不改进程 cwd", async () => {
	const dir = tempDir();
	try {
		const wsA = join(dir, "workspace");
		const wsB = join(dir, "bridge");
		mkdirSync(wsA, { recursive: true });
		mkdirSync(wsB, { recursive: true });
		const storeFile = join(dir, "conversations.jsonl");
		const state = { created: 0, disposed: 0, cwds: [] as string[] };
		const invalidations: Array<{ reason: string }> = [];
		const manager = new ConversationManager({
			config: config({ workspace: wsA, bridge: wsB }), sessionDir: dir,
			sessionBackend: backendWith(state), sender: sender() as never,
			conversationFile: storeFile,
			onApprovalInvalidate: (event) => { invalidations.push(event); },
		});
		const processCwdBefore = process.cwd();

		// 默认工作区建会话
		await manager.modelConversation(message("m1"));
		assert.equal(state.created, 1);
		assert.equal(state.cwds.length, 0, "默认工作区不应传 cwd（保持进程默认）");

		const switched = await manager.switchWorkspace(message("m1"), "bridge", { isAdmin: true });
		assert.ok(switched.includes("已切换到工作区 bridge"), switched);
		assert.ok(switched.includes("进程 cwd 未改变"), "必须明确说明不改进程 cwd");
		assert.equal(state.disposed, 1, "旧句柄必须被处置");
		assert.equal(manager.residentCount(), 0);
		assert.ok(invalidations.some((event) => event.reason === "reset"), "旧审批/澄清必须失效");

		const pointer = new ConversationStore(storeFile).get("oc_real_chat");
		assert.equal(pointer?.workspace, "bridge", "别名必须落盘（重启后不丢）");

		// 下一条消息用新工作区 cwd，且进程 cwd 未变
		await manager.modelConversation(message("m2"));
		assert.equal(state.created, 2);
		assert.equal(state.cwds.length, 1);
		assert.equal(state.cwds[0], join(dir, "bridge"), "新会话必须使用工作区 realpath");
		assert.equal(process.cwd(), processCwdBefore, "绝不能修改进程 cwd");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：忙碌时拒绝切换（运行中/排队）", async () => {
	const dir = tempDir();
	try {
		const ws = join(dir, "workspace");
		mkdirSync(ws, { recursive: true });
		let release!: (value: string) => void;
		const state = { created: 0, disposed: 0, cwds: [] as string[] };
		const backend: SessionBackend = {
			async createSession(opts) {
				state.created += 1;
				if (opts.cwd) state.cwds.push(opts.cwd);
				return {
					sessionId: `sid-${state.created}`,
					async prompt() { return new Promise<string>((resolve) => { release = resolve; }); },
					subscribe() { return () => {}; },
					async abort() {}, async dispose() { state.disposed += 1; }, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config({ workspace: ws }), sessionDir: dir,
			sessionBackend: backend, sender: sender() as never,
		});
		void manager.route(message("busy-1"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		const denied = await manager.switchWorkspace(message("busy-2"), "workspace", { isAdmin: true });
		assert.ok(denied.includes("仍在执行"), denied);
		release("done");
		await new Promise((resolve) => setTimeout(resolve, 40));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：切换到当前别名是幂等的，不重建会话", async () => {
	const dir = tempDir();
	try {
		const ws = join(dir, "workspace");
		mkdirSync(ws, { recursive: true });
		const state = { created: 0, disposed: 0, cwds: [] as string[] };
		const manager = new ConversationManager({
			config: config({ workspace: ws }), sessionDir: dir,
			sessionBackend: backendWith(state), sender: sender() as never,
		});
		await manager.switchWorkspace(message("m1"), "workspace", { isAdmin: true });
		await manager.modelConversation(message("m1"));
		assert.equal(state.created, 1);
		const again = await manager.switchWorkspace(message("m1"), "workspace", { isAdmin: true });
		assert.ok(again.includes("当前已经是工作区 workspace"), again);
		assert.equal(state.disposed, 0, "重复切换不得处置会话");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-02：配置被移除后回落到默认工作区（不静默使用旧路径）", async () => {
	const dir = tempDir();
	try {
		const ws = join(dir, "workspace");
		mkdirSync(ws, { recursive: true });
		const storeFile = join(dir, "conversations.jsonl");
		const store = new ConversationStore(storeFile);
		store.set({ conversationKey: "oc_real_chat", sessionFile: join(dir, "s.jsonl"), generation: 1, workspace: "workspace" });

		const state = { created: 0, disposed: 0, cwds: [] as string[] };
		const manager = new ConversationManager({
			config: config({}), sessionDir: dir, // 别名已被移除
			sessionBackend: backendWith(state), sender: sender() as never,
			conversationFile: storeFile,
		});
		await manager.modelConversation(message("m1"));
		assert.equal(state.cwds.length, 0, "别名失效后必须回落到默认工作区");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
