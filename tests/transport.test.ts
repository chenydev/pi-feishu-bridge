import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { FeishuTransport, type LarkSdkLike } from "../src/inbound/transport.js";
import { DEFAULT_CONFIG } from "../src/types.js";

interface WsOptions {
	onReady?: () => void;
	onError?: (error: unknown) => void;
}

function fakeSdk(historyItems: unknown[] = [], resource = Buffer.from("resource")) {
	const requests: Array<{ url: string; method: string; params?: unknown }> = [];
	const sockets: FakeWs[] = [];
	const handlers: Record<string, (data: unknown) => unknown> = {};
	class FakeClient {
		im = { v1: {
			messageResource: { get: async () => ({ getReadableStream: () => Readable.from([resource]), headers: { "content-type": "image/png", "content-length": String(resource.length) } }) },
			image: { create: async () => ({ data: { image_key: "img_uploaded" } }) },
			file: { create: async () => ({ file_key: "file_uploaded" }) },
		} };
		constructor(_opts: unknown) {}
		async request(opts: { url: string; method: string; params?: unknown }) {
			requests.push(opts);
			if (opts.url === "/open-apis/bot/v3/info") return { bot: { open_id: "ou_bot", bot_name: "Bot" } };
			if (opts.url === "/open-apis/im/v1/messages") return { data: { items: historyItems } };
			return { code: 0 };
		}
	}
	class FakeDispatcher {
		constructor(_opts?: unknown) {}
		register(next: Record<string, (data: unknown) => unknown>) { Object.assign(handlers, next); return this; }
	}
	class FakeWs {
		status: string | { state: string } = "idle";
		closed = 0;
		constructor(readonly opts: WsOptions) { sockets.push(this); }
		start() { this.status = "connected"; this.opts.onReady?.(); }
		close() { this.closed += 1; this.status = "idle"; }
		getConnectionStatus() { return this.status; }
	}
	const sdk = {
		Domain: { Feishu: "feishu", Lark: "lark" },
		Client: FakeClient,
		WSClient: FakeWs,
		EventDispatcher: FakeDispatcher,
	} as unknown as LarkSdkLike;
	return { sdk, requests, sockets, handlers };
}

function transport(sdk: LarkSdkLike, over: { now?: () => number; statuses?: string[]; onCardAction?: (action: import("../src/inbound/transport.js").CardAction) => Promise<unknown> } = {}) {
	return new FeishuTransport({
		config: { ...DEFAULT_CONFIG, appId: "app", appSecret: "secret" },
		sdk,
		onMessage: async () => {},
		onStatus: (state) => over.statuses?.push(state),
		onCardAction: over.onCardAction,
		now: over.now,
	});
}

test("transport：并发 reconnect 只创建一个新 WS 生命周期", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	assert.equal(fake.sockets.length, 1);
	await Promise.all([instance.reconnect(), instance.reconnect(), instance.reconnect()]);
	assert.equal(fake.sockets.length, 2);
	assert.equal(fake.sockets[0].closed, 1);
	assert.equal(instance.isConnected(), true);
});

test("transport：显式 stop 可使并发 reconnect 失效，不会停止后复活 WS", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	const reconnecting = instance.reconnect();
	await instance.stop();
	await reconnecting;
	assert.equal(instance.isRunning(), false);
	assert.equal(instance.isConnected(), false);
	assert.equal(fake.sockets.length, 1);
});

test("transport：downSince 首次断线固定，ready 后清除", async () => {
	let now = 100;
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { now: () => now, statuses });
	await instance.start();
	fake.sockets[0].opts.onError?.(new Error("down"));
	assert.equal(instance.getDownSince(), 100);
	now = 200;
	fake.sockets[0].opts.onError?.(new Error("still down"));
	assert.equal(instance.getDownSince(), 100);
	await instance.reconnect();
	assert.equal(instance.getDownSince(), undefined);
	assert.deepEqual(statuses, ["connected", "error", "error", "connected"]);
});

test("transport：SDK 静默掉线可由 getConnectionStatus 探测", async () => {
	let now = 300;
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { now: () => now, statuses });
	await instance.start();
	fake.sockets[0].status = "idle";
	assert.equal(instance.isConnected(), false);
	assert.equal(instance.getDownSince(), 300);
	assert.equal(statuses.at(-1), "error");
});

test("transport：兼容 SDK 对象形式的连接状态", async () => {
	const statuses: string[] = [];
	const fake = fakeSdk();
	const instance = transport(fake.sdk, { statuses });
	await instance.start();
	fake.sockets[0].status = { state: "connected" };
	assert.equal(instance.isConnected(), true);
	assert.equal(statuses.at(-1), "connected");
	fake.sockets[0].status = { state: "failed" };
	assert.equal(instance.isConnected(), false);
	assert.equal(statuses.at(-1), "error");
});

test("transport：按 chat 有界拉取历史并映射为标准消息", async () => {
	const fake = fakeSdk([{
		message_id: "om_history",
		chat_id: "oc_chat",
		chat_type: "group",
		msg_type: "text",
		body: { content: JSON.stringify({ text: "补收消息" }) },
		sender: { id: "ou_user", id_type: "open_id", sender_type: "user" },
		parent_id: "om_parent",
		thread_id: "om_thread",
	}]);
	const instance = transport(fake.sdk);
	await instance.start();
	const messages = await instance.listChatHistory("oc_chat", 1_500, 9_100, 100);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].messageId, "om_history");
	assert.equal(messages[0].senderId, "ou_user");
	assert.equal(messages[0].text, "补收消息");
	assert.equal(messages[0].threadId, "om_thread");
	const historyRequest = fake.requests.find((request) => request.url === "/open-apis/im/v1/messages");
	assert.deepEqual(historyRequest?.params, {
		container_id_type: "chat_id",
		container_id: "oc_chat",
		start_time: "1",
		end_time: "10",
		sort_type: "ByCreateTimeAsc",
		page_size: 50,
	});
});

test("transport：下载资源校验声明与实际大小", async () => {
	const fake = fakeSdk([], Buffer.from([1, 2, 3]));
	const instance = transport(fake.sdk);
	await instance.start();
	const downloaded = await instance.downloadResource({ kind: "image", key: "img", messageId: "om" }, 3);
	assert.deepEqual(downloaded.buffer, Buffer.from([1, 2, 3]));
	assert.equal(downloaded.mimeType, "image/png");
	await assert.rejects(() => instance.downloadResource({ kind: "image", key: "img", messageId: "om" }, 2), /resource too large/);
});

test("transport：图片与文件上传返回资源 key", async () => {
	const fake = fakeSdk();
	const instance = transport(fake.sdk);
	await instance.start();
	assert.equal(await instance.uploadImage(Buffer.from("image")), "img_uploaded");
	assert.equal(await instance.uploadFile("report.pdf", Buffer.from("file")), "file_uploaded");
});

test("transport：card.action.trigger 规范化 message/chat/operator/value", async () => {
	const fake = fakeSdk();
	let captured: unknown;
	const instance = transport(fake.sdk, { onCardAction: async (action) => { captured = action; return { toast: { content: "ok" } }; } });
	await instance.start();
	const response = await fake.handlers["card.action.trigger"]?.({
		context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
		operator: { open_id: "ou_admin" }, action: { value: { op: "approval", approvalId: "a" } },
	});
	assert.deepEqual(captured, { messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", value: { op: "approval", approvalId: "a" } });
	assert.deepEqual(response, { toast: { content: "ok" } });
});
