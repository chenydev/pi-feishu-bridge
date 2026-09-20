/**
 * L2/L3：执行进度渲染。
 *
 * 覆盖三件事：
 * 1. 文案 —— hermes `_TOOL_VERBS` 风格的「emoji + 动词 + 参数预览」，含技能识别与脱敏；
 * 2. 追加式日志的渲染 —— 连续重复行折叠 `(×N)`、`maxLines` 截断 + 「共 N 步」提示；
 * 3. 收尾页脚 —— 运行中 `⏱`、成功后 `✅ 完成`、中断 `⏹`、失败 `⚠️`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_PREVIEW_CHARS,
	formatDuration,
	renderProgressText,
	renderToolLine,
	sanitizeCommand,
	skillNameFromPath,
	type ProgressLine,
} from "../src/outbound/progress-render.js";

const view = { mode: "all" as const, maxLines: 6, previewChars: DEFAULT_PREVIEW_CHARS };

// ------------------------------------------------------------ 技能识别 ----

test("L2：技能识别 —— SKILL.md 取父目录名，skills/<name>.md 取文件名", () => {
	assert.equal(skillNameFromPath("/home/node/.pi/agent/skills/quanbu-login/SKILL.md"), "quanbu-login");
	assert.equal(skillNameFromPath("/home/node/.agents/skills/lark-doc/SKILL.md"), "lark-doc");
	assert.equal(skillNameFromPath("/p/.agents/skills/quanbu/quanbu-cli.md"), "quanbu-cli");
	assert.equal(skillNameFromPath("C:\\Users\\u\\.agents\\skills\\lark-im\\SKILL.md"), "lark-im");
	assert.equal(skillNameFromPath("/workspace/src/index.ts"), undefined);
	assert.equal(skillNameFromPath("SKILL.md"), undefined, "没有父目录时给不出技能名");
});

test("L2：读技能 → 「读取技能：<name>」，读普通文件 → 动词 + 路径", () => {
	assert.equal(
		renderToolLine("read", { file_path: "/home/node/.pi/agent/skills/quanbu-login/SKILL.md" }),
		"📖 读取技能：quanbu-login",
	);
	assert.equal(renderToolLine("read", { path: "/workspace/src/index.ts" }), "📖 读取 /workspace/src/index.ts");
});

// ------------------------------------------------------------ 文案 ----

test("L2：bash 单行（不用代码块）、脱敏、动词短语", () => {
	const line = renderToolLine("bash", { command: "npm run build --token=supersecret" });
	assert.match(line, /^💻 运行 /);
	assert.ok(!line.includes("supersecret"), `必须脱敏：${line}`);
	assert.ok(line.includes("***"), line);
	assert.ok(!line.includes("```"), "飞书上 bash 不引代码块（hermes 对飞书的特判）");
});

test("L2：常见工具都有中文动词短语", () => {
	assert.equal(renderToolLine("grep", { pattern: "order_status" }), "🔍 搜索 order_status");
	assert.equal(renderToolLine("fetch_content", { url: "https://example.com/a" }), "🌐 抓取 https://example.com/a");
	assert.equal(renderToolLine("web_search", { query: "飞书 cardkit 频率" }), "🔍 联网搜索 飞书 cardkit 频率");
	assert.equal(renderToolLine("subagent_spawn", { task: "跑一遍回归" }), "🤖 启动子代理 跑一遍回归");
	assert.equal(renderToolLine("mcp", { tool: "dbx.query" }), "🔌 调用 MCP dbx.query");
});

test("L2：无参工具不留孤零零的冒号；未知工具回退成工具名", () => {
	assert.equal(renderToolLine("bash", undefined), "💻 运行");
	assert.equal(renderToolLine("read", { file_path: "   " }), "📖 读取");
	assert.equal(renderToolLine("some_mcp_tool", { query: "x" }), "🔧 some_mcp_tool：x");
	assert.equal(renderToolLine("some_mcp_tool", undefined), "🔧 some_mcp_tool");
});

test("L2：多行参数折成一行（进度消息一行一步）", () => {
	const line = renderToolLine("bash", { command: "set -euo pipefail\nls -la\n  echo done" });
	assert.ok(!line.includes("\n"), line);
	assert.equal(line, "💻 运行 set -euo pipefail ls -la echo done");
});

test("L3：previewChars 截断，verbose 档放宽到硬上限", () => {
	const command = `docker logs --tail 80 ${"x".repeat(120)}`;
	const short = renderToolLine("bash", { command }, { previewChars: 40 });
	assert.ok(short.length <= "💻 运行 ".length + 40, short);
	assert.ok(short.endsWith("..."), short);

	const verbose = renderToolLine("bash", { command }, { mode: "verbose" });
	assert.ok(verbose.length > short.length, `${verbose} vs ${short}`);
	assert.ok(verbose.length <= "💻 运行 ".length + 180, verbose);
});

test("L2：sanitizeCommand 覆盖常见秘密形态且保持可读", () => {
	assert.ok(!sanitizeCommand("PASSWORD=hunter2 ./run").includes("hunter2"));
	assert.ok(!sanitizeCommand("--token abc123").includes("abc123"));
	assert.ok(sanitizeCommand("npm test").includes("npm test"));
	assert.ok(sanitizeCommand("x".repeat(500)).length <= 180);
});

// ------------------------------------------------------------ 正文渲染 ----

function lines(...texts: string[]): ProgressLine[] {
	return texts.map((text) => ({ text, count: 1 }));
}

test("L3：尚无工具行时是「正在处理…」，有行后是「执行过程」", () => {
	const running = { startedAt: 1_000, now: 13_400 };
	assert.equal(renderProgressText([], undefined, view, running), "🤖 正在处理…\n⏱ 12.4s");
	assert.equal(
		renderProgressText(lines("📖 读取技能：a"), undefined, view, running),
		"🤖 执行过程\n📖 读取技能：a\n⏱ 12.4s",
	);
});

test("L3：连续重复行折叠成 (×N)", () => {
	const text = renderProgressText([{ text: "💻 运行 echo 1", count: 3 }], undefined, view, { startedAt: 0, now: 1_000 });
	assert.ok(text.includes("💻 运行 echo 1 (×3)"), text);
});

test("L3：超过 maxLines 只显示最后 N 行，并交代总步数", () => {
	const all = lines(...Array.from({ length: 10 }, (_, i) => `💻 运行 echo ${i}`));
	const text = renderProgressText(all, undefined, { ...view, maxLines: 3 }, { startedAt: 0, now: 1_000 });
	assert.ok(text.includes("共 10 步"), text);
	assert.ok(text.includes("echo 9") && text.includes("echo 8") && text.includes("echo 7"), text);
	assert.ok(!text.includes("echo 6"), `只该留最后 3 行：${text}`);
});

test("L3：收尾页脚区分 完成/中断/失败", () => {
	const rows = lines("💻 运行 npm test");
	const base = { startedAt: 0, finishedAt: 65_000, now: 65_000 };
	assert.ok(renderProgressText(rows, undefined, view, { ...base, outcome: "ok" }).includes("✅ 完成 · 1m5s"));
	assert.ok(renderProgressText(rows, undefined, view, { ...base, outcome: "stopped" }).includes("⏹ 已中断 · 1m5s"));
	assert.ok(renderProgressText(rows, undefined, view, { ...base, outcome: "failed" }).includes("⚠️ 执行失败 · 1m5s"));
	assert.ok(!renderProgressText(rows, undefined, view, { ...base, outcome: "ok" }).includes("⏱"));
});

test("L3：思考摘要只在传入时占一行（默认关闭由调用方决定传不传）", () => {
	const text = renderProgressText(lines("💻 运行 x"), "正在分析这段代码", view, { startedAt: 0, now: 1_000 });
	assert.ok(text.includes("💭 正在分析这段代码"), text);
	assert.ok(!renderProgressText(lines("💻 运行 x"), undefined, view, { startedAt: 0, now: 1_000 }).includes("💭"));
});

test("L3：formatDuration 紧凑表达", () => {
	assert.equal(formatDuration(0), "0.0s");
	assert.equal(formatDuration(12_400), "12.4s");
	assert.equal(formatDuration(59_900), "59.9s");
	assert.equal(formatDuration(150_000), "2m30s");
	assert.equal(formatDuration(-5), "0.0s");
});
