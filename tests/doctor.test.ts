import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePaths } from "../src/config.js";
import { formatDoctor, runDoctor } from "../src/runtime/doctor.js";
import { DEFAULT_CONFIG } from "../src/types.js";

test("doctor：不泄露 secret，逐项报告凭据/连接/身份/目录/管理员", () => {
	const home = mkdtempSync(join(tmpdir(), "feishu-doctor-"));
	try {
		const checks = runDoctor({
			config: { ...DEFAULT_CONFIG, appId: "app", appSecret: "super-secret", admins: [] },
			paths: resolvePaths(home),
			transport: { isRunning: () => true, isConnected: () => false, getBotIdentity: () => ({}) },
		});
		const text = formatDoctor(checks);
		assert.match(text, /credentials: 已配置/);
		assert.match(text, /运行中但未连接/);
		assert.match(text, /审批将 fail closed/);
		assert.doesNotMatch(text, /super-secret/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("doctor：旧版 PID 探针残留不会造成目录不可写假阴性", () => {
	const home = mkdtempSync(join(tmpdir(), "feishu-doctor-stale-"));
	try {
		const paths = resolvePaths(home);
		mkdirSync(paths.sessionDir, { recursive: true });
		mkdirSync(join(paths.outboxFile, ".."), { recursive: true });
		writeFileSync(join(paths.sessionDir, `.feishu-doctor-${process.pid}.tmp`), "stale", { mode: 0o600 });
		const checks = runDoctor({
			config: { ...DEFAULT_CONFIG, appId: "app", appSecret: "secret", admins: ["admin"] },
			paths,
		});
		assert.equal(checks.find((check) => check.name === "session_dir")?.ok, true);
		assert.equal(checks.find((check) => check.name === "outbox_dir")?.ok, true);
	} finally { rmSync(home, { recursive: true, force: true }); }
});
