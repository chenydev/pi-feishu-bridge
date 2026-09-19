/**
 * P1-01 CardKit 流式卡片（默认关闭）：
 * - 默认不启用；`streamingCard.enabled` 或环境变量 FEISHU_STREAM_CARD=1 才开；
 * - 创建卡片 → 发送引用 → 节流更新 → 收尾写最终正文；
 * - 任一 API 失败都必须降级（available=false、调用方回落到文本通道），不能抛出打断 run；
 * - 卡片成功承载 final 时必须 ack 接管账本（否则重启会重放成重复任务）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamingCard } from "../src/outbound/streaming-card.js";
import { ConversationManager } from "../src/session/conversation-manager.js";
import { PendingStore } from "../src/session/pending-store.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_CONFIG, type SessionBackend } from "../src/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await tick(5);
	}
}

function recorder(failOn?: (url: string, method: string) => boolean) {
	const calls: Array<{ url: string; method: string; data?: unknown }> = [];
	const request = async (opts: { url: string; method: string; params?: unknown; data?: unknown }) => {
		calls.push({ url: opts.url, method: opts.method, data: opts.data });
		if (failOn?.(opts.url, opts.method)) throw new Error(`boom: ${opts.method} ${opts.url}`);
		if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-1" } };
		if (opts.url.startsWith("/open-apis/im/v1/messages")) return { data: { message_id: "om-card-1" } };
		return { data: {} };
	};
	return { calls, request };
}

test("流式卡片：创建 → 发送引用 → 收尾写最终正文", async () => {
	const { calls, request } = recorder();
	const card = new StreamingCard({ rawRequest: request, throttleMs: 0, now: () => 1_000 });
	const started = await card.start({ chatId: "oc_x", replyTo: "om_src", threadId: "th" }, "处理中…");
	assert.equal(started, true);
	assert.equal(card.available, true);

	// 创建卡片：card_json + streaming_mode
	const create = calls[0]!;
	assert.equal(create.url, "/open-apis/cardkit/v1/cards");
	const payload = JSON.parse(String((create.data as { data: string }).data));
	assert.equal(payload.config.streaming_mode, true, "必须开启：关闭时元素动态更新不生效（实测卡片卡在初始文案）");
	assert.equal(payload.body.elements[0].element_id, "stream", "元素 id 必须与更新路径一致");

	// 发送：交互卡片引用 card_id，并回复原消息
	const send = calls[1]!;
	assert.match(send.url, /\/open-apis\/im\/v1\/messages\/om_src\/reply$/);
	const content = JSON.parse(String((send.data as { content: string }).content));
	assert.deepEqual(content, { type: "card", data: { card_id: "card-1" } });

	card.update("第一段");
	await tick(50);
	card.update("第一段第二段");
	await tick(50);
	const ok = await card.finish("第一段第二段 最终答案");
	assert.equal(ok, true);

	const updates = calls.filter((c) => c.url.includes("/elements/stream/content"));
	assert.ok(updates.length >= 2, "至少有一次增量更新 + 最终更新");
	assert.equal(updates[0]!.method, "PUT", "元素内容更新用 PUT");
	// 并发写入下不保证到达顺序，但 finish 会 drain 后再写最终内容，
	// 所以按 sequence 最大的那次必须是完整正文。
	const bySeq = updates.map((c) => c.data as { content: string; sequence: number }).sort((a, b) => a.sequence - b.sequence);
	assert.equal(bySeq.at(-1)!.content, "第一段第二段 最终答案", "最大 sequence 必须承载完整正文");
	for (const item of bySeq) assert.ok(typeof item.sequence === "number", "应带单调 sequence");
});

test("流式卡片：创建失败返回 false 且不再尝试更新（降级不抛出）", async () => {
	const { request } = recorder((url) => url === "/open-apis/cardkit/v1/cards");
	const card = new StreamingCard({ rawRequest: request, throttleMs: 0, now: () => 0 });
	const started = await card.start({ chatId: "oc_x" });
	assert.equal(started, false, "创建失败必须返回 false");
	assert.equal(card.available, false);
	card.update("任何内容");       // 不应抛出
	assert.equal(await card.finish("最终"), false, "不可用时 finish 必须返回 false 让调用方兜底");
});

test("流式卡片：更新阶段失败后转为不可用（最终仍返回 false）", async () => {
	let failUpdates = false;
	const { request } = recorder((url) => failUpdates && url.includes("/elements/stream/content"));
	const card = new StreamingCard({ rawRequest: request, throttleMs: 0, now: () => 0 });
	await card.start({ chatId: "oc_x" });
	failUpdates = true;
	card.update("会失败的一段");
	await tick(50);
	assert.equal(card.available, false, "更新失败后应标记不可用");
	assert.equal(await card.finish("最终"), false, "连最终写入也失败时返回 false");
});

test("流式卡片：节流合并连续增量 + 写入串行（不逐 token、不并发打 API）", async () => {
	const { calls, request } = recorder();
	const card = new StreamingCard({ rawRequest: request, throttleMs: 50, now: Date.now });
	await card.start({ chatId: "oc_x" });
	const before = calls.filter((c) => c.url.includes("/elements/stream/content")).length;
	for (let i = 1; i <= 20; i += 1) card.update("x".repeat(i));
	await tick(120);
	const after = calls.filter((c) => c.url.includes("/elements/stream/content")).length;
	assert.ok(after - before <= 3, `20 次增量应合并为很少的请求，实际 ${after - before}`);
});

test("流式卡片：abandon 写入中止说明并停止更新", async () => {
	const { calls, request } = recorder();
	const card = new StreamingCard({ rawRequest: request, throttleMs: 0, now: () => 0 });
	await card.start({ chatId: "oc_x" });
	await card.abandon("任务已中止");
	const updates = calls.filter((c) => c.url.includes("/elements/stream/content"));
	assert.equal((updates.at(-1)!.data as { content: string }).content, "任务已中止");
	assert.equal(card.available, false);
});

test("开关默认关闭：未配置时 enabled=false", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-card-"));
	// 真实路径是 <homeDir>/feishu-bridge/config.json（resolvePaths 会加一层 feishu-bridge）
	const cfgDir = join(dir, "feishu-bridge");
	mkdirSync(cfgDir, { recursive: true });
	try {
		writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
			appId: "cli_x", appSecret: "s".repeat(32), domain: "feishu",
			groupPolicy: "mention", allowUsers: [], allowChats: ["oc_x"], admins: [],
		}));
		const cfg = loadConfig(dir, {});
		assert.equal(cfg.streamingCard?.enabled, false, "默认必须关闭（需要显式开启）");

		// 显式配置打开
		writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
			appId: "cli_x", appSecret: "s".repeat(32), domain: "feishu",
			groupPolicy: "mention", allowUsers: [], allowChats: ["oc_x"], admins: [],
			streamingCard: { enabled: true, throttleMs: 500 },
		}));
		const on = loadConfig(dir, {});
		assert.equal(on.streamingCard?.enabled, true);
		assert.equal(on.streamingCard?.throttleMs, 500);

		// 环境变量优先（容器里临时实验用）
		assert.equal(loadConfig(dir, { FEISHU_STREAMING_CARD: "1" }).streamingCard?.enabled, true);
		writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
			appId: "cli_x", appSecret: "s".repeat(32), domain: "feishu",
			groupPolicy: "mention", allowUsers: [], allowChats: ["oc_x"], admins: [],
			streamingCard: { enabled: true, throttleMs: 500 },
		}));
		assert.equal(loadConfig(dir, { FEISHU_STREAMING_CARD: "0" }).streamingCard?.enabled, false, "环境变量 0 应强制关闭");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("P1-01：卡片承载 final 后必须 ack 接管账本（否则重启会重放成重复任务）", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-card-pending-"));
	const pendingFile = join(dir, "pending.jsonl");
	try {
		const calls: string[] = [];
		const rawRequest = async (opts: { url: string; method: string; data?: unknown }) => {
			calls.push(`${opts.method} ${opts.url}`);
			if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-1" } };
			if (opts.url.startsWith("/open-apis/im/v1/messages")) return { data: { message_id: "om-card-1" } };
			return { data: {} };
		};
		const sentTexts: string[] = [];
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-card",
					async prompt() { return "最终答案"; },
					subscribe: () => () => {},
					async abort() {},
					async dispose() {},
					modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: {
				...DEFAULT_CONFIG,
				streamingCard: { enabled: true, throttleMs: 0 },
				footer: { enabled: false, showCost: false },
				reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
			},
			sessionDir: join(dir, "sessions"),
			pendingFile,
			sessionBackend: backend,
			sender: {
				async send(_chatId: string, text: string) {
					sentTexts.push(text);
					return { success: true, messageId: "om-text" };
				},
			} as never,
			rawRequest,
		});
		await manager.route({
			messageId: "om-card-final", chatId: "oc_chat", chatType: "p2p",
			senderId: "ou_user", isBot: false, msgType: "text", text: "prompt",
			mentions: [], resources: [], raw: undefined, ts: Date.now(),
		});
		await waitUntil(() => calls.some((call) => call.includes("/elements/stream/content")));
		await waitUntil(() => new PendingStore(pendingFile).depth() === 0);
		assert.equal(sentTexts.length, 0, "卡片交付成功后不应再发重复文本");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("写入必须串行：并发的 update 不会重叠发出（并发会让飞书丢弃后续内容）", async () => {
	const order: string[] = [];
	let concurrent = 0;
	let maxConcurrent = 0;
	const request = async (opts: { url: string; method: string; data?: unknown }) => {
		if (opts.url === "/open-apis/cardkit/v1/cards") return { data: { card_id: "card-1" } };
		if (opts.url.startsWith("/open-apis/im/v1/messages")) return { data: { message_id: "om-1" } };
		if (opts.url.includes("/elements/stream/content")) {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			order.push((opts.data as { content: string }).content);
			await tick(30);
			concurrent -= 1;
		}
		return { data: {} };
	};
	const card = new StreamingCard({ rawRequest: request, throttleMs: 0, now: Date.now });
	await card.start({ chatId: "oc_x" });
	// 连续触发多次写入（节流会合并，但至少要有多次真实写入来检验串行）
	card.update("a");
	await tick(1250);
	card.update("ab");
	await tick(1250);
	await card.finish("abc");
	assert.equal(maxConcurrent, 1, `同卡片写入不得并发，实测最大并发 ${maxConcurrent}`);
	assert.deepEqual(order, ["a", "ab", "abc"], "写入必须按调用顺序落地");
});
