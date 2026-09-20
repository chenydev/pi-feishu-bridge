/**
 * /models 卡片：分页、切换按钮、回调 value 契约。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelsCard, buildModelsCardResolved, MODELS_PAGE_SIZE, modelLabel } from "../src/commands/models-card.js";

const models = [
	{ id: "deepseek-flash", provider: "deepseek" },
	{ id: "deepseek-v4-pro", provider: "deepseek" },
	...Array.from({ length: 20 }, (_, i) => ({ id: `gpt-x${i}`, provider: "openai" })),
];
const base = { models, currentId: "deepseek-flash", conversationKey: "oc_x:u:ou_y" };

function buttons(card: unknown): Array<Record<string, unknown>> {
	const body = (card as { body: { elements: unknown[] } }).body;
	return body.elements.filter((el) => (el as { tag?: string }).tag === "button") as Array<Record<string, unknown>>;
}

test("模型卡片：header 不带 tag（飞书 card 2.0 会拒卡），且是 2.0 schema", () => {
	const card = buildModelsCard({ ...base, page: 0 }) as { schema: string; header: Record<string, unknown> };
	assert.equal(card.schema, "2.0");
	assert.ok(!("tag" in card.header), "header 不能有 tag 字段");
	assert.equal((card.header.title as { content: string }).content, `可用模型（${models.length}）`);
});

test("模型卡片：每页数量受控，当前模型置顶且按钮禁用", () => {
	const card = buildModelsCard({ ...base, page: 0 });
	const btns = buttons(card);
	// 模型按钮 = pageSize 个（不算翻页），当前模型那个 disabled
	const modelBtns = btns.filter((b) => (b.value as { op: string }).op === "models.pick");
	assert.equal(modelBtns.length, MODELS_PAGE_SIZE);
	const currentBtn = modelBtns.find((b) => (b.value as { id: string }).id === "deepseek-flash");
	assert.equal(currentBtn?.disabled, true, "当前模型按钮应禁用");
	assert.match((currentBtn?.text as { content: string }).content, /^✓ /);
	// 首行 markdown 显式标出当前模型
	const first = (card as { body: { elements: Array<{ content?: string }> } }).body.elements[0];
	assert.match(first.content ?? "", /当前：\*\*deepseek\/deepseek-flash\*\*/);
});

test("模型卡片：切换按钮的 value 带 provider/id/conversationKey 三件套", () => {
	const card = buildModelsCard({ ...base, page: 0, pageSize: 3 });
	const pick = buttons(card).find((b) => (b.value as { id: string }).id === "deepseek-v4-pro");
	assert.ok(pick, "应能找到 deepseek-v4-pro 的按钮");
	assert.deepEqual(pick.value, {
		op: "models.pick", provider: "deepseek", id: "deepseek-v4-pro", conversationKey: "oc_x:u:ou_y",
	});
});

test("模型卡片：分页按钮边界正确（首屏上一页禁用、末屏下一页禁用）", () => {
	const pages = Math.ceil(models.length / MODELS_PAGE_SIZE);
	const first = buttons(buildModelsCard({ ...base, page: 0 })).filter((b) => (b.value as { op: string }).op === "models");
	assert.equal(first[0]?.disabled, true, "首页上一页应禁用");
	assert.equal(first[1]?.disabled, false);

	const last = buttons(buildModelsCard({ ...base, page: pages - 1 })).filter((b) => (b.value as { op: string }).op === "models");
	assert.equal(last[0]?.disabled, false);
	assert.equal(last[1]?.disabled, true, "末页下一页应禁用");
	// 越界 page 会被夹到有效范围，不产生空卡片
	const clamped = buildModelsCard({ ...base, page: 999 });
	assert.match(((clamped as { header: { subtitle: { content: string } } }).header.subtitle).content, new RegExp(`${pages}/${pages}`));
});

test("模型卡片：单页时不出现翻页按钮", () => {
	const card = buildModelsCard({ models: models.slice(0, 2), currentId: "deepseek-flash", page: 0, conversationKey: "k" });
	assert.equal(buttons(card).filter((b) => (b.value as { op: string }).op === "models").length, 0);
});

test("modelLabel：带 provider 前缀，无 provider 时退化为纯 id", () => {
	assert.equal(modelLabel({ id: "x", provider: "deepseek" }), "deepseek/x");
	assert.equal(modelLabel({ id: "x" }), "x");
});

test("已处理卡片：所有按钮禁用并给出结论", () => {
	const card = buildModelsCardResolved({ ...base, page: 0 }, "deepseek/deepseek-v4-pro", true, "");
	const btns = buttons(card);
	assert.ok(btns.every((b) => b.disabled === true), "已处理卡片所有按钮必须禁用");
	const header = (card as { header: { template: string } }).header;
	assert.equal(header.template, "green");
});
