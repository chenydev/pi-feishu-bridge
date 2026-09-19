/**
 * P0-07 API 错误统一归一化（表驱动）：
 * throw 形态与 return 形态都要覆盖 HTTP status、业务码、body/header retry-after，
 * 并且权限类失败不得被判成"允许路由回退"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isReplyFallbackCode,
	normalizeApiError,
	normalizeApiResponse,
	parseRetryAfter,
} from "../src/outbound/api-errors.js";

const NOW = Date.parse("2026-09-19T00:00:00Z");

test("P0-07：Retry-After 解析支持秒数、HTTP-date 与异常输入", () => {
	assert.equal(parseRetryAfter(2, NOW), 2_000, "数值按秒");
	assert.equal(parseRetryAfter("2", NOW), 2_000, "字符串数值按秒");
	assert.equal(parseRetryAfter(5_000, NOW), 5_000, "超大数值按毫秒容错");
	assert.equal(
		parseRetryAfter(new Date(NOW + 3_000).toUTCString(), NOW),
		3_000,
		"HTTP-date 计算差值",
	);
	assert.equal(parseRetryAfter(new Date(NOW - 5_000).toUTCString(), NOW), 0, "过去时间视为立即可重试");
	assert.equal(parseRetryAfter(undefined, NOW), undefined);
	assert.equal(parseRetryAfter("not-a-date", NOW), undefined);
	assert.equal(parseRetryAfter(0, NOW), undefined);
});

test("P0-07：限频（HTTP 429 / body code / hint）统一识别且带 retry-after", () => {
	const byStatus = normalizeApiError({
		message: "Too Many Requests",
		response: { status: 429, headers: { "Retry-After": "2" } },
	}, NOW);
	assert.equal(byStatus.errorClass, "rate_limited");
	assert.equal(byStatus.retryable, true);
	assert.equal(byStatus.retryAfterMs, 2_000);

	const byDate = normalizeApiError({
		response: { status: 429, headers: { "retry-after": new Date(NOW + 7_000).toUTCString() } },
	}, NOW);
	assert.equal(byDate.retryAfterMs, 7_000, "header 名大小写不敏感");

	const byBody = normalizeApiError({
		response: { status: 200, data: { code: 99991400, msg: "request rate limit exceeded" } },
	}, NOW);
	assert.equal(byBody.errorClass, "rate_limited");
	assert.equal(byBody.retryable, true);

	const byBodyField = normalizeApiResponse({ code: 12345, msg: "slow down", retry_after: 3 }, NOW);
	assert.equal(byBodyField.errorClass, "rate_limited", "未知码 + retry_after 应判为限频");
	assert.equal(byBodyField.retryAfterMs, 3_000);

	const byHint = normalizeApiError({ message: "请求过于频繁，请稍后重试" }, NOW);
	assert.equal(byHint.errorClass, "rate_limited");
});

test("P0-07：5xx 与网络错误可重试", () => {
	const server = normalizeApiError({ response: { status: 503, data: { msg: "service unavailable" } } }, NOW);
	assert.equal(server.errorClass, "server");
	assert.equal(server.retryable, true);

	const network = normalizeApiError({ message: "socket hang up ECONNRESET" }, NOW);
	assert.equal(network.errorClass, "network");
	assert.equal(network.retryable, true);

	const timeout = normalizeApiError({ message: "request timeout" }, NOW);
	assert.equal(timeout.errorClass, "network");
	assert.equal(timeout.retryable, true);
});

test("P0-07：权限类失败不可重试、也不允许当成路由回退", () => {
	const forbidden = normalizeApiError({
		message: "forbidden",
		response: { status: 403, data: { code: 230013, msg: "permission denied" } },
	}, NOW);
	assert.equal(forbidden.errorClass, "permission");
	assert.equal(forbidden.retryable, false);
	assert.equal(isReplyFallbackCode(forbidden.code), false, "403 不得触发 reply→create 转发");

	const unauthorized = normalizeApiError({ response: { status: 401 } }, NOW);
	assert.equal(unauthorized.errorClass, "auth");
	assert.equal(unauthorized.retryable, false);
});

test("P0-07：目标不可用（撤回/失效）走 not_found/unavailable 且允许路由回退", () => {
	const missing = normalizeApiError({ response: { status: 404, data: { msg: "message not found" } } }, NOW);
	assert.equal(missing.errorClass, "not_found");

	for (const code of [230003, 230004, 230005, 230007, 230008, 230018, 1001002]) {
		const normalized = normalizeApiResponse({ code, msg: "message unavailable" }, NOW);
		assert.equal(normalized.errorClass, "unavailable", `code ${code} 应为 unavailable`);
		assert.equal(normalized.retryable, false);
		assert.equal(isReplyFallbackCode(code), true, `code ${code} 应允许路由回退`);
	}
	assert.equal(isReplyFallbackCode(230013), false, "权限类码不得回退");
});

test("P0-07：内容/参数被拒可判为需降级重发", () => {
	const badContent = normalizeApiResponse({ code: 230001, msg: "invalid post content format" }, NOW);
	assert.equal(badContent.errorClass, "content_rejected");
	assert.equal(badContent.retryable, false);

	const http400 = normalizeApiError({ response: { status: 400, data: { msg: "bad request" } } }, NOW);
	assert.equal(http400.errorClass, "content_rejected");
});

test("P0-07：未知错误保守可重试（交由 outbox 次数上限兜底）", () => {
	const unknown = normalizeApiError({ message: "something weird happened" }, NOW);
	assert.equal(unknown.errorClass, "unknown");
	assert.equal(unknown.retryable, true, "未知错误宁可多试一次，也不静默丢弃");
	assert.ok(unknown.message.includes("something weird"));
});

test("P0-07：return 形态同样解析 retry_after 与业务码", () => {
	const res = normalizeApiResponse({ code: 99991663, msg: "internal error", retry_after: 1 }, NOW);
	assert.equal(res.code, 99991663);
	assert.equal(res.retryAfterMs, 1_000);
	assert.equal(res.status, undefined);
	assert.equal(res.retryable, true);
});

test("P0-07：消息文本兜底不产生空串", () => {
	const empty = normalizeApiError({ response: { status: 500 } }, NOW);
	assert.ok(empty.message.length > 0);
	const emptyBody = normalizeApiResponse({ code: 42 }, NOW);
	assert.ok(emptyBody.message.length > 0);
});
