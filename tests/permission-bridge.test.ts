import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionBridge, classifyToolCall, redactParams } from "../src/approval/permission-bridge.js";

function input(toolCallId = "tc1") {
	return { conversationKey: "oc:u:ou", sessionId: "sid", runId: toolCallId, toolCallId, toolName: "bash", paramsText: "{\"command\":\"git status\"}", chatId: "oc", sourceMessageId: "om", allowedOperatorIds: ["ou_admin", "admin"] };
}

test("审批：非管理员/跨群/token 错误不能消费，一次批准原子放行", async () => {
	let pendingId = "";
	let token = "";
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (pending) => { pendingId = pending.id; token = pending.token; return "card-1"; },
	});
	const gate = await bridge.gate(input());
	assert.equal(gate.decision, "ask");
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "oc", operatorOpenId: "ou_bad", choice: "once" }).ok, false);
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "other", operatorOpenId: "ou_admin", choice: "once" }).ok, false);
	assert.equal(bridge.pendingCount(), 1);
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "oc", operatorOpenId: "ou_admin", choice: "once" }).ok, true);
	assert.equal(await gate.verdict, "approved");
	assert.equal(bridge.pendingCount(), 0);
	assert.equal(bridge.decide({ id: pendingId, token, messageId: "card-1", chatId: "oc", operatorOpenId: "ou_admin", choice: "once" }).ok, false);
});

test("审批：session 仅当前 conversation 生效，always 回写全局", async () => {
	const always: string[] = [];
	let pending: { id: string; token: string } = { id: "", token: "" };
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return `card-${value.toolCallId}`; },
		onAlwaysAllow: (tool) => { always.push(tool); },
	});
	let gate = await bridge.gate(input("session-1"));
	bridge.decide({ id: pending.id, token: pending.token, messageId: "card-session-1", chatId: "oc", operatorOpenId: "admin", choice: "session" });
	assert.equal(await gate.verdict, "approved");
	assert.equal((await bridge.gate(input("session-2"))).decision, "allow");
	gate = await bridge.gate({ ...input("other"), conversationKey: "other" });
	assert.equal(gate.decision, "ask");
	bridge.decide({ id: pending.id, token: pending.token, messageId: "card-other", chatId: "oc", operatorOpenId: "admin", choice: "always" });
	assert.equal(await gate.verdict, "approved");
	assert.deepEqual(always, ["bash"]);
});

test("审批：超时默认拒绝，敏感参数审计脱敏", async () => {
	const bridge = new PermissionBridge({ getConfig: () => ({ autoApprove: [], timeoutMs: 5 }), onAsk: async () => "card" });
	const gate = await bridge.gate(input());
	assert.equal(await gate.verdict, "timeout");
	assert.equal(redactParams({ token: "abc", password: "p", command: "ok" }), "{\"token\":\"***\",\"password\":\"***\",\"command\":\"ok\"}");
});

test("审批：卡片发送挂起时仍按 TTL 返回 timeout", async () => {
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 5 }),
		onAsk: async () => new Promise<string>(() => {}),
	});
	const gate = await bridge.gate(input("hung-card"));
	assert.equal(await gate.verdict, "timeout");
	assert.equal(bridge.pendingCount(), 0);
});

test("审批：重置会话使旧卡失效，本地文件外发默认需要审批", async () => {
	let pending: { id: string; token: string } | undefined;
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return "old-card"; },
	});
	const gate = await bridge.gate(input("old-run"));
	bridge.resetSession("oc:u:ou");
	assert.equal(await gate.verdict, "denied");
	assert.equal(bridge.decide({ id: pending!.id, token: pending!.token, messageId: "old-card", chatId: "oc", operatorOpenId: "admin", choice: "once" }).ok, false);
	assert.equal(classifyToolCall("feishu_send_local_file", [], new Set()), "ask");
	assert.equal(redactParams({ command: "API_TOKEN=secret curl -H 'Authorization: Bearer abc'" }).includes("secret"), false);
	assert.equal(redactParams({ command: "API_TOKEN=secret curl -H 'Authorization: Bearer abc'" }).includes("abc"), false);
});

test("审批：审计记录包含 run/tool/card/operator 关联字段", async () => {
	const audits: Array<Record<string, unknown>> = [];
	let pending: { id: string; token: string } | undefined;
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 1_000 }),
		onAsk: async (value) => { pending = value; return "audit-card"; },
		onAudit: (event) => audits.push(event),
	});
	const gate = await bridge.gate(input("audit-tool-call"));
	bridge.decide({ id: pending!.id, token: pending!.token, messageId: "audit-card", chatId: "oc", operatorOpenId: "admin", choice: "once" });
	assert.equal(await gate.verdict, "approved");
	const final = audits.at(-1);
	assert.equal(final?.runId, "audit-tool-call");
	assert.equal(final?.toolCallId, "audit-tool-call");
	assert.equal(final?.cardMessageId, "audit-card");
	assert.equal(final?.operatorOpenId, "admin");
});
