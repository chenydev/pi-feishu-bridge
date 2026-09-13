import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolvePaths } from "../src/config.js";

function withConfigFile(value: unknown, run: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "pi-feishu-bridge-config-"));
	try {
		mkdirSync(join(home, "feishu-bridge"), { recursive: true });
		writeFileSync(join(home, "feishu-bridge", "config.json"), JSON.stringify(value));
		run(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test("config：env 支持 blacklist/admin_only 全部策略值", () => {
	const blacklist = loadConfig("/not-used", { FEISHU_GROUP_POLICY: "blacklist" });
	assert.equal(blacklist.groupPolicy, "blacklist");
	const adminOnly = loadConfig("/not-used", {
		FEISHU_GROUP_POLICY: "admin_only",
		FEISHU_GROUP_RULES: JSON.stringify({ oc_admin: { policy: "admin_only" } }),
	});
	assert.equal(adminOnly.groupPolicy, "admin_only");
	assert.equal(adminOnly.groupRules.oc_admin?.policy, "admin_only");
});

test("config：旧文件的部分 batch 配置继承 V2 容量默认值", () => {
	withConfigFile({ batch: { enabled: false, textWindowMs: 900 } }, (home) => {
		const cfg = loadConfig(home, {});
		assert.deepEqual(cfg.batch, {
			enabled: false,
			textWindowMs: 900,
			maxMessages: 8,
			maxChars: 12_000,
		});
	});
});

test("config：非法策略与损坏 JSON 明确报错", () => {
	const home = mkdtempSync(join(tmpdir(), "feishu-config-invalid-"));
	try {
		assert.throws(() => loadConfig(home, { FEISHU_GROUP_POLICY: "typo" }), /invalid group policy/);
		const paths = resolvePaths(home);
		mkdirSync(dirname(paths.configFile), { recursive: true });
		writeFileSync(paths.configFile, "{broken", "utf8");
		assert.throws(() => loadConfig(home, {}), /invalid JSON config/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("config：非法 group rule 字段 fail-fast，并收紧已有配置权限", () => {
	assert.throws(
		() => loadConfig("/not-used", { FEISHU_GROUP_RULES: JSON.stringify({ oc: { allowlist: "ou_user" } }) }),
		/invalid string array/,
	);
	withConfigFile({ appSecret: "secret", groupRules: {} }, (home) => {
		const file = resolvePaths(home).configFile;
		writeFileSync(file, JSON.stringify({ appSecret: "secret", groupRules: {} }), { mode: 0o644 });
		loadConfig(home, {});
		assert.equal(statSync(file).mode & 0o777, 0o600);
	});
});
