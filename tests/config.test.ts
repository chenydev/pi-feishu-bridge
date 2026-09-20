import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolvePaths, resolveTimezone, formatTimeInZone } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/types.js";

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

test("页脚群级开关：群级优先于全局，缺省跟随全局，非法值直接报错", async () => {
	const { resolveFooterEnabled, loadConfig, saveConfig } = await import("../src/config.js");
	const { DEFAULT_CONFIG } = await import("../src/types.js");
	const base = { ...DEFAULT_CONFIG, footer: { ...DEFAULT_CONFIG.footer, enabled: true } };
	assert.deepEqual(resolveFooterEnabled(base, "oc_a"), { enabled: true, source: "global" });
	assert.deepEqual(resolveFooterEnabled({ ...base, footerByChat: { oc_a: false } }, "oc_a"), { enabled: false, source: "chat" });
	assert.deepEqual(resolveFooterEnabled({ ...base, footerByChat: { oc_a: false } }, "oc_b"), { enabled: true, source: "global" }, "别的群不受影响");
	assert.deepEqual(resolveFooterEnabled({ ...base, footer: { ...base.footer, enabled: false }, footerByChat: { oc_a: true } }, "oc_a"),
		{ enabled: true, source: "chat" }, "全局关掉后，群级仍可单独打开");

	// 落盘 + 重新加载：设置必须活过重启
	const dir = mkdtempSync(join(tmpdir(), "feishu-footer-cfg-"));
	try {
		const cfg = { ...base, footerByChat: { oc_a: false } };
		assert.equal(saveConfig(dir, cfg), true);
		const reloaded = loadConfig(dir, {});
		assert.deepEqual(reloaded.footerByChat, { oc_a: false });

		// 非法值不能被静默当成默认值
		writeFileSync(join(dir, "feishu-bridge", "config.json"), JSON.stringify({ ...base, footerByChat: { oc_a: "yes" } }));
		assert.throws(() => loadConfig(dir, {}), /footerByChat\.oc_a 必须是 true\/false/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("进度档位：默认 all，env 可覆盖，非法值报错而不是静默回默认", () => {
	assert.deepEqual(loadConfig("/not-used", {}).progress, DEFAULT_CONFIG.progress, "缺省沿用默认（all + 保留）");

	for (const mode of ["off", "new", "all", "verbose"]) {
		assert.equal(loadConfig("/not-used", { FEISHU_PROGRESS_MODE: mode }).progress.mode, mode);
	}
	// 写错了要让启动失败，否则「我明明配了 off 却还在发」无从排查
	assert.throws(() => loadConfig("/not-used", { FEISHU_PROGRESS_MODE: "quiet" }), /invalid progress mode/);
});

test("进度档位：文件里非法 mode / 数值 fail-fast，keepOnFinish 只认 false", () => {
	withConfigFile({ progress: { mode: "off", maxLines: 2, previewChars: 12, keepOnFinish: false } }, (home) => {
		const cfg = loadConfig(home, {});
		assert.equal(cfg.progress.mode, "off");
		assert.equal(cfg.progress.maxLines, 2);
		assert.equal(cfg.progress.previewChars, 12);
		assert.equal(cfg.progress.keepOnFinish, false);
	});

	withConfigFile({ progress: { mode: "quiet" } }, (home) => {
		assert.throws(() => loadConfig(home, {}), /invalid progress mode/);
	});
	withConfigFile({ progress: { maxLines: "很多" } }, (home) => {
		assert.throws(() => loadConfig(home, {}), /invalid number at config\.progress\.maxLines/);
	});
	withConfigFile({ progress: { maxLines: 0 } }, (home) => {
		assert.equal(loadConfig(home, {}).progress.maxLines, 1, "行数下限收敛到 1，不能配成 0 行");
	});
	withConfigFile({ progress: { previewChars: 0 } }, (home) => {
		assert.equal(loadConfig(home, {}).progress.previewChars, 4, "预览下限收敛到 4");
	});
	withConfigFile({ progress: { keepOnFinish: "yes" } }, (home) => {
		assert.equal(loadConfig(home, {}).progress.keepOnFinish, true, "只显式 false 才关掉保留");
	});
});

test("进度档位：env 覆盖优先于文件", () => {
	withConfigFile({ progress: { mode: "off" } }, (home) => {
		assert.equal(loadConfig(home, { FEISHU_PROGRESS_MODE: "all" }).progress.mode, "all");
		assert.equal(loadConfig(home, {}).progress.mode, "off");
	});
});
