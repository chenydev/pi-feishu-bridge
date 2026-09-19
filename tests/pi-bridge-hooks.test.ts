/**
 * P0-02 桥侧内联扩展：注入子会话的 tool_call 审批 gate 与文件工具，
 * 以及从子会话扩展发现中剔除网关扩展（避免重复启动飞书 WS）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBridgeInlineExtension,
	stripGatewayExtensions,
	type BridgeGateInput,
	type BridgeHookContext,
	type BridgeRoute,
} from "../src/session/pi-bridge-hooks.js";
import type { ExtensionAPI } from "../src/pi-types.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
	const handlers = new Map<string, Handler[]>();
	const api = {
		getAgentDir: () => "/tmp/agent",
		getPackageDir: () => "/tmp/pkg",
		ui: { setStatus() {}, notify() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }) {
			tools.push(tool);
		},
		registerCommand() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { api, tools, handlers };
}

function fakeCtx(route: BridgeRoute | undefined) {
	const calls = { gated: [] as BridgeGateInput[], marked: [] as string[], sent: Array<Record<string, unknown>>() };
	const ctx: BridgeHookContext = {
		gateToolCall: async (input) => {
			calls.gated.push(input);
			return input.toolName === "bash" ? { block: true, reason: "blocked-by-test" } : undefined;
		},
		markToolBoundary: (sessionId) => { calls.marked.push(sessionId); },
		routeForSessionId: () => route,
		sendLocalFile: async (input) => {
			calls.sent.push(input as unknown as Record<string, unknown>);
			return { content: [{ type: "text", text: "sent" }] };
		},
		allowedOperatorIds: () => ["ou_admin"],
		redactParams: () => "[redacted]",
	};
	return { ctx, calls };
}

const RUNTIME = { cwd: "/workspace", sessionManager: { getSessionId: () => "sess-1" } };
const ROUTE: BridgeRoute = {
	conversationKey: "oc_group:u:ou_user",
	chatId: "oc_group",
	threadId: "om_thread",
	sourceMessageId: "om_src",
	runId: "run-1",
};

test("P0-02：内联扩展注册 tool_call hook 与文件工具", () => {
	const { api, tools, handlers } = fakePi();
	const { ctx } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);

assert.deepEqual(tools.map((tool) => tool.name), ["feishu_send_local_file", "feishu_notify", "feishu_ask"], "P2-01/P2-03 新增澄清提问与会话内通知工具");
	assert.equal(handlers.get("tool_call")?.length, 1);
});

test("P0-02：tool_call 在有路由时经审批 gate，并透传阻断结果", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];

	const blocked = await handler({ toolCallId: "tc1", toolName: "bash", input: { command: "rm -rf /" } }, RUNTIME);
	assert.deepEqual(blocked, { block: true, reason: "blocked-by-test" });
	assert.equal(calls.gated.length, 1);
	assert.deepEqual(calls.gated[0], {
		conversationKey: "oc_group:u:ou_user",
		sessionId: "sess-1",
		runId: "run-1",
		toolCallId: "tc1",
		toolName: "bash",
		paramsText: "[redacted]",
		chatId: "oc_group",
		threadId: "om_thread",
		sourceMessageId: "om_src",
		allowedOperatorIds: ["ou_admin"],
	});
	assert.deepEqual(calls.marked, ["sess-1"], "工具边界必须先标记（pending replayPolicy=manual）");

	const allowed = await handler({ toolCallId: "tc2", toolName: "read", input: {} }, RUNTIME);
	assert.equal(allowed, undefined);
	assert.equal(calls.gated.length, 2);
});

test("P0-02：无路由的会话不拦截（不越权管其他工具的调用）", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(undefined);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];

	const result = await handler({ toolCallId: "tc9", toolName: "bash", input: {} }, RUNTIME);
	assert.equal(result, undefined);
	assert.equal(calls.gated.length, 0);
	assert.equal(calls.marked.length, 0);
});

test("P0-02：缺少 toolCallId/toolName 的事件直接放行", async () => {
	const { api, handlers } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const handler = handlers.get("tool_call")![0];

	assert.equal(await handler({ toolName: "bash" }, RUNTIME), undefined);
	assert.equal(await handler({ toolCallId: "tc" }, RUNTIME), undefined);
	assert.equal(calls.gated.length, 0);
});

test("P0-02：文件工具把当前路由与 cwd 交给 outer 发送链路", async () => {
	const { api, tools } = fakePi();
	const { ctx, calls } = fakeCtx(ROUTE);
	createBridgeInlineExtension(ctx)(api);
	const tool = tools[0];

	const result = await tool.execute("tc-file", { path: "out/report.pdf", caption: "报表" }, undefined, undefined, RUNTIME);
	assert.deepEqual(result, { content: [{ type: "text", text: "sent" }] });
	assert.equal(calls.sent.length, 1);
	assert.deepEqual(calls.sent[0], {
		toolCallId: "tc-file",
		path: "out/report.pdf",
		caption: "报表",
		cwd: "/workspace",
		route: ROUTE,
	});
});

test("P0-02：stripGatewayExtensions 剔除网关扩展且不误伤其他扩展", () => {
	const gateways = [
		{ path: "/workspace/pi-agent/npm/node_modules/pi-feishu-bridge/src/index.ts", resolvedPath: "/x/pi-feishu-bridge/src/index.ts" },
		{ path: "/workspace/pi-agent/npm/node_modules/@tunglam/pi-lark-cli/src/index.ts", resolvedPath: "/x/pi-lark-cli/src/index.ts" },
		{ path: "/workspace/some-other/bridge.ts", resolvedPath: "/x/bridge.ts" },
	];
	const result = stripGatewayExtensions({ extensions: gateways });
	assert.equal(result.extensions.length, 2, "只应剔除 pi-feishu-bridge 自身");
	assert.ok(!result.extensions.some((e) => e.path?.includes("pi-feishu-bridge")));
	assert.ok(result.extensions.some((e) => e.path?.includes("pi-lark-cli")), "其他扩展必须保留");

	// 自定义标记
	const custom = stripGatewayExtensions({ extensions: gateways }, ["some-other"]);
	assert.equal(custom.extensions.length, 2);
	assert.ok(!custom.extensions.some((e) => e.path?.includes("some-other")));
});

test("P0-02：stripGatewayExtensions 无匹配时原样返回（不复制对象）", () => {
	const input = { extensions: [{ path: "/a/pi-lark-cli/index.ts" }] };
	assert.equal(stripGatewayExtensions(input), input);
});

test("内联扩展注册压缩与终局事件（用户侧可见性）", () => {
	const registered: string[] = [];
	const fakePi = {
		registerTool: () => {},
		on: (name: string) => { registered.push(name); },
	} as never;
	const ctx = {
		gateToolCall: async () => undefined,
		markToolBoundary: () => {},
		routeForSessionId: () => undefined,
		sendLocalFile: async () => ({ ok: true }),
		allowedOperatorIds: () => [],
		redactParams: () => "",
	} as never;
	createBridgeInlineExtension(ctx)(fakePi);
	// 压缩期间 Pi 不产出任何事件，不显式告知用户就只看到"莫名卡住"
	assert.ok(registered.includes("session_before_compact"), "必须订阅压缩开始");
	assert.ok(registered.includes("session_compact"), "必须订阅压缩结束");
	assert.ok(registered.includes("session_compact_failed"), "压缩失败也要说明");
	// agent_end 之后 Pi 可能继续 auto-retry/compact/follow-up，只有 agent_settled 是终局
	assert.ok(registered.includes("agent_settled"), "必须订阅终局信号");
	assert.ok(registered.includes("tool_call"), "原有的工具闸门不能丢");
});
