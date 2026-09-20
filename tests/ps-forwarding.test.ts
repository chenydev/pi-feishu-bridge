/**
 * PS 父会话转发应答方（src/approval/ps-forwarding.ts）：
 * - 心跳是「有人在服务」的唯一跨进程信号（子会话只等 8 个轮询周期就 abandon）；
 * - 响应文件字段必须精确匹配 PS 的 ForwardedPermissionResponse（多/少/错一个字段，
 *   子会话就读不出来 → abandon 判拒绝），所以这里逐字段断言；
 * - 异常处置：无法归属会话要如实拒绝、非法请求要清掉、写失败要保留请求等下轮重试。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AlwaysApprovedStore } from "../src/approval/always-approved-store.js";
import {
	DEFAULT_PS_FORWARDING_PARENT_ID,
	PS_FORWARDING_PARENT_ENV_KEY,
	PS_FORWARDING_PARENT_ENV_KEYS,
	PsForwardingServer,
	applyPsForwardingParentEnv,
	describeForwardedRequest,
	parseForwardedRequest,
	psForwardingHeartbeatPath,
	psForwardingRequestsDir,
	psForwardingResponsesDir,
	resolvePsForwardingConfig,
	type PsForwardingApprovalInput,
	type PsForwardingDeps,
} from "../src/approval/ps-forwarding.js";

const PARENT_ID = "bridge-parent-test";

function setup(over: Partial<PsForwardingDeps> = {}) {
	const root = mkdtempSync(join(tmpdir(), "ps-fwd-"));
	const dirs = {
		root,
		requests: psForwardingRequestsDir(root, PARENT_ID),
		responses: psForwardingResponsesDir(root, PARENT_ID),
		heartbeat: psForwardingHeartbeatPath(root, PARENT_ID),
	};
	mkdirSync(dirs.requests, { recursive: true });
	mkdirSync(dirs.responses, { recursive: true });
	const decisions: PsForwardingApprovalInput[] = [];
	const deps: PsForwardingDeps = {
		forwardingDir: root,
		parentSessionId: PARENT_ID,
		routeForSessionId: () => ({ conversationKey: "oc:u:ou_admin", chatId: "oc", sourceMessageId: "om_src", runId: "run-1" }),
		allowedOperatorIds: () => ["ou_admin"],
		requestDecision: async (input) => {
			decisions.push(input);
			return { verdict: "approved", choice: "once" };
		},
		pollIntervalMs: 10,
		heartbeatRefreshMs: 20,
		stopDrainMs: 300,
		...over,
	};
	const server = new PsForwardingServer(deps);
	return {
		...dirs,
		server,
		deps,
		decisions,
		cleanup: async () => {
			await server.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("waitFor 超时");
}

function baseRequest(over: Record<string, unknown> = {}) {
	return {
		id: "req-1",
		createdAt: Date.now(),
		requesterSessionId: "sess-child",
		targetSessionId: PARENT_ID,
		requesterAgentName: "worker",
		payload: {
			kind: "bash",
			request: { surface: "bash", toolName: "bash", value: "echo hello", matchedPattern: "echo *", executedUnit: null, commandContext: null },
		},
		surface: "bash",
		value: "echo hello",
		...over,
	};
}

function writeRequest(requestsDir: string, request: Record<string, unknown>): string {
	const path = join(requestsDir, `${String(request.id)}.json`);
	writeFileSync(path, JSON.stringify(request));
	return path;
}

function readResponse(responsesDir: string, id: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(responsesDir, `${id}.json`), "utf8")) as Record<string, unknown>;
}

test("心跳：start 立刻发布 serving/<id>.json（带真实 pid），stop 撤回", async () => {
	const ctx = setup();
	try {
		ctx.server.start();
		assert.ok(existsSync(ctx.heartbeat), "start 后必须立刻有心跳（子会话宽限期只有 2s）");
		const beat = JSON.parse(readFileSync(ctx.heartbeat, "utf8")) as Record<string, unknown>;
		// PS 的 asServingHeartbeat 只认这三个字段，pid 必须是正整数（0/负数会被拒）
		assert.deepEqual(Object.keys(beat).sort(), ["pid", "sessionId", "updatedAt"]);
		assert.equal(beat.sessionId, PARENT_ID);
		assert.equal(beat.pid, process.pid);
		assert.equal(typeof beat.updatedAt, "number");
	} finally {
		await ctx.cleanup();
	}
	assert.ok(!existsSync(ctx.heartbeat), "stop 后必须撤心跳（让子会话立即判「没人服务」）");
});

test("转发请求 → 弹卡 → 响应文件字段精确匹配 PS 的 ForwardedPermissionResponse", async () => {
	const ctx = setup();
	try {
		ctx.server.start();
		const requestPath = writeRequest(ctx.requests, baseRequest());
		await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));

		assert.equal(ctx.decisions.length, 1, "一条请求只弹一次卡");
		const card = ctx.decisions[0]!;
		assert.equal(card.sessionId, "sess-child", "真正的发起会话来自请求文件的 requesterSessionId");
		assert.equal(card.conversationKey, "oc:u:ou_admin");
		assert.equal(card.toolName, "bash");
		assert.equal(card.paramsText, "echo hello", "bash 显示命令原文");
		assert.match(card.reason, /worker/, "理由里要有发起人");
		assert.match(card.reason, /echo \*/, "理由里要有命中规则");
		assert.deepEqual(card.choices, ["once", "session", "deny"], "转发路径不提供「始终批准」（写不进对方配置）");

		// 响应字段逐个核对：approved / state / responderSessionId 任一不合格，
		// PS 的 readForwardedPermissionResponse 会整体丢弃 → 子会话判拒绝。
		const response = readResponse(ctx.responses, "req-1");
		assert.deepEqual(
			Object.keys(response).sort(),
			["approved", "decidedBy", "respondedAt", "responderSessionId", "state"],
			"字段集合必须与 PS 的响应结构一致（不多不少）",
		);
		assert.equal(response.approved, true);
		assert.equal(response.state, "approved");
		assert.equal(response.responderSessionId, PARENT_ID, "responderSessionId 必须是我们声明的父会话 id");
		assert.equal(typeof response.respondedAt, "number");
		assert.deepEqual(response.decidedBy, { kind: "user", via: "dialog" }, "真人拍板 → user/dialog");

		assert.ok(!existsSync(requestPath), "响应写成功后必须清掉请求文件（对齐 PS 自己的时序）");
	} finally {
		await ctx.cleanup();
	}
});

test("本会话批准 → state=approved_for_session（子会话据此自己记会话级授权）", async () => {
	const ctx = setup({ requestDecision: async () => ({ verdict: "approved", choice: "session" }) });
	try {
		ctx.server.start();
		writeRequest(ctx.requests, baseRequest());
		await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));
		const response = readResponse(ctx.responses, "req-1");
		assert.equal(response.approved, true);
		assert.equal(response.state, "approved_for_session");
	} finally {
		await ctx.cleanup();
	}
});

test("拒绝/超时：approved=false + denialReason，decidedBy 用 unavailable（没有真人拍板）", async () => {
	for (const [verdict, reason] of [["denied", /拒绝/], ["timeout", /超时/]] as const) {
		const ctx = setup({ requestDecision: async () => ({ verdict }) });
		try {
			ctx.server.start();
			writeRequest(ctx.requests, baseRequest());
			await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));
			const response = readResponse(ctx.responses, "req-1");
			assert.equal(response.approved, false);
			assert.equal(response.state, "denied");
			assert.match(String(response.denialReason), reason);
			assert.equal((response.decidedBy as { kind: string }).kind, "unavailable", `${verdict} 不是用户拒绝`);
		} finally {
			await ctx.cleanup();
		}
	}
});

test("无法归属到飞书会话：不弹卡、直接拒绝（不能装作问过用户）", async () => {
	const ctx = setup({ routeForSessionId: () => undefined });
	try {
		ctx.server.start();
		writeRequest(ctx.requests, baseRequest());
		await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));
		assert.equal(ctx.decisions.length, 0, "取不到路由时不该弹卡");
		const response = readResponse(ctx.responses, "req-1");
		assert.equal(response.approved, false);
		assert.match(String(response.denialReason), /飞书会话/);
	} finally {
		await ctx.cleanup();
	}
});

test("目标不是本会话：不答不删（可能是别的会话的收件箱）", async () => {
	const ctx = setup();
	try {
		ctx.server.start();
		const path = writeRequest(ctx.requests, baseRequest({ targetSessionId: "someone-else" }));
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(existsSync(path), "不该删别人的请求");
		assert.ok(!existsSync(join(ctx.responses, "req-1.json")), "也不该为它写响应");
		assert.equal(ctx.decisions.length, 0);
	} finally {
		await ctx.cleanup();
	}
});

test("非法请求与 id/文件名不一致的请求：清掉请求文件，绝不写响应", async () => {
	const ctx = setup();
	try {
		ctx.server.start();
		const broken = writeRequest(ctx.requests, { id: "broken", createdAt: 1 });
		const traversal = join(ctx.requests, "evil.json");
		writeFileSync(traversal, JSON.stringify(baseRequest({ id: "../escape" })));
		await waitFor(() => !existsSync(broken) && !existsSync(traversal));
		assert.equal(ctx.decisions.length, 0);
		assert.ok(!existsSync(join(ctx.responses, "evil.json")));
		assert.ok(!existsSync(join(ctx.root, "escape.json")), "id 不能用来跳出目录");
	} finally {
		await ctx.cleanup();
	}
});

test("同一请求多轮轮询只弹一次卡；响应写不下去也不重复弹", async () => {
	let calls = 0;
	const ctx = setup({
		requestDecision: async () => {
			calls += 1;
			return { verdict: "approved", choice: "once" };
		},
	});
	try {
		ctx.server.start();
		writeRequest(ctx.requests, baseRequest());
		await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));
		// 故意留一份同名请求（模拟「响应被清掉但请求还在」）再等几轮：不该再弹卡
		writeRequest(ctx.requests, baseRequest());
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(calls, 1, "同一 requestId 不重复弹卡");
	} finally {
		await ctx.cleanup();
	}
});

test("响应写不进去时保留请求文件（下轮重试），不吞掉请求", async () => {
	const ctx = setup();
	try {
		// 把 responses 目录换成同名文件：写入必失败（makdir/write 都过不去）
		rmSync(ctx.responses, { recursive: true, force: true });
		writeFileSync(ctx.responses, "not-a-dir");
		ctx.server.start();
		const requestPath = writeRequest(ctx.requests, baseRequest());
		await waitFor(() => ctx.decisions.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(existsSync(requestPath), "写失败必须保留请求文件，子会话还在轮询");
	} finally {
		await ctx.cleanup();
	}
});

test("stop 等未决应答落盘：关停时被撤销的审批要如实答复为拒绝", async () => {
	let release: (() => void) | undefined;
	const ctx = setup({
		requestDecision: async () => new Promise((resolve) => {
			release = () => resolve({ verdict: "denied" });
		}),
	});
	try {
		ctx.server.start();
		writeRequest(ctx.requests, baseRequest());
		await waitFor(() => Boolean(release));
		const stopping = ctx.server.stop();
		await new Promise((resolve) => setTimeout(resolve, 30));
		release?.();
		await stopping;
		const response = readResponse(ctx.responses, "req-1");
		assert.equal(response.approved, false, "关停路径必须留下拒绝响应，而不是让子会话等满 10 分钟");
	} finally {
		await ctx.cleanup();
	}
});

test("父会话 id 默认值与 env 声明/撤回：规范变量名 + 兼容名，只动自己设过的值", () => {
	assert.equal(DEFAULT_PS_FORWARDING_PARENT_ID, "feishu-bridge-parent");
	// 主变量必须是 PS 文档推荐的 subagent adapter convention 名
	assert.equal(PS_FORWARDING_PARENT_ENV_KEY, "PI_SUBAGENT_PARENT_SESSION");
	assert.deepEqual(PS_FORWARDING_PARENT_ENV_KEYS, ["PI_SUBAGENT_PARENT_SESSION", "PI_AGENT_ROUTER_PARENT_SESSION_ID"]);

	const env: NodeJS.ProcessEnv = {};
	const applied = applyPsForwardingParentEnv({ enabled: true, parentSessionId: DEFAULT_PS_FORWARDING_PARENT_ID, env });
	for (const key of PS_FORWARDING_PARENT_ENV_KEYS) {
		assert.equal(env[key], DEFAULT_PS_FORWARDING_PARENT_ID, `${key} 必须被设置`);
	}
	assert.equal(applied.appliedValue, DEFAULT_PS_FORWARDING_PARENT_ID);
	assert.deepEqual(applied.overridden, []);

	// 关闭：撤掉自己的声明（两个变量都撤）
	applyPsForwardingParentEnv({ enabled: false, parentSessionId: DEFAULT_PS_FORWARDING_PARENT_ID, previousApplied: applied.appliedValue, env });
	for (const key of PS_FORWARDING_PARENT_ENV_KEYS) assert.equal(env[key], undefined, `${key} 应被撤回`);

	// 没声明过（env 里是外层 spawner 的值）→ 不许动别人的值
	const foreign: NodeJS.ProcessEnv = { [PS_FORWARDING_PARENT_ENV_KEYS[0]!]: "outer-spawner" };
	applyPsForwardingParentEnv({ enabled: false, parentSessionId: DEFAULT_PS_FORWARDING_PARENT_ID, previousApplied: undefined, env: foreign });
	assert.equal(foreign[PS_FORWARDING_PARENT_ENV_KEYS[0]!], "outer-spawner", "不能删别人的声明");

	// 接管别人的声明要能报出来（排查时最容易被忽略的一种情况）
	const takeover = applyPsForwardingParentEnv({ enabled: true, parentSessionId: DEFAULT_PS_FORWARDING_PARENT_ID, env: { ...foreign } });
	assert.deepEqual(takeover.overridden, [{ key: PS_FORWARDING_PARENT_ENV_KEYS[0]!, value: "outer-spawner" }]);
});

test("请求解析：必需字段缺失即无效，可选字段（payload/accessIntent）容错", () => {
	assert.equal(parseForwardedRequest(null), null);
	assert.equal(parseForwardedRequest({ id: "a", createdAt: 1 }), null, "缺 requesterSessionId/targetSessionId/agentName");
	assert.equal(parseForwardedRequest(baseRequest({ createdAt: "yesterday" })), null, "createdAt 必须是数字");
	assert.ok(parseForwardedRequest(baseRequest()));

	// 老版本子会话可能没有 payload / accessIntent：仍要能读出并弹卡
	const lean = parseForwardedRequest({
		id: "req-2", createdAt: 5, requesterSessionId: "s", targetSessionId: PARENT_ID, requesterAgentName: "w",
		surface: "path", value: "/etc/hosts",
	});
	assert.ok(lean);
	const view = describeForwardedRequest(lean);
	assert.equal(view.toolName, "path");
	assert.equal(view.paramsText, JSON.stringify({ path: "/etc/hosts" }));
});

test("展示：bash 显示命令原文并脱敏，path 显示路径，理由带命中规则与工作目录", () => {
	const bash = describeForwardedRequest(parseForwardedRequest(baseRequest({
		payload: { request: { surface: "bash", toolName: "bash", value: "curl -H 'Authorization: Bearer abc123' x", matchedPattern: "curl *" } },
	}))!);
	assert.ok(!bash.paramsText.includes('"command"'), "不能显示 JSON 包装");
	assert.ok(!bash.paramsText.includes("abc123"), "命令里的凭据必须脱敏");
	assert.match(bash.reason, /curl \*/);

	const path = describeForwardedRequest(parseForwardedRequest(baseRequest({
		id: "req-3", surface: "external_directory", value: "/var/log/x",
		accessIntent: { surface: "external_directory", matchValues: ["/var/log/x"], requesterCwd: "/workspace" },
		payload: undefined,
	}))!);
	assert.equal(path.toolName, "external_directory");
	assert.match(path.paramsText, /\/var\/log\/x/);
	assert.match(path.reason, /\/workspace/, "工作目录要写进理由（跨进程排查只能靠它）");
});

test("开关语义：打开转发仍需引擎让权给 PS，否则不生效（否则同一次调用会弹两张卡）", () => {
	type ForwardingConfig = { forwarding?: { enabled?: boolean; parentSessionId?: string }; policyEngine?: "bridge" | "pi-permission-system" };
	const base: ForwardingConfig = { policyEngine: "bridge" };
	assert.deepEqual(
		resolvePsForwardingConfig(base),
		{ enabled: false, parentSessionId: DEFAULT_PS_FORWARDING_PARENT_ID, blockedBy: undefined },
		"没开开关 = 关",
	);
	assert.equal(
		resolvePsForwardingConfig({ policyEngine: "bridge", forwarding: { enabled: true } }).blockedBy,
		"policyEngine",
		"引擎仍是桥自研时不生效（桥自己已经会弹卡）",
	);
	assert.deepEqual(
		resolvePsForwardingConfig({ policyEngine: "pi-permission-system", forwarding: { enabled: true } }),
		{ enabled: true, parentSessionId: DEFAULT_PS_FORWARDING_PARENT_ID, blockedBy: undefined },
		"让权给 PS + 开关打开 = 生效",
	);
	assert.equal(
		resolvePsForwardingConfig({ policyEngine: "pi-permission-system", forwarding: { enabled: true, parentSessionId: "  my-parent  " } }).parentSessionId,
		"my-parent",
		"父会话 id 要去掉空白",
	);
});

test("展示：agent 名为 unknown 时不当作人名（PS 拿不到 agent 名时的回退值）", () => {
	const view = describeForwardedRequest(parseForwardedRequest(baseRequest({ requesterAgentName: "unknown" }))!);
	assert.ok(!view.reason.includes("unknown"), `理由不该出现 unknown：${view.reason}`);
	assert.match(view.reason, /来自子代理会话的转发审批/);
});

test("子会话放弃后（请求文件消失）：不留孤儿响应，记录回收后同 id 可重新弹卡", async () => {
	const ctx = setup({ recordTtlMs: 40 });
	try {
		ctx.server.start();
		const requestPath = writeRequest(ctx.requests, baseRequest());
		await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));
		// 模拟子会话等不到响应就放弃：它清掉请求文件，我们写的响应没人读
		// （响应写成功后我们自己也会清请求文件，所以这里用 force 容忍已经不存在）
		rmSync(requestPath, { force: true });
		await waitFor(() => !existsSync(join(ctx.responses, "req-1.json")), 1_500);

		// 记录回收后，同 id 的新请求必须重新弹卡（否则会静默丢掉一次审批）
		writeRequest(ctx.requests, baseRequest({ createdAt: Date.now() + 1 }));
		await waitFor(() => ctx.decisions.length === 2);
	} finally {
		await ctx.cleanup();
	}
});

test("请求文件在等卡期间被子会话清掉：不再写响应（免得留孤儿文件）", async () => {
	let asked = false;
	const ctx = setup({
		requestDecision: async () => {
			asked = true;
			await new Promise((r) => setTimeout(r, 30));
			return { verdict: "approved", choice: "once" };
		},
	});
	try {
		ctx.server.start();
		const requestPath = writeRequest(ctx.requests, baseRequest());
		await waitFor(() => asked);
		rmSync(requestPath, { force: true });
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.ok(!existsSync(join(ctx.responses, "req-1.json")), "请求已消失时不写响应");
	} finally {
		await ctx.cleanup();
	}
});

test("孤儿响应：进程重启（新实例）也能按 mtime 清掉没人读的响应", async () => {
	const ctx = setup({ recordTtlMs: 30 });
	try {
		ctx.server.start();
		const requestPath = writeRequest(ctx.requests, baseRequest());
		await waitFor(() => existsSync(join(ctx.responses, "req-1.json")));
		rmSync(requestPath, { force: true });   // 子会话放弃，响应没人读
		await ctx.server.stop();                 // 模拟进程退出：内存记录随之消失
		await new Promise((resolve) => setTimeout(resolve, 60)); // 让 mtime 超过 TTL
		const restarted = new PsForwardingServer(ctx.deps);
		restarted.start();
		await waitFor(() => !existsSync(join(ctx.responses, "req-1.json")), 1_500);
		await restarted.stop();
	} finally {
		await ctx.cleanup();
	}
});

// ────────────────────────────────────── 「始终批准」规则表（转发路径）────
//
// 语义来源：PS 原生对话框的「始终批准」记在**父会话**的 SessionRules 里
// （approved_for_serving_session），子会话每次重新转发、由父会话直接批准。
// 桥不是 PS 的 serving node，走不到那条路，所以在桥侧自己记一份等价物 ——
// 按 PS 给的规则名（matchedPattern）记，而不是让桥自造一套模式语言。

test("AlwaysApprovedStore：增删查 + 落盘 + 损坏文件当空表", () => {
	const dir = mkdtempSync(join(tmpdir(), "always-store-"));
	try {
		const file = join(dir, "ps-always-approved.json");
		const store = new AlwaysApprovedStore({ file, now: () => 1000 });
		assert.equal(store.size, 0);
		assert.equal(store.has(null), false, "没有规则名时一律不放行");
		assert.equal(store.has("echo *"), false);

		store.add({ pattern: "echo *", approvedBy: "ou_admin", conversationKey: "oc_x" });
		assert.equal(store.has("echo *"), true);

		// 重启后仍在（这是「始终」二字的全部意义）
		const reloaded = new AlwaysApprovedStore({ file });
		assert.equal(reloaded.has("echo *"), true);
		assert.equal(reloaded.list()[0]?.approvedBy, "ou_admin");
		assert.equal(reloaded.list()[0]?.approvedAt, 1000);

		assert.equal(reloaded.remove("echo *"), true);
		assert.equal(reloaded.remove("echo *"), false, "重复撤销返回 false");
		assert.equal(new AlwaysApprovedStore({ file }).size, 0, "撤销要落盘");

		// 损坏文件不能把桥弄挂：规则表丢了只会让用户重新点一次
		writeFileSync(file, "{ 这不是 json");
		assert.doesNotThrow(() => new AlwaysApprovedStore({ file }));
		assert.equal(new AlwaysApprovedStore({ file }).size, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("转发：命中「始终批准」规则直接放行，不弹卡", async () => {
	const dir = mkdtempSync(join(tmpdir(), "always-hit-"));
	try {
		const store = new AlwaysApprovedStore({ file: join(dir, "rules.json") });
		store.add({ pattern: "echo *", approvedBy: "ou_admin" });
		const ctx = setup({ alwaysApproved: store });
		try {
			ctx.server.start();
			const path = writeRequest(ctx.requests, baseRequest());
			await waitFor(() => !existsSync(path));
			assert.equal(ctx.decisions.length, 0, "命中规则时不应再打扰用户");
			const response = readResponse(ctx.responses, "req-1");
			assert.equal(response.approved, true);
			// 关键：给子会话普通 approved（不是 approved_for_session）——
			// 与 PS 原生 always 一致：子会话什么都不记，撤销规则后能立刻恢复询问。
			assert.equal(response.state, "approved", "命中规则要走「不留给子会话授权」的路径");
		} finally {
			await ctx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("转发：有规则表时给 always 按钮，点了记进表并带批准人", async () => {
	const dir = mkdtempSync(join(tmpdir(), "always-choice-"));
	try {
		const store = new AlwaysApprovedStore({ file: join(dir, "rules.json") });
		const seen: PsForwardingApprovalInput[] = [];
		const ctx = setup({
			alwaysApproved: store,
			requestDecision: async (input) => {
				seen.push(input);
				return { verdict: "approved", choice: "always", operatorId: "ou_admin" };
			},
		});
		try {
			ctx.server.start();
			const path = writeRequest(ctx.requests, baseRequest());
			await waitFor(() => !existsSync(path));

			assert.equal(seen.length, 1);
			assert.deepEqual(seen[0]?.choices, ["once", "session", "always", "deny"], "有规则表时必须给第四个按钮");
			assert.equal(store.has("echo *"), true, "点 always 后规则要进表");
			assert.equal(store.list()[0]?.approvedBy, "ou_admin", "要记下是谁放行的");
		} finally {
			await ctx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("转发：没有规则表时不给 always 按钮（给了却做不到比不给更糟）", async () => {
	const seen: PsForwardingApprovalInput[] = [];
	const ctx = setup({
		requestDecision: async (input) => {
			seen.push(input);
			return { verdict: "approved", choice: "once" };
		},
	});
	try {
		ctx.server.start();
		const path = writeRequest(ctx.requests, baseRequest());
		await waitFor(() => !existsSync(path));
		assert.deepEqual(seen[0]?.choices, ["once", "session", "deny"]);
	} finally {
		await ctx.cleanup();
	}
});

test("转发：请求没带规则名时 always 降级为会话级，且不记表", async () => {
	const dir = mkdtempSync(join(tmpdir(), "always-degrade-"));
	try {
		const store = new AlwaysApprovedStore({ file: join(dir, "rules.json") });
		const ctx = setup({
			alwaysApproved: store,
			requestDecision: async () => ({ verdict: "approved", choice: "always", operatorId: "ou_admin" }),
		});
		try {
			ctx.server.start();
			// 去掉 matchedPattern：没有判定依据
			const req = baseRequest();
			(req.payload as Record<string, unknown>).request = { surface: "bash", toolName: "bash", value: "echo hello" };
			const path = writeRequest(ctx.requests, req);
			await waitFor(() => !existsSync(path));

			assert.equal(store.size, 0, "没有规则名就不能记表 —— 否则等于把闸门挖空");
			assert.equal(readResponse(ctx.responses, "req-1").state, "approved_for_session", "降级为会话级");
		} finally {
			await ctx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
