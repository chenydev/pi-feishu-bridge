/**
 * P2-03 当前会话内的主动文本通知工具（feishu_notify）：
 * - 只认活动路由：无路由时拒绝，绝不转发到其他会话；
 * - 同一 toolCallId 重试只入队一次（outbox dedupeKey 幂等）；
 * - 工具反馈区分「已可靠排队」（durable）与「已投递」（直发）；
 * - 超长文本截断，空文本拒绝。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBridgeInlineExtension,
	type BridgeHookContext,
	type BridgeRoute,
} from "../src/session/pi-bridge-hooks.js";
import type { ExtensionAPI } from "../src/pi-types.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
	const api = {
		getAgentDir: () => "/tmp/agent",
		getPackageDir: () => "/tmp/pkg",
		ui: { setStatus() {}, notify() {} },
		on() {},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) { tools.push(tool); },
		registerCommand() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, tools };
}

function fakeCtx(options: { route?: BridgeRoute; notify?: BridgeHookContext["notifyText"] }) {
	const ctx: BridgeHookContext = {
		gateToolCall: async () => undefined,
		markToolBoundary: () => {},
		routeForSessionId: () => options.route,
		sendLocalFile: async () => ({ content: [{ type: "text", text: "sent" }] }),
		allowedOperatorIds: () => ["ou_admin"],
		redactParams: () => "[redacted]",
		...(options.notify ? { notifyText: options.notify } : {}),
	};
	return ctx;
}

const runtimeCtx = { cwd: "/workspace", sessionManager: { getSessionId: () => "sess-1" } };

async function invokeNotify(ctx: BridgeHookContext, text: unknown) {
	const { api, tools } = fakePi();
	createBridgeInlineExtension(ctx)(api);
	const tool = tools.find((entry) => entry.name === "feishu_notify");
	assert.ok(tool, "必须注册 feishu_notify 工具");
	const result = await tool.execute("tc-1", { text }, undefined, undefined, runtimeCtx) as {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
	return { result, tools };
}

test("P2-03：无活动路由时拒绝，且不转发到其他会话", async () => {
	let called = 0;
	const ctx = fakeCtx({
		route: undefined,
		notify: async () => { called += 1; return { status: "queued" as const }; },
	});
	const { result } = await invokeNotify(ctx, "进度更新");
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("没有活动的飞书会话"), result.content[0].text);
	assert.ok(result.content[0].text.includes("不会转发"), "必须明确不会串到其他会话");
	assert.equal(called, 0, "无路由时不得调用发送");
});

test("P2-03：走 durable 队列时反馈「已可靠排队」", async () => {
	const routed: Array<Record<string, unknown>> = [];
	const ctx = fakeCtx({
		route: { conversationKey: "k1", chatId: "oc_1", threadId: "th_1", sourceMessageId: "om_src" },
		notify: async (input) => { routed.push(input as unknown as Record<string, unknown>); return { status: "queued" as const }; },
	});
	const { result } = await invokeNotify(ctx, "已跑到第 3 步");
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes("已可靠排队"), result.content[0].text);
	assert.equal(routed.length, 1);
	assert.equal((routed[0].route as { chatId: string }).chatId, "oc_1", "必须使用活动路由的目标");
});

test("P2-03：无 durable 队列的直发反馈「已投递」", async () => {
	const ctx = fakeCtx({
		route: { conversationKey: "k1", chatId: "oc_1" },
		notify: async () => ({ status: "delivered" as const }),
	});
	const { result } = await invokeNotify(ctx, "直接发送");
	assert.ok(result.content[0].text.includes("已投递"), result.content[0].text);
});

test("P2-03：被拒绝时工具返回错误而不是假装成功", async () => {
	const ctx = fakeCtx({
		route: { conversationKey: "k1", chatId: "oc_1" },
		notify: async () => ({ status: "rejected" as const, detail: "发送失败" }),
	});
	const { result } = await invokeNotify(ctx, "hi");
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("通知未发送"), result.content[0].text);
	assert.ok(result.content[0].text.includes("发送失败"));
});

test("P2-03：空文本拒绝，超长文本截断到 2000", async () => {
	const texts: string[] = [];
	const ctx = fakeCtx({
		route: { conversationKey: "k1", chatId: "oc_1" },
		notify: async (input) => { texts.push(input.text); return { status: "queued" as const }; },
	});
	const empty = await invokeNotify(ctx, "   ");
	assert.equal(empty.result.isError, true);
	assert.ok(empty.result.content[0].text.includes("不能为空"));
	assert.equal(texts.length, 0);

	await invokeNotify(ctx, "x".repeat(5_000));
	assert.equal(texts.length, 1);
	assert.equal(texts[0].length, 2_000, "超长通知必须截断");
});

test("P2-03：桥版本不支持时明确报错（不静默）", async () => {
	const ctx = fakeCtx({ route: { conversationKey: "k1", chatId: "oc_1" } });
	const { result } = await invokeNotify(ctx, "hi");
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("不支持主动通知"), result.content[0].text);
});
