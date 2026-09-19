/**
 * P0-08 离线可靠性矩阵：用真实桥组件（pipeline / manager / sender / outbox / 账本）
 * 加 Fake 飞书 transport 与 Fake session backend，覆盖跨组件的端到端链路。
 *
 * 覆盖点：
 * - M6 限频：429 + Retry-After 必须等满服务端要求再重试，最终送达；
 * - M7 端到端：飞书消息 → 会话执行 → durable final 送达，且同一 dedupeKey 只投一次；
 * - M8 崩溃恢复：outbox 入队后进程退出，新实例接管并投递（at-least-once，不静默丢）；
 * - M9 权限错误：403 不得被当成可降级转发，直接判失败（不放大请求）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InboundPipeline } from "../../src/inbound/pipeline.js";
import { DedupeStore } from "../../src/inbound/dedupe-store.js";
import { LastSentCache } from "../../src/inbound/admit.js";
import { ConversationManager } from "../../src/session/conversation-manager.js";
import { Sender, type PreparedSend } from "../../src/outbound/sender.js";
import { Outbox } from "../../src/outbound/outbox.js";
import { DEFAULT_CONFIG, type BridgeConfig, type FeishuInboundMessage, type SessionBackend } from "../../src/types.js";

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG,
		reaction: { ...DEFAULT_CONFIG.reaction, enabled: false },
		footer: { enabled: false, showCost: false },
		batch: { ...DEFAULT_CONFIG.batch, enabled: false },
		...over,
	};
}

function message(messageId: string, text = "你好"): FeishuInboundMessage {
	return {
		messageId,
		chatId: "oc_real_chat",
		chatType: "p2p",
		senderId: "ou_user",
		isBot: false,
		msgType: "text",
		text,
		mentions: [],
		resources: [],
		raw: undefined,
		ts: Date.now(),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitUntil timeout");
		await new Promise((resolve) => setTimeout(resolve, 3));
	}
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

interface RecordedRequest {
	url: string;
	method: string;
	data?: unknown;
}

/** 可控 Fake 飞书 API：可注入一次性失败（限频 / 权限），成功时返回 message_id。 */
class FakeFeishu {
	requests: RecordedRequest[] = [];
	scripted: Array<{ code: number; status?: number; times: number; headers?: Record<string, string>; message?: string }> = [];

	async rawRequest(opts: RecordedRequest): Promise<unknown> {
		this.requests.push(opts);
		const rule = this.scripted.find((item) => item.times > 0);
		if (rule) {
			rule.times -= 1;
			if (rule.status !== undefined) {
				const error = new Error(rule.message ?? `HTTP ${rule.status}`);
				(error as { response?: unknown }).response = {
					status: rule.status,
					headers: rule.headers,
					data: { code: rule.code, msg: rule.message ?? `HTTP ${rule.status}` },
				};
				throw error;
			}
			return { code: rule.code, msg: rule.message ?? `code ${rule.code}` };
		}
		return { code: 0, data: { message_id: `om_${this.requests.length}` } };
	}

	async getMessageText(): Promise<string | undefined> {
		return "被回复原文";
	}

	async downloadResource(): Promise<unknown> {
		return { data: Buffer.from(""), contentType: "application/octet-stream" };
	}

	sentTexts(): string[] {
		return this.requests
			.map((request) => {
				const data = request.data as { content?: string } | undefined;
				if (!data?.content) return undefined;
				try {
					const parsed = JSON.parse(data.content) as { text?: string };
					return parsed.text;
				} catch { return undefined; }
			})
			.filter((text): text is string => typeof text === "string");
	}
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-feishu-matrix-"));
}

test("M6 限频：按 Retry-After 等待后才重试，最终送达", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "outbox.jsonl");
		const attemptTimes: number[] = [];
		const outbox = new Outbox({
			file,
			prepare: (chatId, content) => [{
				chatId,
				msgType: "text",
				payload: JSON.stringify({ text: content }),
				plainTextPayload: JSON.stringify({ text: content }),
				opts: {},
				uuid: `uuid-${content}`,
				contentFallbackUuid: `content-${content}`,
				routeFallbackUuid: `route-${content}`,
			}] as PreparedSend[],
			send: async () => {
				attemptTimes.push(Date.now());
				if (attemptTimes.length === 1) {
					// 模拟 sender 已归一化的限频结果
					return { success: false, error: "429: rate limited", retryable: true, retryAfterMs: 400, errorClass: "rate_limited" };
				}
				return { success: true, messageId: "om_ok" };
			},
			random: () => 0.5,
			backoffMs: 10,
		});

		outbox.enqueue("oc_real_chat", "最终回答", {}, { dedupeKey: "m6:final", laneKey: "lane", kind: "final" });
		outbox.start();
		await waitUntil(() => attemptTimes.length === 1);

		// retry-after 未到：不得重试（指数退避仅 10ms，真正生效的必须是服务端要求）
		await tick(150);
		assert.equal(attemptTimes.length, 1, "必须等满服务端 retry-after 才重试");

		await waitUntil(() => attemptTimes.length === 2, 3_000);
		assert.ok(
			attemptTimes[1] - attemptTimes[0] >= 400,
			`重试间隔不得短于 retry-after，实际 ${attemptTimes[1] - attemptTimes[0]}ms`,
		);
		await waitUntil(() => outbox.stats().sent === 1);
		await outbox.stop();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M7 端到端：飞书消息 → 会话执行 → durable final 送达且只投一次", async () => {
	const dir = tempDir();
	try {
		const feishu = new FakeFeishu();
		const bridgeConfig = config();
		const sender = new Sender({ config: bridgeConfig, transport: feishu as never });
		const outbox = new Outbox({
			file: join(dir, "outbox.jsonl"),
			prepare: (chatId, content, opts) => sender.prepare(chatId, content, opts),
			send: (request, checkpoint) => sender.sendPrepared(request, checkpoint),
		});
		const backend: SessionBackend = {
			async createSession() {
				return {
					sessionId: "sid-e2e",
					async prompt() { return "这是最终回答"; },
					subscribe() { return () => {}; },
					async abort() {},
					async dispose() {},
					modelId: "m",
				};
			},
		};
		const manager = new ConversationManager({
			config: bridgeConfig,
			sessionDir: dir,
			sessionBackend: backend,
			sender: sender as never,
			durableOutbox: outbox,
			pendingFile: join(dir, "pending.jsonl"),
			conversationFile: join(dir, "conversations.jsonl"),
		});
		const pipeline = new InboundPipeline({
			config: bridgeConfig,
			transport: feishu as never,
			lastSent: new LastSentCache(8),
			dedupeStore: new DedupeStore({ file: join(dir, "dedupe.jsonl"), capacity: 64, ttlMs: 60_000 }),
			intake: manager.intakeLedger(),
			onDispatch: async (msg) => { await manager.route(msg); },
		});

		outbox.start();
		await pipeline.handle(message("m7-1"));
		await waitUntil(() => feishu.sentTexts().some((text) => text.includes("这是最终回答")));
		await tick(30);

		const finals = feishu.sentTexts().filter((text) => text.includes("这是最终回答"));
		assert.equal(finals.length, 1, "final 必须只投递一次");
		assert.equal(outbox.stats().sent, 1);
		assert.equal(manager.intakeLedger()?.has("m7-1"), false, "完成后账本必须清空该消息（终态可对账）");

		// 平台重投同一 messageId：不得产生第二次投递
		await pipeline.handle(message("m7-1"));
		await tick(50);
		assert.equal(feishu.sentTexts().filter((text) => text.includes("这是最终回答")).length, 1, "重投必须被去重");
		await outbox.stop();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M8 崩溃恢复：outbox 入队后进程退出，新实例接管并投递", async () => {
	const dir = tempDir();
	try {
		const file = join(dir, "outbox.jsonl");
		const first = new Outbox({
			file,
			prepare: (chatId, content) => [{
				chatId,
				msgType: "text",
				payload: JSON.stringify({ text: content }),
				plainTextPayload: JSON.stringify({ text: content }),
				opts: {},
				uuid: `uuid-${content}`,
				contentFallbackUuid: `content-${content}`,
				routeFallbackUuid: `route-${content}`,
			}] as PreparedSend[],
			send: async () => ({ success: true, messageId: "om_first" }),
		});
		// 只入队，不 start（模拟进程在投递前退出）
		first.enqueue("oc_real_chat", "崩溃前的回答", {}, { dedupeKey: "m8:final", laneKey: "lane", kind: "final" });
		assert.equal(first.stats().pending, 1);

		// 新实例（同文件）接管
		const delivered: string[] = [];
		const second = new Outbox({
			file,
			prepare: (chatId, content) => [{
				chatId,
				msgType: "text",
				payload: JSON.stringify({ text: content }),
				plainTextPayload: JSON.stringify({ text: content }),
				opts: {},
				uuid: `uuid-${content}`,
				contentFallbackUuid: `content-${content}`,
				routeFallbackUuid: `route-${content}`,
			}] as PreparedSend[],
			send: async (request) => {
				// uuid 在 request 顶层（不在 payload 内），跨进程必须保持一致（幂等键）
				delivered.push((request as { uuid?: string }).uuid ?? "");
				return { success: true, messageId: "om_second" };
			},
		});
		assert.equal(second.stats().pending, 1, "未投递条目必须跨进程保留");
		second.start();
		await waitUntil(() => second.stats().sent === 1);
		assert.equal(delivered.length, 1, "恢复后必须补投且只投一次");
		// UUID 保持稳定：重试不应换 uuid（幂等保证）
		assert.ok(delivered[0].includes("uuid-崩溃前的回答"), `恢复必须沿用原 UUID（幂等），实际 ${delivered[0]}`);
		await second.stop();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M9 权限错误：403 判为致命失败，不重试也不降级转发", async () => {
	const dir = tempDir();
	try {
		const feishu = new FakeFeishu();
		feishu.scripted.push({ code: 230013, status: 403, times: 10, message: "permission denied" });
		const bridgeConfig = config();
		const sender = new Sender({ config: bridgeConfig, transport: feishu as never });
		const outbox = new Outbox({
			file: join(dir, "outbox.jsonl"),
			prepare: (chatId, content, opts) => sender.prepare(chatId, content, opts),
			send: (request, checkpoint) => sender.sendPrepared(request, checkpoint),
			backoffMs: 5,
			maxAttempts: 5,
		});
		outbox.enqueue("oc_real_chat", "权限失败的回答", {}, { dedupeKey: "m9:final", laneKey: "lane", kind: "final" });
		outbox.start();
		await waitUntil(() => outbox.stats().failed === 1 || outbox.stats().sent === 1, 3_000);

		const stats = outbox.stats();
		assert.equal(stats.sent, 0, "权限失败不得报告成功");
		assert.equal(stats.failed, 1, "权限失败应进入终态 failed（可见，不伪装成已投递）");
		assert.equal(feishu.requests.length, 1, "权限错误不得放大请求（不重试、不降级重发）");
		await outbox.stop();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
