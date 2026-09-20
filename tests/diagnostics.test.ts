/**
 * P2-04 可解释诊断与脱敏导出：
 * - doctor 区分「有积压」「有错误分类」「限流冷却」「待审批」；
 * - 权限范围在未探测时写「未验证」，不假装通过；
 * - 导出只含计数与枚举（不含密钥/正文/路径），文件 0600；
 * - 诊断本身是只读的：不重投 failed、不发送测试消息。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor, formatDoctor } from "../src/runtime/doctor.js";
import { buildDiagnosticsBundle, writeDiagnosticsBundle } from "../src/runtime/diagnostics.js";
import { DEFAULT_CONFIG, type BridgeConfig } from "../src/types.js";

function config(): BridgeConfig {
	return { ...DEFAULT_CONFIG, allowChats: ["oc_group", "oc_chat", "oc_x", "oc_real_chat", "oc_a", "oc_b", "oc_g", "oc_y", "oc_other", "oc_ok"], appId: "cli_test", appSecret: "super-secret-value", admins: ["ou_admin"] };
}

function paths(dir: string) {
	return {
		homeDir: dir, configFile: join(dir, "config.json"), outboxFile: join(dir, "outbox.jsonl"),
		dedupeFile: join(dir, "dedupe.jsonl"), pendingFile: join(dir, "pending.jsonl"), sessionDir: dir,
	} as never;
}

test("P2-04：诊断区分积压、错误类别、限流冷却与待审批", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-diag-"));
	try {
		const checks = runDoctor({
			config: config(), paths: paths(dir),
			transport: { isRunning: () => true, isConnected: () => true, getBotIdentity: () => ({ openId: "ou_bot" }) },
			diagnostics: {
				lastErrorClass: "rate_limited",
				outbox: { pending: 3, failed: 1, oldestAgeMs: 65_000 },
				pendingApprovals: 2,
				budget: { open: true, resumeAt: Date.now() + 20_000, failures: 3 },
				piVersion: "0.85.1",
			},
		});
		const text = formatDoctor(checks);
		assert.ok(text.includes("backlog"), text);
		assert.ok(text.includes("pending 3 / failed 1"), text);
		assert.ok(text.includes("error_state") && text.includes("rate_limited"), text);
		assert.ok(text.includes("rate_budget") && text.includes("final/审批不受影响"), text);
		assert.ok(text.includes("pending_work") && text.includes("2 个审批"), text);
		assert.ok(text.includes("Pi 0.85.1"), text);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-04：权限范围必须显示「未验证」，不得假通过", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-diag-"));
	try {
		const checks = runDoctor({
			config: config(), paths: paths(dir),
			transport: { isRunning: () => true, isConnected: () => true, getBotIdentity: () => ({ openId: "ou_bot" }) },
		});
		const scope = checks.find((check) => check.name === "feishu_scopes");
		assert.ok(scope, "必须有权限范围检查项");
		assert.equal(scope!.ok, false, "未探测时不得报告通过");
		assert.ok(scope!.detail.includes("未验证"), scope!.detail);
		assert.ok(scope!.detail.includes("不会发送测试消息"), scope!.detail);
		// 缺诊断上下文时，相关项不应出现（而不是显示假的 0）
		assert.equal(checks.some((check) => check.name === "backlog"), false, "无上下文时不得编造积压数据");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-04：导出包只含计数与枚举，敏感信息全部剔除", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-diag-"));
	try {
		const bundle = buildDiagnosticsBundle({
			config: config(),
			context: {
				lastErrorClass: "network",
				outbox: { pending: 1, failed: 0, sending: 0, oldestAgeMs: 1_500 },
				conversations: 4, pendingApprovals: 0,
				budget: { open: false, failures: 0 },
				piVersion: "0.85.1", transport: { running: true, connected: true },
			},
			checks: runDoctor({ config: config(), paths: paths(dir), transport: undefined }),
			redactPaths: [dir],
		});
		const serialized = JSON.stringify(bundle);
		assert.ok(!serialized.includes("super-secret-value"), "绝不得包含 appSecret");
		assert.ok(!serialized.includes("cli_test"), "绝不得包含 appId");
		assert.ok(!serialized.includes(dir), "绝不得包含绝对路径");
		assert.ok(serialized.includes("redaction"), "必须声明脱敏范围");
		assert.equal(bundle.state.outbox.pending, 1);
		assert.equal(bundle.state.transport.connected, true);

		const target = writeDiagnosticsBundle(dir, bundle);
		const file = join(target, `diagnostics-${bundle.generatedAt.replace(/[:.]/g, "-")}.json`);
		const written = readFileSync(file, "utf8");
		assert.ok(written.includes("\"redaction\""));
		const mode = statSync(file).mode & 0o777;
		assert.equal(mode, 0o600, `导出文件必须 0600，实际 ${mode.toString(8)}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P2-04：正常状态不误报（无错误、无积压、无冷却）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-diag-"));
	try {
		const checks = runDoctor({
			config: config(), paths: paths(dir),
			transport: { isRunning: () => true, isConnected: () => true, getBotIdentity: () => ({ openId: "ou_bot" }) },
			diagnostics: { outbox: { pending: 0, failed: 0, oldestAgeMs: 0 }, budget: { open: false, failures: 0 }, pendingApprovals: 0 },
		});
		const backlog = checks.find((check) => check.name === "backlog");
		assert.equal(backlog?.ok, true, "无积压应通过");
		assert.equal(checks.find((check) => check.name === "error_state")?.ok, true);
		assert.equal(checks.find((check) => check.name === "rate_budget")?.ok, true);
		assert.equal(checks.find((check) => check.name === "pending_work")?.ok, true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
