/**
 * L1–L3 执行进度：
 * - **追加式日志**：工具*开始*就追加一行（动词短语 + 脱敏预览 + 技能识别），结束不改写；
 * - 同一 toolCallId 重复 start 只记一行（SDK 重放）；连续相同行折叠 `(×N)`；
 * - `maxLines` 截断 + 「共 N 步」提示；
 * - 档位：`off` 不发不发；`new` 只在工具变化时追加；`all` 每次追加；`verbose` 预览放宽；
 * - 收尾：`keepOnFinish`（默认 true）保留并写终态，否则撤回；无步骤的纯聊天一律撤回；
 * - **卡片模式下也必须有进度消息**（L1 修的就是 `if (!cardMode)` 造成的回归）；
 * - 进度展示开关不影响执行与 final 投递。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationManager, summarizeToolArgs, sanitizeCommand } from "../src/session/conversation-manager.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type ProgressMode, type SessionBackend } from "../src/types.js";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"],
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
		...over,
	};
}

function progressConfig(over: Partial<BridgeConfig["progress"]> = {}): BridgeConfig["progress"] {
	return { ...DEFAULT_CONFIG.progress, ...over };
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

interface ProgressStateShape {
	messageId?: string;
	/** 当前进度消息已被编辑的次数（飞书上限 20，见 conversation-manager 的常量说明）。 */
	edits: number;
	replyTo?: string;
	threadId?: string;
	liveTarget?: boolean;
	lines: Array<{ text: string; count: number }>;
	startedAt?: number;
	finishedAt?: number;
	thinking?: string;
}

/** 测试用的私有字段访问器（进度状态只存在内存里，没有对外只读视图）。 */
function stateOf(manager: ConversationManager): ProgressStateShape {
	const internals = manager as unknown as { sessions: Map<string, unknown> };
	const key = [...internals.sessions.keys()][0];
	return (manager as unknown as { progressState(k: string): ProgressStateShape }).progressState(key);
}

/** 构造一个已建立句柄的 manager，并把进度节流压到 0 以便断言。 */
async function withManager(options: {
	dir: string;
	edits: string[];
	progress?: Partial<BridgeConfig["progress"]>;
	mode?: ProgressMode;
	onCreate?: () => void;
	extra?: Partial<BridgeConfig>;
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
		config: config({
			progress: progressConfig({ ...options.progress, ...(options.mode ? { mode: options.mode } : {}) }),
			...options.extra,
		}),
		sessionDir: options.dir,
		sessionBackend: backend,
		sender: { async send() { return { success: true, messageId: "om_progress" }; } } as never,
		editMessage: async (_id, text) => { options.edits.push(text); return true; },
	});
	(manager as unknown as { progressMinIntervalMs: number }).progressMinIntervalMs = 0;
	return manager;
}

/** 初始化会话句柄并准备进度消息 id（进度状态只在 run 中创建，测试里直接注入）。 */
async function prime(manager: ConversationManager): Promise<ProgressStateShape> {
	await manager.modelConversation(message("m1"));
	const state = stateOf(manager);
	state.messageId = "om_progress";
	state.startedAt = Date.now();
	return state;
}

/** 进度写入经 P0-04 串行写入器异步落定，断言前需要让它 flush。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

const lastEdit = (edits: string[]): string => edits[edits.length - 1] ?? "";

// ------------------------------------------------------------ 追加式日志 ----

test("L1：工具开始即追加一行（动词短语 + 脱敏预览）", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "bash", "start", { command: "npm run build --token=supersecret" }, "tc-1");
		await settle();
		const text = lastEdit(edits);
		assert.ok(text.includes("💻 运行"), text);
		assert.ok(text.includes("npm run build"), text);
		assert.ok(!text.includes("supersecret"), `参数必须脱敏：${text}`);
		assert.ok(text.includes("***"), text);
		assert.ok(text.startsWith("🤖 执行过程"), text);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L2：技能读取显示技能名，而不是 SKILL.md", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "read", "start", {
			file_path: "/home/node/.pi/agent/skills/quanbu-login/SKILL.md",
		}, "tc-skill");
		await settle();
		assert.ok(lastEdit(edits).includes("📖 读取技能：quanbu-login"), lastEdit(edits));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1：追加式 —— 工具结束后该行仍在（看得到「做过什么」，不是只剩「还在跑什么」）", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "read", "start", { file_path: "/workspace/a.ts" }, "tc-a");
		manager.onToolEvent("sid-progress", "grep", "start", { pattern: "TODO" }, "tc-b");
		await settle();
		const both = lastEdit(edits);
		assert.ok(both.includes("📖 读取 /workspace/a.ts"), both);
		assert.ok(both.includes("🔍 搜索 TODO"), both);

		manager.onToolEvent("sid-progress", "read", "end", undefined, "tc-a");
		await settle();
		assert.ok(lastEdit(edits).includes("📖 读取 /workspace/a.ts"), `结束不该抹掉已落地的行：${lastEdit(edits)}`);
		assert.ok(lastEdit(edits).includes("🔍 搜索 TODO"), lastEdit(edits));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1：重复的同一 toolCallId start 不重复追加（SDK 重试/重放）", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 1" }, "tc-dup");
		manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 1" }, "tc-dup");
		await settle();
		const matches = lastEdit(edits).match(/💻 运行/g) ?? [];
		assert.equal(matches.length, 1, `重复 start 只能有一条：${lastEdit(edits)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1：连续相同行折叠成 (×N)", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits });
		await prime(manager);
		for (const id of ["tc-1", "tc-2", "tc-3"]) {
			manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 1" }, id);
		}
		await settle();
		assert.ok(lastEdit(edits).includes("💻 运行 echo 1 (×3)"), lastEdit(edits));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L3：超过 maxLines 只留最后 N 行并交代总步数", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits, progress: { maxLines: 3 } });
		await prime(manager);
		for (let i = 0; i < 7; i += 1) {
			manager.onToolEvent("sid-progress", "bash", "start", { command: `echo ${i}` }, `tc-${i}`);
		}
		await settle();
		const text = lastEdit(edits);
		assert.ok(text.includes("共 7 步"), text);
		assert.ok(text.includes("echo 6") && !text.includes("echo 3"), text);
		assert.ok(text.split("\n").length <= 8, `进度消息不得无限增长：${text}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 档位 ----

test("L3：mode=new 只在工具变化时追加", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits, mode: "new" });
		await prime(manager);
		manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 1" }, "tc-1");
		manager.onToolEvent("sid-progress", "bash", "start", { command: "echo 2" }, "tc-2");
		manager.onToolEvent("sid-progress", "grep", "start", { pattern: "x" }, "tc-3");
		await settle();
		const text = lastEdit(edits);
		assert.ok(text.includes("echo 1"), text);
		assert.ok(!text.includes("echo 2"), `new 档应跳过同名工具：${text}`);
		assert.ok(text.includes("🔍 搜索 x"), text);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L3：mode=off 不写入任何进度内容", async () => {
	const dir = tempDir();
	try {
		// 非卡片模式下这条消息同时是**流式草稿的载体**（与 hermes 一样：off 关的是工具进度，
		// 不是 token 流）—— 所以它会存在，但*内容*不能是进度。
		const { sent, edited } = await runOnce({ dir, step: false, progress: { mode: "off" } });
		assert.equal(edited.length, 0, `off 档不得写进度：${JSON.stringify(edited)}`);
		assert.ok(!sent.some((text) => text.includes("执行过程")), `off 档不得渲染进度块：${JSON.stringify(sent)}`);
		assert.ok(sent.some((text) => text.includes("最终答案")), "final 不受进度开关影响");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L3：mode=off + 卡片模式：连进度消息都不发", async () => {
	const dir = tempDir();
	try {
		const { sent } = await runOnce({
			dir, step: true, progress: { mode: "off" },
			extra: { streamingCard: { ...DEFAULT_CONFIG.streamingCard, enabled: true, throttleMs: 0 } },
			rawRequest: async (opts) => {
				if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-1" } };
				if (opts.url.includes("/im/v1/messages")) return { data: { message_id: "om-card-1" } };
				return { data: {} };
			},
		});
		assert.ok(!sent.some((text) => text.includes("正在处理")), `卡片 + off 不该有进度消息：${JSON.stringify(sent)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L3：思考摘要默认关闭，开启后才显示", async () => {
	const dir = tempDir();
	try {
		const edits: string[] = [];
		const manager = await withManager({ dir, edits, progress: { showThinking: false } });
		const state = await prime(manager);
		state.thinking = "正在分析这段代码";
		manager.onToolEvent("sid-progress", "read", "start", { file_path: "/a" }, "tc-t");
		await settle();
		assert.ok(!lastEdit(edits).includes("正在分析"), `默认关闭时不得展示思考内容：${lastEdit(edits)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }

	const dir2 = tempDir();
	try {
		const edits2: string[] = [];
		const manager2 = await withManager({ dir: dir2, edits: edits2, progress: { showThinking: true } });
		const state2 = await prime(manager2);
		state2.thinking = "正在分析这段代码";
		manager2.onToolEvent("sid-progress", "read", "start", { file_path: "/a" }, "tc-t");
		await settle();
		assert.ok(lastEdit(edits2).includes("💭 正在分析这段代码"), lastEdit(edits2));
	} finally { rmSync(dir2, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 收尾 ----

/** 等条件成立（带超时，避免测试挂死）。 */
async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * 跑一轮完整 run。
 *
 * `prompt()` 被 gate 卡住，直到测试注入完工具事件再放行 —— 否则本地 backend 几乎瞬时返回，
 * 工具事件会落在 run 结束之后（进度状态已删除），测出来的是“没步骤的纯聊天”。
 * subscribe 不吐正文 → final 走新消息，进度消息独立存在（非卡片模式下两者才可能同一条）。
 */
async function runOnce(options: {
	dir: string;
	progress?: Partial<BridgeConfig["progress"]>;
	step?: boolean;
	/** 用 `onToolEvent`（全局钩子退路）注入，而不是订阅回调（生产主路径）。 */
	viaHook?: boolean;
	extra?: Partial<BridgeConfig>;
	rawRequest?: (opts: { url: string; method: string; data?: unknown }) => Promise<unknown>;
	/** 进度消息发出后、工具事件注入前，直接改写进度状态（用于构造「编辑配额已耗尽」等场景）。 */
	onState?: (state: ProgressStateShape) => void;
}): Promise<{ sent: string[]; edited: [string, string][]; recalled: string[]; manager: ConversationManager }> {
	const sent: string[] = [];
	const edited: [string, string][] = [];
	const recalled: string[] = [];
	const subscribers: Array<(ev: unknown) => void> = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const backend: SessionBackend = {
		async createSession() {
			return {
				sessionId: "sid-run", async prompt() { await gate; return "最终答案"; },
				subscribe(handler: (ev: unknown) => void) { subscribers.push(handler); return () => {}; },
				async abort() {}, async dispose() {}, modelId: "m",
			};
		},
	};
	const manager = new ConversationManager({
		config: config({ progress: progressConfig(options.progress), ...options.extra }),
		sessionDir: options.dir, sessionBackend: backend,
		sender: {
			async send(_c: string, text: string) { sent.push(text); return { success: true, messageId: `om_${sent.length}` }; },
		} as never,
		editMessage: async (id: string, text: string) => { edited.push([id, text]); return true; },
		recallMessage: async (id: string) => { recalled.push(id); return true; },
		rawRequest: options.rawRequest,
	});
	(manager as unknown as { progressMinIntervalMs: number }).progressMinIntervalMs = 0;
	await manager.route(message("run-1"));
	if (options.step) {
		// 注意顺序：进度消息先发，`subscribe()` 后注册 —— 必须等订阅就位再注入事件，
		// 否则事件落在没人听的窗口里（这正是“进度不出现”的典型成因之一）。
		await waitUntil(() => sent.length > 0 && subscribers.length > 0);
		if (options.onState) options.onState(stateOf(manager));
		if (options.viaHook) {
			manager.onToolEvent("sid-run", "bash", "start", { command: "echo hi" }, "tc-run");
		} else {
			const ev = { type: "tool_execution_start", toolName: "bash", args: { command: "echo hi" }, toolCallId: "tc-run" };
			for (const notify of subscribers) notify(ev);
		}
		await new Promise((resolve) => setTimeout(resolve, 20)); // 串行写入器落定
	}
	release();
	// 等 run 收尾：要么 final 已投递，要么进度已被撤回
	await waitUntil(() => sent.some((text) => text.includes("最终答案")) || recalled.length > 0);
	await new Promise((resolve) => setTimeout(resolve, 50)); // 终态页脚写入落定
	return { sent, edited, recalled, manager };
}

test("L3：keepOnFinish 默认保留进度并写终态 ✅", async () => {
	const dir = tempDir();
	try {
		const { sent, edited, recalled } = await runOnce({ dir, step: true });
		assert.ok(sent[0].includes("正在处理"), `首条应是进度消息：${JSON.stringify(sent)}`);
		assert.equal(recalled.length, 0, `默认保留，不该撤回：${JSON.stringify(recalled)}`);
		const terminal = edited.map(([, text]) => text).find((text) => text.includes("✅ 完成"));
		assert.ok(terminal, `应写终态页脚：${JSON.stringify(edited)}`);
		assert.ok(terminal!.includes("💻 运行 echo hi"), terminal);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1：订阅回调（生产主路径）就能追加进度行，不依赖 sessionId 匹配", async () => {
	const dir = tempDir();
	try {
		// 真实链路里 tool_execution_start 是随会话订阅到的；全局 `pi.on` 钩子拿不到
		// sessionId 时什么都不会发生 —— 所以主路径必须是订阅回调。
		const { edited } = await runOnce({ dir, step: true });
		assert.ok(edited.some(([, text]) => text.includes("💻 运行 echo hi")), `订阅路径应写入进度：${JSON.stringify(edited)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L1：sessionId 对不上时全局钩子不写进度（有日志，不静默）", async () => {
	const dir = tempDir();
	try {
		const logs: string[] = [];
		const manager = new ConversationManager({
			config: config(), sessionDir: dir,
			sessionBackend: { async createSession() { return null as never; } },
			sender: { async send() { return { success: true, messageId: "om_x" }; } } as never,
			log: (level, message) => { logs.push(`${level}:${message}`); },
		});
		manager.onToolEvent("unknown-sid", "bash", "start", { command: "x" }, "tc-x");
		assert.ok(logs.some((line) => line.includes("feishu.progress.unknown_session")), JSON.stringify(logs));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L3：keepOnFinish=false 时撤回进度消息（旧行为）", async () => {
	const dir = tempDir();
	try {
		const { recalled } = await runOnce({ dir, step: true, progress: { keepOnFinish: false } });
		assert.equal(recalled.length, 1, `应撤回进度消息：${JSON.stringify(recalled)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("L3：没有工具步骤的纯聊天不留下「执行过程」消息", async () => {
	const dir = tempDir();
	try {
		const { sent, recalled } = await runOnce({ dir, step: false });
		assert.ok(sent.some((text) => text.includes("最终答案")), JSON.stringify(sent));
		assert.equal(recalled.length, 1, `纯聊天应撤回进度消息：${JSON.stringify(recalled)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 卡片模式（L1 回归） ----

test("L1：卡片模式下仍然有独立的进度消息（修 'if (!cardMode)' 回归）", async () => {
	const dir = tempDir();
	try {
		const cardCalls: string[] = [];
		const { sent, edited, recalled } = await runOnce({
			dir,
			step: true,
			extra: { streamingCard: { ...DEFAULT_CONFIG.streamingCard, enabled: true, throttleMs: 0 } },
			rawRequest: async (opts) => {
				cardCalls.push(`${opts.method} ${opts.url}`);
				if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-1" } };
				if (opts.url.includes("/im/v1/messages")) return { data: { message_id: "om-card-1" } };
				return { data: {} };
			},
		});
		assert.ok(cardCalls.some((call) => call.includes("cardkit/v1/cards")), `卡片应被创建：${JSON.stringify(cardCalls)}`);
		assert.ok(sent.some((text) => text.includes("正在处理")), `卡片模式下仍应发进度消息：${JSON.stringify(sent)}`);
		assert.ok(edited.some(([, text]) => text.includes("💻 运行 echo hi")), `进度消息应被编辑：${JSON.stringify(edited)}`);
		assert.equal(recalled.length, 0, "默认保留");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 兼容与不变量 ----

test("L2：参数摘要兼容入口仍只取有信息量字段并脱敏", () => {
	assert.equal(summarizeToolArgs("bash", { command: "ls -la" }), "ls -la");
	assert.equal(summarizeToolArgs("read", { file_path: "/workspace/a.ts", extra: 1 }), "/workspace/a.ts");
	assert.equal(summarizeToolArgs("grep", { pattern: "TODO" }), "TODO");
	assert.equal(summarizeToolArgs("bash", undefined), undefined);
	assert.equal(summarizeToolArgs("bash", { command: "   " }), undefined);
	const secret = summarizeToolArgs("bash", { command: "curl -H 'authorization: bearer sk-abcdef' https://x" });
	assert.ok(secret && !secret.includes("sk-abcdef"), `必须脱敏：${secret}`);
});

test("L2：sanitizeCommand 覆盖常见秘密形态", () => {
	assert.ok(!sanitizeCommand("PASSWORD=hunter2 ./run").includes("hunter2"));
	assert.ok(!sanitizeCommand("--token abc123").includes("abc123"));
	assert.ok(sanitizeCommand("npm test").includes("npm test"), "普通命令保持可读");
	assert.ok(sanitizeCommand("x".repeat(500)).length <= 180, "必须截断");
});

test("L1/L3：进度展示开关不影响最终投递", async () => {
	const dir = tempDir();
	try {
		const { sent } = await runOnce({ dir, step: true, progress: { showThinking: true } });
		const finals = sent.filter((text) => text.includes("最终答案"));
		assert.equal(finals.length, 1, `final 必须投递且只投一次：${JSON.stringify(sent)}`);
		assert.ok(!finals[0].includes("正在处理"), "进度不得混进 final");
		assert.ok(sent.some((text) => text.includes("正在处理")), "运行期间应有进度消息（不影响 final）");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 编辑配额（真实链路发现的缺陷） ----

/**
 * 飞书对**同一条消息的编辑次数**有硬上限（官方文档 20 次，超出返回 code 230072
 * "The message has reached the number of times it can be edited"）。
 *
 * 2026-09-21 用真实长时间静默任务复现过：第 20 次编辑后全部被拒，群里表现为耗时页脚冻结、
 * 终态页脚（✅/⏹/⚠️）永远发不出去。下面两条用例锁住修复行为。
 */
test("编辑配额用尽后自动轮换成新进度消息（不再无限编辑同一条）", async () => {
	const dir = tempDir();
	try {
		const edits: [string, string][] = [];
		const sent: string[] = [];
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-cap", async prompt() { return "ok"; },
					subscribe() { return () => {}; }, async abort() {}, async dispose() {}, modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: config(), sessionDir: dir, sessionBackend: backend,
			sender: {
				async send(_c: string, text: string) { sent.push(text); return { success: true, messageId: `om_${sent.length}` }; },
			} as never,
			editMessage: async (id, text) => { edits.push([id, text]); return true; },
		});
		(manager as unknown as { progressMinIntervalMs: number }).progressMinIntervalMs = 0;
		await manager.modelConversation(message("m1"));
		const state = stateOf(manager);
		state.messageId = "om_progress";
		state.replyTo = "om_user";
		state.startedAt = Date.now();

		for (let i = 0; i < 25; i += 1) {
			manager.onToolEvent("sid-cap", "bash", "start", { command: `echo ${i}` }, `tc-${i}`);
			await new Promise((resolve) => setTimeout(resolve, 3));
		}
		const targets = [...new Set(edits.map(([id]) => id))];
		assert.ok(targets.length >= 2, `配额用尽后应轮到新消息，实际只编辑过 ${JSON.stringify(targets)}`);
		assert.ok(sent.length >= 1, "轮换应新发一条进度消息");
		assert.ok(targets[0] === "om_progress", "先编辑原消息");
		assert.ok(!targets.includes(undefined as unknown as string), "不得写入空 messageId");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("编辑配额耗尽时终态页脚也不丢（轮换成新消息写结论）", async () => {
	const dir = tempDir();
	try {
		// 预先把当前消息的编辑配额用满：终态写入必须另发一条，而不是被 230072 吞掉。
		const { sent, edited, recalled } = await runOnce({
			dir, step: true, onState: (state) => { state.edits = 20; },
		});
		const terminalInEdit = edited.some(([, text]) => text.includes("✅ 完成"));
		const terminalInSend = sent.some((text) => text.includes("✅ 完成"));
		assert.ok(terminalInEdit || terminalInSend, `终态页脚必须落地：edits=${JSON.stringify(edited)} sends=${JSON.stringify(sent)}`);
		assert.equal(recalled.length, 0, "keepOnFinish 默认保留");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
