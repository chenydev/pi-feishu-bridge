/**
 * 全局默认值（--global）：写 pi 的 settings.json。
 *
 * 这里最要紧的不是"能写进去"，而是**写不坏**：settings.json 是 pi 的启动配置，
 * 写坏了 agent 起不来。所以有两个显式安全阀 —— 解析失败拒绝覆盖、只改我们管的键。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	readGlobalDefaults,
	settingsPath,
	splitModelTarget,
	writeGlobalDefaults,
} from "../src/config/global-defaults.js";

function tmpHome(initial?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "global-defaults-"));
	if (initial !== undefined) writeFileSync(settingsPath(dir), initial);
	return dir;
}

test("写入：只覆盖我们管的键，其余字段原样保留", () => {
	const home = tmpHome(JSON.stringify({
		packages: ["./pi-feishu-bridge"], skills: ["!a"], compaction: { enabled: true },
		defaultModel: "deepseek-flash", defaultThinkingLevel: "max",
	}, null, 2));
	try {
		const result = writeGlobalDefaults(home, { defaultThinkingLevel: "high" });
		assert.equal(result.ok, true);
		const after = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
		assert.equal(after.defaultThinkingLevel, "high");
		assert.equal(after.defaultModel, "deepseek-flash", "没动的键不能丢");
		assert.deepEqual(after.packages, ["./pi-feishu-bridge"], "packages 必须原样保留 —— 丢了桥就起不来了");
		assert.deepEqual(after.skills, ["!a"]);
		assert.deepEqual(after.compaction, { enabled: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("写入：新增模型默认值时同时写 provider（防同名歧义）", () => {
	const home = tmpHome("{}");
	try {
		const { model, provider } = splitModelTarget("deepseek/deepseek-v4-pro");
		const result = writeGlobalDefaults(home, { defaultModel: model, defaultProvider: provider });
		assert.equal(result.ok, true);
		const after = JSON.parse(readFileSync(settingsPath(home), "utf8")) as Record<string, unknown>;
		assert.equal(after.defaultModel, "deepseek-v4-pro");
		assert.equal(after.defaultProvider, "deepseek");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("安全阀：settings.json 解析失败时拒绝覆盖（不抹掉用户配置）", () => {
	const home = tmpHome("{ 这不是 json");
	try {
		const before = readFileSync(settingsPath(home), "utf8");
		const result = writeGlobalDefaults(home, { defaultThinkingLevel: "low" });
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /无法解析/);
		assert.equal(readFileSync(settingsPath(home), "utf8"), before, "文件必须一字未动");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("安全阀：settings.json 是数组/标量时也拒绝（不是对象没法合并）", () => {
	for (const bad of ["[]", "\"str\"", "42"]) {
		const home = tmpHome(bad);
		try {
			assert.equal(writeGlobalDefaults(home, { defaultModel: "x" }).ok, false, `${bad} 应被拒绝`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}
});

test("写入：没有要写的键时返回失败而不是空写一次", () => {
	const home = tmpHome("{}");
	try {
		assert.equal(writeGlobalDefaults(home, {}).ok, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("读取：缺文件与坏文件都当作「没有默认值」", () => {
	const home = tmpHome();
	try {
		assert.deepEqual(readGlobalDefaults(home), {}, "文件不存在");
		writeFileSync(settingsPath(home), "{ 坏");
		assert.deepEqual(readGlobalDefaults(home), {}, "解析失败");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("splitModelTarget：带前缀拆两半，不带前缀只给 model（不猜 provider）", () => {
	assert.deepEqual(splitModelTarget("deepseek/deepseek-v4-pro"), { provider: "deepseek", model: "deepseek-v4-pro" });
	assert.deepEqual(splitModelTarget("gpt-4"), { model: "gpt-4" }, "没前缀就不能猜 provider");
	// 边界：斜杠在开头/结尾时当作裸 id（否则会切出一个空 provider 或空 model）
	assert.deepEqual(splitModelTarget("/leading"), { model: "/leading" });
	assert.deepEqual(splitModelTarget("trailing/"), { model: "trailing/" });
});

// ── `--global` / `-g` 的解析（从 /thinking、/model 的参数里摘出来）────────
// 用完整 token 匹配：`gpt-4` 里的 `-g` 不能被当成开关，`--globalx` 也不行。

test("flag 解析：--global 与 -g 任意位置都算，且从值里摘干净", () => {
	const parse = (raw: string) => {
		const re = /(^|\s)(--global|-g)(\s|$)/;
		const wantsGlobal = re.test(raw);
		return { wantsGlobal, value: raw.replace(/(^|\s)(--global|-g)(\s|$)/g, " ").trim() };
	};
	assert.deepEqual(parse("high --global"), { wantsGlobal: true, value: "high" });
	assert.deepEqual(parse("--global high"), { wantsGlobal: true, value: "high" });
	assert.deepEqual(parse("high -g"), { wantsGlobal: true, value: "high" });
	assert.deepEqual(parse("-g high"), { wantsGlobal: true, value: "high" });
	assert.deepEqual(parse("high"), { wantsGlobal: false, value: "high" });
	assert.deepEqual(parse("deepseek/deepseek-v4-pro --global"), { wantsGlobal: true, value: "deepseek/deepseek-v4-pro" });
});

test("flag 解析：模型名里的 -g 不能被误当成开关", () => {
	const re = /(^|\s)(--global|-g)(\s|$)/;
	assert.equal(re.test("openai/gpt-4"), false, "gpt-4 里的 -g 是名字的一部分");
	assert.equal(re.test("--globalx"), false, "前缀相同但不是这个开关");
	assert.equal(re.test("some-m-g-flag"), false);
});
