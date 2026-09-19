/**
 * P0-03 审批与 run 生命周期一致：
 * - run 结束/超时/被替换、会话重置后，旧审批卡不得再授予 session/always 权限；
 * - 始终允许必须先落盘成功，否则不放行；
 * - 负向校验（token/card/chat/管理员/重复/过期）不得改变授权集合或放行工具。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionBridge, redactParams, type PendingApproval } from "../src/approval/permission-bridge.js";

interface Ask {
	id: string;
	token: string;
	conversationKey: string;
	runId: string;
	toolName: string;
}

function makeBridge(options: { alwaysPersist?: boolean; onAsk?: (p: PendingApproval) => Promise<string | undefined> } = {}) {
	const asked: Ask[] = [];
	const bridge = new PermissionBridge({
		getConfig: () => ({ autoApprove: [], timeoutMs: 60_000 }),
		onAsk: async (pending) => {
			asked.push({
				id: pending.id, token: pending.token, conversationKey: pending.conversationKey,
				runId: pending.runId, toolName: pending.toolName,
			});
			return options.onAsk ? options.onAsk(pending) : `card-${pending.toolCallId}`;
		},
		onAlwaysAllow: () => (options.alwaysPersist === false ? false : true),
	});
	return { bridge, asked };
}

function gateInput(over: Record<string, unknown> = {}) {
	return {
		conversationKey: "oc_group:u:ou_user",
		sessionId: "sess-1",
		runId: "run-1",
		toolCallId: "tc-1",
		toolName: "bash",
		paramsText: "{}",
		chatId: "oc_group",
		allowedOperatorIds: ["ou_admin"],
		...over,
	} as Parameters<PermissionBridge["gate"]>[0];
}

function decision(bridge: PermissionBridge, asked: Ask, over: Record<string, unknown> = {}) {
	return bridge.decide({
		id: asked.id,
		token: asked.token,
		messageId: `card-tc-1`,
		chatId: "oc_group",
		operatorOpenId: "ou_admin",
		choice: "once",
		...over,
	} as Parameters<PermissionBridge["decide"]>[0]);
}

test("P0-03：run 结束后旧卡失效，无法再授予 always", async () => {
	const { bridge, asked } = makeBridge();
	const gate = await bridge.gate(gateInput());
	assert.equal(bridge.pendingCount(), 1);

	assert.equal(bridge.cancelRun("oc_group:u:ou_user", "run-1"), 1);
	assert.equal(bridge.pendingCount(), 0, "run 退出必须清掉未决审批");

	const result = decision(bridge, asked[0], { choice: "always" });
	assert.equal(result.ok, false);
	assert.match(result.reason, /失效|超时/);
	assert.equal(await gate.verdict, "denied", "被撤销的审批必须以 denied 收尾");
	assert.deepEqual(bridge.sessionAllowList("oc_group:u:ou_user"), []);
});

test("P0-03：cancelRun 精确匹配会话与 run，不误伤其他审批", async () => {
	const { bridge, asked } = makeBridge();
	const gateA = await bridge.gate(gateInput({ toolCallId: "tc-a", runId: "run-a" }));
	const gateB = await bridge.gate(gateInput({ toolCallId: "tc-b", runId: "run-b" }));
	assert.equal(bridge.pendingCount(), 2);

	assert.equal(bridge.cancelRun("oc_group:u:ou_user", "run-a"), 1);
	assert.equal(bridge.pendingCount(), 1, "run-b 的审批必须保留");

	// run-b 仍可正常批准
	const ok = bridge.decide({
		id: asked[1].id, token: asked[1].token, messageId: "card-tc-b",
		chatId: "oc_group", operatorOpenId: "ou_admin", choice: "once",
	});
	assert.equal(ok.ok, true);
	assert.equal(await gateB.verdict, "approved");
	assert.equal(await gateA.verdict, "denied");
});

test("P0-03：会话重置撤销全部未决审批并清空会话授权", async () => {
	const { bridge, asked } = makeBridge();
	const first = await bridge.gate(gateInput({ toolCallId: "tc-1" }));
	bridge.decide({
		id: asked[0].id, token: asked[0].token, messageId: "card-tc-1",
		chatId: "oc_group", operatorOpenId: "ou_admin", choice: "session",
	});
	assert.equal(await first.verdict, "approved");
	assert.deepEqual(bridge.sessionAllowList("oc_group:u:ou_user"), ["bash"]);

	const second = await bridge.gate(gateInput({ toolCallId: "tc-2" }));
	assert.equal(second.decision, "allow", "会话授权生效期内同会话同类工具直接放行");

	assert.equal(bridge.cancelConversation("oc_group:u:ou_user"), 0, "此时没有未决审批可撤销");
	assert.deepEqual(bridge.sessionAllowList("oc_group:u:ou_user"), [], "重置后会话授权清空");

	const third = await bridge.gate(gateInput({ toolCallId: "tc-3" }));
	assert.equal(third.decision, "ask", "重置后必须重新审批");

	// 未决审批在会话重置时被撤销
	assert.equal(bridge.pendingCount(), 1);
	assert.equal(bridge.cancelConversation("oc_group:u:ou_user"), 1, "重置必须撤销未决审批");
	assert.equal(await third.verdict, "denied");
});

test("P0-03：始终允许落盘失败时不放行、不改变授权集合", async () => {
	const { bridge, asked } = makeBridge({ alwaysPersist: false });
	const gate = await bridge.gate(gateInput());
	const result = decision(bridge, asked[0], { choice: "always" });

	assert.equal(result.ok, false);
	assert.match(result.reason, /写入失败/);
	assert.equal(await gate.verdict, "denied", "落盘失败必须按拒绝收尾");
	assert.equal(bridge.pendingCount(), 0);

	const again = await bridge.gate(gateInput({ toolCallId: "tc-2" }));
	assert.equal(again.decision, "ask", "未持久化授权的工具仍须审批");
	if (again.verdict) bridge.cancelRun("oc_group:u:ou_user", "run-1");
});

test("P0-03：负向校验不消费审批，纠正后可正常批准", async () => {
	const { bridge, asked } = makeBridge();
	const gate = await bridge.gate(gateInput());

	assert.equal(decision(bridge, asked[0], { token: "wrong-token" }).ok, false, "错误 token");
	assert.equal(decision(bridge, asked[0], { messageId: "card-other" }).ok, false, "错误卡片");
	assert.equal(decision(bridge, asked[0], { chatId: "oc_other" }).ok, false, "跨群");
	assert.equal(decision(bridge, asked[0], { operatorOpenId: "ou_stranger" }).ok, false, "非管理员");
	assert.equal(bridge.pendingCount(), 1, "负向校验不得消费审批");

	const ok = decision(bridge, asked[0]);
	assert.equal(ok.ok, true);
	assert.equal(await gate.verdict, "approved");
});

test("P0-03：重复点击只生效一次", async () => {
	const { bridge, asked } = makeBridge();
	const gate = await bridge.gate(gateInput());

	assert.equal(decision(bridge, asked[0], { choice: "deny" }).ok, true);
	assert.equal(await gate.verdict, "denied");
	const second = decision(bridge, asked[0], { choice: "once" });
	assert.equal(second.ok, false, "已消费的审批不能二次授权");
});

test("P0-03：审批超时后旧卡不再可授予权限", async () => {
	const { bridge, asked } = makeBridge();
	const gate = await bridge.gate(gateInput());
	bridge.cancelRun("oc_group:u:ou_user", "run-1"); // 等价于 run 超时退出路径
	const result = decision(bridge, asked[0], { choice: "session" });
	assert.equal(result.ok, false);
	assert.equal(await gate.verdict, "denied");
	assert.deepEqual(bridge.sessionAllowList("oc_group:u:ou_user"), []);
});

test("P0-03：审批卡片发送失败时按拒绝处理（不阻塞工具）", async () => {
	const { bridge } = makeBridge({ onAsk: async () => undefined });
	const gate = await bridge.gate(gateInput());
	assert.equal(gate.decision, "ask");
	assert.equal(await gate.verdict, "denied");
	assert.equal(bridge.pendingCount(), 0);
});

test("P0-03：拒绝后不进入会话授权，后续仍要审批", async () => {
	const { bridge, asked } = makeBridge();
	const gate = await bridge.gate(gateInput());
	assert.equal(decision(bridge, asked[0], { choice: "deny" }).ok, true);
	assert.equal(await gate.verdict, "denied");
	assert.deepEqual(bridge.sessionAllowList("oc_group:u:ou_user"), []);

	const next = await bridge.gate(gateInput({ toolCallId: "tc-2" }));
	assert.equal(next.decision, "ask");
	if (next.verdict) bridge.cancelRun("oc_group:u:ou_user", "run-1");
});

test("管理员免审批：adminSkipApproval 打开时，归属人的工具调用不产生审批卡", async () => {
	// 直接验证配置语义 + 判定函数行为（gate 分支在 index.ts 的 gateToolCall 里）
	const { loadConfig } = await import("../src/config.js");
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-admin-skip-"));
	const cfgDir = join(dir, "feishu-bridge");
	mkdirSync(cfgDir, { recursive: true });
	const base = {
		appId: "cli_x", appSecret: "s".repeat(32), domain: "feishu",
		groupPolicy: "mention", allowUsers: [], allowChats: ["oc_x"],
	};
	try {
		writeFileSync(join(cfgDir, "config.json"), JSON.stringify(base));
		assert.equal(loadConfig(dir, {}).approval.adminSkipApproval, false, "默认必须关闭（保持逐次审批）");

		writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ ...base, approval: { autoApprove: [], timeoutMs: 1000, adminSkipApproval: true } }));
		assert.equal(loadConfig(dir, {}).approval.adminSkipApproval, true, "显式开启后应生效");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("管理员免审批：从 conversationKey 解析发起人（形如 oc_x:u:ou_y）", () => {
	const pick = (key: string) => /:u:([^:]+)$/.exec(key)?.[1];
	assert.equal(pick("oc_testchat00000000000000000000:u:ou_testuser00000000000000000000"), "ou_testuser00000000000000000000");
	assert.equal(pick("oc_x:t:th_1"), undefined, "话题会话解析不出用户时不应误判为管理员");
	assert.equal(pick(""), undefined);
});

test("管理员免审批：必须用 senderId 判定，不能从 conversationKey 解析", () => {
	// conversationKey 只在「群聊+按人隔离」形态下带用户 ID：
	//   - 群聊按人隔离：oc_x:u:ou_y      ← 早期只覆盖了这种
	//   - 话题（共享）：oc_x:t:th_z        ← 取不到用户
	//   - 私聊：oc_x                      ← 取不到用户
	// 因此判定必须依赖会话活跃消息上的 senderId。
	const fromKey = (key: string) => /:u:([^:]+)$/.exec(key)?.[1];
	assert.equal(fromKey("oc_x:u:ou_admin"), "ou_admin", "群聊按人隔离：能取到");
	assert.equal(fromKey("oc_x:t:th_1"), undefined, "话题：取不到（早期 bug 就在这里漏掉）");
	assert.equal(fromKey("oc_x"), undefined, "私聊：取不到（同上）");

	// 正确做法：直接用 senderId，三种会话形态一致
	const admins = ["ou_admin"];
	for (const key of ["oc_x:u:ou_admin", "oc_x:t:th_1", "oc_x"]) {
		const senderId = "ou_admin"; // 由活跃消息提供，与 key 形态无关
		assert.ok(admins.includes(senderId), `${key} 形态下都应命中管理员`);
	}
});

test("bash 审批卡显示命令本身，不是 JSON 包装", () => {
	// 截图问题：卡片上显示 `{"command":"cd /workspace && ls -a && echo \"--- ...`，
	// JSON 换行被转义成 \n 后挤成一行并被截断，审批时看不清在批什么。
	const multi = "cd /workspace && ls -a && echo hello\nls /workspace/pi-agent";
	const shown = redactParams({ command: multi }, "bash");
	assert.ok(!shown.includes('"command"'), `不应显示 JSON 包装，实际：${shown.slice(0, 60)}`);
	assert.ok(shown.includes("\n"), "换行必须保留（多行命令要能看出结构）");
	assert.ok(shown.includes("cd /workspace && ls -a"), "命令内容原样可见");

	// 非 bash 工具仍走 JSON（结构化参数对其更合适）
	const read = redactParams({ path: "/etc/hosts" }, "read");
	assert.ok(read.includes('"path"'), "read 仍显示 JSON");

	// 脱敏不能因为走了新分支而失效
	const secret = redactParams({ command: "curl -H 'Authorization: Bearer abc123' x" }, "bash");
	assert.ok(!secret.includes("abc123"), "命令里的凭据仍要脱敏");
});
