/**
 * P1-06 模型候选与思考等级：
 * - `/models` 分页列出已认证模型（provider 区分同名）；
 * - `/thinking` 查看/设置，仅接受当前模型可用等级，忙碌时拒绝变更；
 * - 不支持思考的模型给出明确提示，不假装成功。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager } from "../src/session/conversation-manager.js";
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
	return mkdtempSync(join(tmpdir(), "pi-feishu-thinking-"));
}

interface BackendOptions {
	models?: Array<{ id: string; provider?: string }>;
	levels?: string[];
	initialLevel?: string;
	currentModel?: string;
}

function backendWith(options: BackendOptions, state?: { level: string }): SessionBackend {
	const models = options.models ?? [];
	const levels = options.levels ?? [];
	const levelState = state ?? { level: options.initialLevel ?? levels[0] ?? "" };
	return {
		async createSession() {
			return {
				sessionId: "sid",
				async prompt() { return "ok"; },
				subscribe() { return () => {}; },
				async abort() {},
				async dispose() {},
				modelId: options.currentModel ?? "m",
				async compact() { return "ok"; },
				async setModel() { return true; },
				async listModels() { return models; },
				availableThinkingLevels() { return levels; },
				thinkingLevel() { return levelState.level; },
				setThinkingLevel(level: string) {
					// 模拟 provider 的 clamp：不支持的等级回落到最低可用等级
					levelState.level = levels.includes(level) ? level : (levels[0] ?? "");
				},
			};
		},
	};
}

test("P1-06：/models 分页列出并标记当前模型（含 provider）", async () => {
	const dir = tempDir();
	try {
		const models = Array.from({ length: 23 }, (_, i) => ({ id: `m-${i}`, provider: "prov" }));
		models[5] = { id: "m-5", provider: "prov" };
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backendWith({ models, currentModel: "m-3" }), sender: sender() as never,
		});
		const first = await manager.listModels(message("m1"));
		assert.ok(first.includes("可用模型（23）"));
		assert.ok(first.includes("prov/m-3（当前）"), "当前模型必须有标记且带 provider");
		assert.ok(first.includes("/models 1"), "首页必须提示下一页");

		const second = await manager.listModels(message("m1"), 1);
		assert.ok(second.includes("第 2/2 页"), second);
		const overflow = await manager.listModels(message("m1"), 99);
		assert.ok(overflow.includes("第 2/2 页"), "越界页应回落到最后一页");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-06：/thinking 查看当前等级与可用等级", async () => {
	const dir = tempDir();
	try {
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backendWith({ levels: ["low", "medium", "high"], initialLevel: "medium" }), sender: sender() as never,
		});
		const text = await manager.thinkingConversation(message("m1"));
		assert.ok(text.includes("当前思考等级：medium"), text);
		assert.ok(text.includes("low / medium / high"), text);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-06：非法等级被拒并列出可用值，合法等级回显实际值", async () => {
	const dir = tempDir();
	try {
		const state = { level: "low" };
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backendWith({ levels: ["low", "max"] }, state), sender: sender() as never,
		});
		const invalid = await manager.thinkingConversation(message("m1"), "ultra");
		assert.ok(invalid.includes("不支持的等级：ultra"), invalid);
		assert.ok(invalid.includes("low / max"));
		assert.equal(state.level, "low", "非法等级不得改变会话状态");

		const ok = await manager.thinkingConversation(message("m1"), "max");
		assert.ok(ok.includes("已设置思考等级：max"), ok);
		assert.equal(state.level, "max");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-06：不支持思考的模型给出明确提示", async () => {
	const dir = tempDir();
	try {
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backendWith({ levels: [] }), sender: sender() as never,
		});
		assert.equal(await manager.thinkingConversation(message("m1")), "当前模型不支持思考等级");
		assert.equal(await manager.thinkingConversation(message("m1"), "high"), "当前模型不支持思考等级");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-06：没有已认证模型时给出可读提示", async () => {
	const dir = tempDir();
	try {
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: backendWith({ models: [] }), sender: sender() as never,
		});
		assert.equal(await manager.listModels(message("m1")), "没有已认证的模型");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1-06：命令帮助包含新命令", async () => {
	const { formatSlashCommandHelp } = await import("../src/slash-commands.js");
	const help = formatSlashCommandHelp();
	assert.ok(help.includes("/models"), "帮助必须列出 /models");
	assert.ok(help.includes("/thinking"), "帮助必须列出 /thinking");
});
