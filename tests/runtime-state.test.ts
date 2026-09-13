import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppLock } from "../src/runtime/app-lock.js";
import { resolveAppLockFile } from "../src/config.js";
import { writeStatus } from "../src/runtime/status-store.js";
import type { BridgeStatus } from "../src/types.js";

test("AppLock：同 appId 第二实例 fail-fast，release 后可重新获取", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-lock-"));
	const file = join(dir, "bridge-app.lock");
	try {
		const first = AppLock.acquire(file, "app");
		assert.throws(() => AppLock.acquire(file, "app"), /already running/);
		first.release();
		const second = AppLock.acquire(file, "app");
		second.release();
		assert.equal(existsSync(file), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("AppLock：文件名清洗碰撞不会让不同 appId 共享锁路径", () => {
	const dir = "/tmp/feishu-lock-path";
	assert.notEqual(resolveAppLockFile(dir, "foo/bar"), resolveAppLockFile(dir, "foo?bar"));
});

test("AppLock：两个真实 PID 竞争时第二个 fail-fast，死进程锁可接管", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-lock-process-"));
	const file = join(dir, "bridge.lock");
	const ready = join(dir, "ready");
	const fixture = fileURLToPath(new URL("./fixtures/app-lock-holder.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", "tsx", fixture, file, ready], { cwd: process.cwd(), stdio: "pipe" });
	try {
		const deadline = Date.now() + 2_000;
		while (!existsSync(ready)) {
			if (Date.now() > deadline) throw new Error("child lock holder did not start");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.throws(() => AppLock.acquire(file, "shared-app"), /already running/);
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const recovered = AppLock.acquire(file, "shared-app");
		recovered.release();
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("AppLock：死 PID 和损坏锁可回收，旧 owner 不删除新锁", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-lock-stale-"));
	const file = join(dir, "bridge-app.lock");
	try {
		writeFileSync(file, JSON.stringify({ appId: "app", pid: 2_147_483_647, token: "dead", createdAt: 1 }));
		const recovered = AppLock.acquire(file, "app");
		writeFileSync(file, JSON.stringify({ appId: "app", pid: process.pid, token: "new-owner", createdAt: 2 }));
		recovered.release();
		assert.equal(existsSync(file), true, "token 不匹配时不得删除新 owner 的锁");
		writeFileSync(file, "broken");
		const afterCorruption = AppLock.acquire(file, "app");
		afterCorruption.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("status store：原子写入可解析、权限 0600 且不含 secret", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-feishu-status-"));
	const file = join(dir, "nested", "status.json");
	const status: BridgeStatus = {
		appId: "cli_app",
		pid: process.pid,
		updatedAt: 100,
		connState: "connected",
		reconnectCount: 0,
		conversations: 1,
		outboxDepth: 0,
		outbox: { pending: 0, sending: 0, sent: 2, failed: 0, lanes: 0, oldestAgeMs: 0 },
		messageTotal: 3,
		messageDropped: 0,
		compensatedMessages: 0,
		compensationErrors: 0,
		compensationTruncated: 0,
	};
	try {
		writeStatus(file, status);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), status);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.doesNotMatch(readFileSync(file, "utf8"), /secret/i);
		assert.equal(existsSync(`${file}.tmp`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
