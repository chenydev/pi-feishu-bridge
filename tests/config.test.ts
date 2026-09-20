import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolvePaths, resolveTimezone, formatTimeInZone } from "../src/config.js";

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

test("config：PS 父会话转发默认关闭，且 env 覆盖优先于文件", () => {
	// 实验性能力必须显式开启（与 streamingCard 同一约定）：默认值写死在 DEFAULT_CONFIG 里。
	withConfigFile({}, (home) => {
		const cfg = loadConfig(home, {});
		assert.equal(cfg.approval.forwarding?.enabled, false, "默认必须是关");
		assert.equal(cfg.approval.forwarding?.parentSessionId, undefined, "未配置时用代码里的默认父会话 id");
	});
	withConfigFile({ approval: { autoApprove: [], timeoutMs: 1000, forwarding: { enabled: true, parentSessionId: "from-file" } } }, (home) => {
		assert.equal(loadConfig(home, {}).approval.forwarding?.enabled, true, "显式开启后生效");
		assert.equal(loadConfig(home, {}).approval.forwarding?.parentSessionId, "from-file");
		// env 优先：容器里临时试验不必改仓库配置
		assert.equal(loadConfig(home, { FEISHU_PS_FORWARDING: "0" }).approval.forwarding?.enabled, false, "env=0 强制关");
		assert.equal(loadConfig(home, { FEISHU_PS_FORWARDING: "1" }).approval.forwarding?.enabled, true);
	});
});

// ---------------------------------------------------------------- 时区解析 ----
// 背景：容器基础镜像是 UTC，而用户在上海。不显式指定时区时，
// 「最近消息」这类展示会差 8 小时。解析要跨层兜底，且不能被拼错的时区弄挂。

test("时区：FEISHU_TIMEZONE 环境变量优先于配置文件", () => {
	assert.equal(resolveTimezone({ timezone: "UTC" }, { FEISHU_TIMEZONE: "Asia/Shanghai" }), "Asia/Shanghai");
});

test("时区：没有 FEISHU_TIMEZONE 时用配置文件的", () => {
	assert.equal(resolveTimezone({ timezone: "Europe/London" }, {}), "Europe/London");
});

test("时区：配置缺失时跟随容器 TZ", () => {
	assert.equal(resolveTimezone({}, { TZ: "Asia/Tokyo" }), "Asia/Tokyo");
});

test("时区：全都没有时兜底到 Asia/Shanghai", () => {
	assert.equal(resolveTimezone({}, {}), "Asia/Shanghai");
});

test("时区：无效值跳过而不是抛异常（拼错的时区不该把桥弄挂）", () => {
	assert.equal(resolveTimezone({ timezone: "Not/AZone" }, {}), "Asia/Shanghai");
	// 坏值在前、好值在后时应当用好的那个
	assert.equal(resolveTimezone({ timezone: "Bad/Zone" }, { FEISHU_TIMEZONE: "Asia/Shanghai" }), "Asia/Shanghai");
	// 空串同样跳过
	assert.equal(resolveTimezone({ timezone: "   " }, { TZ: "Asia/Shanghai" }), "Asia/Shanghai");
});

test("时区：formatTimeInZone 按指定时区格式化，且无效时区不抛", () => {
	// 2026-01-01T00:00:00Z → 上海是 08:00
	const noon = Date.UTC(2026, 0, 1, 0, 0, 0);
	assert.match(formatTimeInZone(noon, "Asia/Shanghai"), /^08:00/);
	// UTC 下是 00:00
	assert.match(formatTimeInZone(noon, "UTC"), /^00:00/);
	// 无效时区退回系统默认，但不抛
	assert.doesNotThrow(() => formatTimeInZone(noon, "Bad/Zone"));
});
