/**
 * P0-06 长文分片（R3 回归）：
 * - 只在 grapheme 边界切分：emoji 代理对/ZWJ 序列/组合字符不被拆开，重组等于原文；
 * - 围栏状态跨片携带：每片自带闭合与重开，中间片仍是 code_block；
 * - 保留缩进、空行与内容语义（不 trim）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkMarkdown, safeCutIndex } from "../src/outbound/markdown-chunks.js";
import { buildMarkdownPostPayload, truncateMessage } from "../src/outbound/sender.js";

function postTags(payload: string | undefined): string[] {
	if (!payload) return [];
	const parsed = JSON.parse(payload) as { zh_cn: { content: Array<Array<{ tag: string }>> } };
	return parsed.zh_cn.content.map((row) => row[0]?.tag ?? "?");
}

test("P0-06/R3：emoji 代理对不被拆开，重组等于原文", () => {
	const text = "aaa😀bbb";
	const chunks = truncateMessage(text, 4);
	assert.ok(chunks.length >= 2, "应确实发生分片");
	for (const chunk of chunks) {
		assert.ok((chunk as string & { isWellFormed?: () => boolean }).isWellFormed?.() ?? true, `分片必须合法：${JSON.stringify(chunk)}`);
		assert.ok(chunk.length <= 4, `分片长度不得超过上限：${JSON.stringify(chunk)}`);
	}
	assert.equal(chunks.join(""), text, "重组必须等于原文");
	// 修复前：['aaa\ud83d', '\ude00bbb']，两片都不是合法字符串
	assert.deepEqual(chunks, ["aaa", "😀bb", "b"]);
});

test("P0-06：ZWJ 家庭 emoji 与组合字符按 grapheme 切分", () => {
	const family = "👨‍👩‍👧‍👦";
	const text = `x${family}y${family}z`;
	const chunks = chunkMarkdown(text, 3);
	const joined = chunks.join("");
	assert.equal(joined.replace(/\n/g, ""), text, "不得丢字符（允许换行插入）");
	for (const chunk of chunks) {
		const withoutFamily = chunk.replaceAll(family, "");
		assert.ok(!withoutFamily.includes("\u200d"), `不得留下半个 ZWJ 序列：${JSON.stringify(chunk)}`);
		assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), "不得以孤立高代理结尾");
	}

	// é 组合形式：基字符 + 组合附加符不可拆
	const composed = "e\u0301";
	const chunks2 = chunkMarkdown(`ab${composed}cd`, 3);
	const all = chunks2.join("");
	assert.equal(all.replace(/\n/g, ""), `ab${composed}cd`);
	assert.ok(!chunks2.some((chunk) => chunk.startsWith("\u0301")), "组合附加符不得成为片首孤立字符");
});

test("P0-06/R3：代码围栏跨片保留，每片都能渲染成 code_block", () => {
	const body = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`).join("\n");
	const code = `\`\`\`js\n${body}\n\`\`\``;
	const chunks = chunkMarkdown(code, 200);
	assert.ok(chunks.length >= 2, `应确实分片，实际 ${chunks.length}`);

	for (const [index, chunk] of chunks.entries()) {
		const tags = postTags(buildMarkdownPostPayload(chunk));
		assert.ok(tags.includes("code_block"), `第 ${index + 1} 片必须保留代码块语义，实际 tags=${tags.join(",")}`);
	}
	// 语言标记每片保留
	for (const chunk of chunks) assert.ok(chunk.startsWith("```js\n"), `每片必须带原语言标记：${JSON.stringify(chunk.slice(0, 12))}`);
	// 代码行不丢
	const joined = chunks.join("\n");
	for (let i = 0; i < 40; i += 1) assert.ok(joined.includes(`const value${i} = ${i};`), `第 ${i} 行不得丢失`);
});

test("P0-06：围栏重开时保留语言标记", () => {
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	const chunks = chunkMarkdown(`\`\`\`python\n${body}\n\`\`\``, 60);
	assert.ok(chunks.length >= 2);
	for (const chunk of chunks.slice(1)) {
		assert.ok(chunk.startsWith("```python\n"), `重开的围栏必须带语言：${JSON.stringify(chunk.slice(0, 20))}`);
	}
	const payload = buildMarkdownPostPayload(chunks[chunks.length - 1]);
	const parsed = JSON.parse(payload!) as { zh_cn: { content: Array<Array<{ language?: string }>> } };
	assert.equal(parsed.zh_cn.content[0][0].language, "python");
});

test("P0-06：保留缩进与空行", () => {
	const text = [
		"def f():",
		"    if x:",
		"        return 1",
		"",
		"    return 0",
	].join("\n");
	const chunks = chunkMarkdown(text, 25);
	assert.ok(chunks.length >= 2);
	const joined = chunks.join("\n");
	assert.ok(joined.includes("        return 1"), "深层缩进必须保留");
	assert.ok(joined.includes("\n\n"), "空行必须保留");
});

test("P0-06：超长单行也能安全切分且每片不超限", () => {
	const limit = 50;
	const long = "字".repeat(400) + "😀".repeat(50);
	const chunks = chunkMarkdown(long, limit);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= limit, `分片长度必须 ≤ ${limit}，实际 ${chunk.length}`);
	}
	const rejoined = chunks.join("");
	assert.equal(rejoined, long, "无换行长文必须无损重组");
});

test("P0-06：CRLF 与连续空行语义保持", () => {
	const text = ["第一行\r", "第二行\r", "", "第四行"].join("\n");
	const chunks = chunkMarkdown(text, 12);
	const joined = chunks.join("\n");
	assert.equal(joined.replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"), "内容行必须完整保留（允许在片边界多一个换行）");
	assert.ok(joined.includes("第一行\r"), "CR 必须原样保留");
});

test("P0-06：短文本原样返回单片", () => {
	const text = "短消息 **bold** `code`";
	assert.deepEqual(chunkMarkdown(text, 1000), [text]);
	assert.deepEqual(chunkMarkdown("", 1000), []);
});

test("P0-06：safeCutIndex 落在 grapheme 边界且至少推进一个 code point", () => {
	assert.equal(safeCutIndex("abc", 10), 3);
	assert.equal(safeCutIndex("😀😀", 1), 0 === 0 ? 2 : 1, "代理对至少整体给出");
	assert.ok(safeCutIndex("👨‍👩‍👧‍👦x", 1) >= 1, "超长 ZWJ 序列也必须推进");
	const text = "ab😀cd";
	const cut = safeCutIndex(text, 3);
	assert.equal(text.slice(0, cut), "ab", "不得切出半个代理对");
});
