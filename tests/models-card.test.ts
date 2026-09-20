/**
 * 模型列表卡片（表格版）：
 * - 纯展示，**没有回调** —— 表格分页由飞书客户端完成，服务端不参与；
 * - 单元格是 provider/id 完整格式，用户直接选中复制就能粘进 /model；
 * - 名称列只在真有数据时出现（全空的一列比没有更难看）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS_TABLE_PAGE_SIZE, THINKING_LEVELS_PER_ROW, buildModelStatusCard, buildModelsTable, modelLabel } from "../src/commands/models-card.js";

const base = {
	models: [
		{ id: "deepseek-flash", provider: "deepseek", name: "DeepSeek Flash" },
		{ id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
		{ id: "gpt-4", provider: "openai", name: "GPT-4" },
	],
	currentId: "deepseek-flash",
};

type Card = {
	schema: string;
	config: Record<string, unknown>;
	header: { title: { content: string }; template: string };
	body: { elements: Array<Record<string, unknown>> };
};

function tableOf(card: Card): Record<string, unknown> {
	const table = card.body.elements.find((e) => e.tag === "table");
	assert.ok(table, "卡片必须有 table 元素");
	return table;
}

test("models 表格：header 不带 tag（飞书 card 2.0 会拒卡 200621）", () => {
	const card = buildModelsTable(base) as Card;
	assert.equal(card.schema, "2.0");
	assert.equal(card.header.title.content, "可用模型（3）");
	assert.ok(!("tag" in card.header), "header 是对象本身，不接受 tag 字段");
});

test("models 表格：列是 provider/model 完整格式，且每行都有 model 字段", () => {
	const card = buildModelsTable(base) as Card;
	const table = tableOf(card);
	const columns = table.columns as Array<{ name: string; display_name: string; data_type: string }>;
	const rows = table.rows as Array<Record<string, string>>;

	assert.equal(columns[0]?.name, "model");
	assert.equal(columns[0]?.data_type, "text", "纯文本单元格：实测比 markdown 反引号在移动端更紧凑");
	assert.equal(rows.length, 3);
	// 复制就能用：必须是 provider/id，不能只有 id
	assert.deepEqual(rows.map((r) => r.model), ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "openai/gpt-4"]);
});

test("models 表格：page_size 默认 10（客户端分页，不需要服务端回调）", () => {
	const card = buildModelsTable(base) as Card;
	assert.equal(tableOf(card).page_size, MODELS_TABLE_PAGE_SIZE);
	assert.equal(MODELS_TABLE_PAGE_SIZE, 10);

	const custom = buildModelsTable({ ...base, pageSize: 5 }) as Card;
	assert.equal(tableOf(custom).page_size, 5);
});

test("models 表格：当前模型在正文里标明（表格里没有按钮可高亮）", () => {
	const card = buildModelsTable(base) as Card;
	const note = card.body.elements.find((e) => e.tag === "markdown") as { content: string };
	assert.match(note.content, /当前：\*\*deepseek\/deepseek-flash\*\*/);
	assert.match(note.content, /\/model </, "要告诉用户怎么切换");
});

test("models 表格：没有任何 name 时不出现名称列", () => {
	const noName = { models: [{ id: "a" }, { id: "b", provider: "p" }], currentId: "a" };
	const card = buildModelsTable(noName) as Card;
	const columns = tableOf(card).columns as Array<{ name: string }>;
	assert.deepEqual(columns.map((c) => c.name), ["model"], "全空的名称列没有价值");
});

test("models 表格：部分行有 name 时保留名称列（缺失的行不写该字段）", () => {
	const mixed = {
		models: [{ id: "a", provider: "p", name: "A" }, { id: "b", provider: "p" }],
		currentId: "a",
	};
	const card = buildModelsTable(mixed) as Card;
	const table = tableOf(card);
	const columns = table.columns as Array<{ name: string }>;
	const rows = table.rows as Array<Record<string, string>>;
	assert.deepEqual(columns.map((c) => c.name), ["model", "name"]);
	assert.equal(rows[0]?.name, "A");
	assert.equal(rows[1]?.name, undefined, "缺失时不要写空字符串（表格会渲染成空行）");
});

test("modelLabel：有 provider 时带前缀，没有时退化为裸 id", () => {
	assert.equal(modelLabel({ id: "gpt-4", provider: "openai" }), "openai/gpt-4");
	assert.equal(modelLabel({ id: "bare" }), "bare");
});

// ── /model 状态卡 ───────────────────────────────────────────────────────
// 状态卡只回答「我现在用什么、怎么换」，不重复候选列表（那在 /models 里）。
// 两个按钮是**动作**：点档位切换思考等级，点「查看全部模型」触发 /models。

type StatusCard = { header: { title: { content: string }; template: string }; body: { elements: Array<Record<string, unknown>> } };

function buttonsOf(card: StatusCard): Array<Record<string, unknown>> {
	const found: Array<Record<string, unknown>> = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) { node.forEach(walk); return; }
		if (node && typeof node === "object") {
			const obj = node as Record<string, unknown>;
			if (obj.tag === "button") found.push(obj);
			Object.values(obj).forEach(walk);
		}
	};
	card.body.elements.forEach(walk);
	return found;
}

test("状态卡：header 无 tag，正文标明当前模型（带 provider 前缀便于复制）", () => {
	const card = buildModelStatusCard({
		currentLabel: "deepseek/deepseek-v4-pro", thinkingLevel: "max",
		availableLevels: ["high", "max"], conversationKey: "oc_x:u:ou_y",
	}) as StatusCard;
	assert.equal(card.header.title.content, "模型");
	assert.ok(!("tag" in card.header));
	const note = card.body.elements.find((e) => e.tag === "markdown") as { content: string };
	assert.match(note.content, /\*\*deepseek\/deepseek-v4-pro\*\*/);
});

test("状态卡：档位按钮每个都可点，当前档位禁用并打勾", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "max", availableLevels: ["high", "max"], conversationKey: "k",
	}) as StatusCard;
	const levelBtns = buttonsOf(card).filter((b) => (b.value as { op: string }).op === "thinking.set");
	assert.deepEqual(levelBtns.map((b) => (b.text as { content: string }).content), ["high", "✓ max"]);
	assert.equal(levelBtns[0]?.disabled, false, "非当前档位要可点");
	assert.equal(levelBtns[1]?.disabled, true, "当前档位禁用 —— 否则点了没变化会让人困惑");
	// 配色表达可点性：有颜色的（primary）才可点，灰色的（default）是当前档位。
	// 反过来会让灰色按钮看着像不可点 —— 这正是用户反馈要改掉的。
	assert.equal(levelBtns[0]?.type, "primary", "可点的档位要有颜色");
	assert.equal(levelBtns[1]?.type, "default", "当前档位用灰色 + 禁用 + 勾");
	// 回调必须能定位会话：群里一个 chatId 可能对应多个按人隔离的会话
	for (const b of levelBtns) {
		assert.equal((b.value as { conversationKey: string }).conversationKey, "k");
	}
});

test("状态卡：「查看全部模型」按钮触发 models.open，并带 conversationKey", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"], conversationKey: "k",
	}) as StatusCard;
	const open = buttonsOf(card).find((b) => (b.value as { op: string }).op === "models.toggle");
	assert.ok(open, "必须有模型列表按钮");
	assert.equal((open.value as { conversationKey: string }).conversationKey, "k");
	assert.equal((open.text as { content: string }).content, "/models", "未展开时按钮文字直接用命令名");
	assert.equal(open.type, "primary", "按钮要有颜色，看着才是能点的");
	// 展开态文案反转 + 目标态取反（同一个按钮做展开/收起）
	assert.equal((open.value as { expanded: boolean }).expanded, true, "未展开时点它应请求展开");
});

test("状态卡：没有可用档位时不出现空按钮组", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "off", availableLevels: [], conversationKey: "k",
	}) as StatusCard;
	assert.equal(buttonsOf(card).filter((b) => (b.value as { op: string }).op === "thinking.set").length, 0);
	assert.ok(buttonsOf(card).some((b) => (b.value as { op: string }).op === "models.toggle"), "模型列表按钮仍在");
});

test("状态卡：完全没有思考等级时也不出档位区块", () => {
	const card = buildModelStatusCard({ currentLabel: "m", availableLevels: [], conversationKey: "k" }) as StatusCard;
	assert.equal(buttonsOf(card).filter((b) => (b.value as { op: string }).op === "thinking.set").length, 0);
});

// ── 档位排版：每行 3 个等宽（多看几档也不会挤） ────────────────────────
// pi 最多 6 档，一行平分下来每个按钮只剩一两个字母宽，手机端没法点；
// flow 自动换行又会让按钮宽度随文字长短参差。所以固定每行 3 个等宽。

test("状态卡：6 档时排成 2 行、每行 3 个按钮（外加 1 个对齐占位列）", () => {
	const levels = ["minimal", "low", "medium", "high", "max", "xhigh"];
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "medium", availableLevels: levels, conversationKey: "k",
	}) as StatusCard;

	// 含按钮的 column_set 就是档位行（标签行是 markdown，不含按钮）
	const levelRows = card.body.elements.filter(
		(e) => e.tag === "column_set" && JSON.stringify(e).includes("thinking.set"),
	);
	assert.equal(levelRows.length, 2, "6 档应排成 2 行");
	for (const row of levelRows) {
		const cols = row.columns as unknown[];
		assert.equal(cols.length, 4, "每行 = 1 个对齐占位列 + 3 个按钮列");
	}
	// 每行恰好 3 个按钮
	for (const row of levelRows) {
		const n = (JSON.stringify(row).match(/thinking\.set/g) ?? []).length;
		assert.equal(n, 3);
	}
});

test("状态卡：2 档时仍是一行，且补足到 3 个按钮列宽（不拉伸）", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "max", availableLevels: ["high", "max"], conversationKey: "k",
	}) as StatusCard;
	const levelRows = card.body.elements.filter(
		(e) => e.tag === "column_set" && JSON.stringify(e).includes("thinking.set"),
	);
	assert.equal(levelRows.length, 1);
	const cols = levelRows[0]?.columns as unknown[];
	assert.equal(cols.length, 4, "2 个按钮也要占满 3 个按钮位（补 1 个空列），否则会被拉伸");
	assert.equal((JSON.stringify(levelRows[0]).match(/thinking\.set/g) ?? []).length, 2);
});

test("状态卡：档位按钮带勾（当前档位）且勾只在当前档位出现", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "low", availableLevels: ["low", "high", "max"], conversationKey: "k",
	}) as StatusCard;
	const contents = buttonsOf(card)
		.filter((b) => (b.value as { op: string }).op === "thinking.set")
		.map((b) => (b.text as { content: string }).content);
	assert.deepEqual(contents, ["✓ low", "high", "max"]);
	assert.equal(contents.filter((c) => c.startsWith("✓")).length, 1, "只能有一个勾");
});

test("状态卡：THINKING_LEVELS_PER_ROW 是 3，且列宽全部用 weighted（等宽）", () => {
	assert.equal(THINKING_LEVELS_PER_ROW, 3);
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "max",
		availableLevels: ["minimal", "low", "medium", "high", "max", "xhigh"], conversationKey: "k",
	}) as StatusCard;
	for (const row of card.body.elements.filter((e) => e.tag === "column_set")) {
		for (const col of (row.columns as Array<Record<string, unknown>>)) {
			if (JSON.stringify(col).includes("thinking.set")) {
				assert.equal(col.width, "weighted", "等宽不能靠 auto（宽度随文字长短变化）");
			}
		}
	}
});

// ── 把「按钮等价于哪条命令」写在卡片上 ─────────────────────────────────
// 点按钮只是代用户发一条命令；把命令露出来，用户才能复制去加 -g、
// 转发给别人、或记到自己的笔记里。

test("状态卡：首屏不罗列全部命令（那是「已执行」的职责，静态列一遍只是噪音）", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "max", availableLevels: ["high", "max"], conversationKey: "k",
	}) as StatusCard;
	assert.doesNotMatch(JSON.stringify(card), /`\/thinking high`/, "没点过任何按钮就不该有已执行回执");
});

test("状态卡：「已执行」放在卡片**顶部**（最新信息最先看到）", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high", "max"],
		conversationKey: "k", lastExecuted: "/thinking high",
	}) as StatusCard;
	const all = JSON.stringify(card);
	assert.match(all, /已执行/, "要有已执行回执");
	assert.match(all, /`\/thinking high`/, "命令要被反引号包起来，方便选中复制");

	// 顺序：已执行 必须在当前模型名之前 —— 它在卡片最上面
	const idxExec = all.indexOf("已执行");
	const idxModel = all.indexOf("**m**");
	assert.ok(idxExec >= 0 && idxModel >= 0 && idxExec < idxModel, `已执行(${idxExec}) 应在模型名(${idxModel}) 之前`);
});

test("状态卡：没有 lastExecuted 时不出现已执行区块", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"], conversationKey: "k",
	}) as StatusCard;
	assert.doesNotMatch(JSON.stringify(card), /已执行/);
});

test("状态卡：底部小字提示 -g 可设为全局默认", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"], conversationKey: "k",
	}) as StatusCard;
	const texts = card.body.elements
		.filter((e) => e.tag === "markdown")
		.map((e) => String((e as { content?: string }).content ?? ""));
	const tip = texts.find((t) => t.includes("-g")) ?? "";
	assert.match(tip, /-g/, "必须提到 -g 简写");
	assert.match(tip, /--global/, "也要提到完整写法");
	assert.match(tip, /全局默认/, "要说清它是干什么的");
	// 关键：要说明生效范围，否则用户会以为当前会话也变了
	assert.match(tip, /新建|之后/, "必须说明只对新会话生效");
});

test("状态卡：底部 -g 提示用小字号，不与正文抢注意力", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"], conversationKey: "k",
	}) as StatusCard;
	const tip = card.body.elements.find(
		(e) => e.tag === "markdown" && String((e as { content?: string }).content ?? "").includes("-g"),
	) as { text_size?: string } | undefined;
	assert.equal(tip?.text_size, "notation", "提示内容字号要和正文区分开");
});


// ── 「已执行」独立成块 + 表格卡片也支持 ────────────────────────────────

test("已执行：是独立一块（上下都有分割线）", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"],
		conversationKey: "k", lastExecuted: "/thinking high",
	}) as StatusCard;
	const els = card.body.elements;
	const idx = els.findIndex((e) => JSON.stringify(e).includes("已执行"));
	assert.ok(idx > 0, "已执行块应在卡片内");
	assert.equal(els[idx - 1]?.tag, "hr", "上面要有分割线");
	assert.equal(els[idx + 1]?.tag, "hr", "下面也要有分割线，这样才是独立一块");
});

test("表格卡片：不出现已执行块（回执只属于会发生变化的卡片）", () => {
	// 表格是纯展示列表：用户点「/models」自己知道点了什么，混一条回执只是噪音
	const card = buildModelsTable({ models: [{ id: "a", provider: "p" }], currentId: "a" });
	assert.doesNotMatch(JSON.stringify(card), /已执行/);
});

test("表格卡片：没有已执行时不出现该块（首屏干净）", () => {
	const card = buildModelsTable({ models: [{ id: "a", provider: "p" }], currentId: "a" });
	assert.doesNotMatch(JSON.stringify(card), /已执行/);
});


// ── 表格并入状态卡（不再另发一张卡）──────────────────────────────────

test("状态卡：展开时把表格并进同一张卡，按钮变「收起模型列表」", () => {
	const models = [{ id: "a", provider: "p" }, { id: "b", provider: "p" }];
	const card = buildModelStatusCard({
		currentLabel: "p/a", thinkingLevel: "high", availableLevels: ["high"],
		conversationKey: "k", expanded: true, models,
	}) as StatusCard;

	const table = card.body.elements.find((e) => e.tag === "table");
	assert.ok(table, "展开后同一张卡里应有表格");
	assert.equal((table.rows as unknown[]).length, 2);
	assert.equal(table.page_size, MODELS_TABLE_PAGE_SIZE, "客户端分页设置要保留");

	const toggle = buttonsOf(card).find((b) => (b.value as { op: string }).op === "models.toggle");
	assert.equal((toggle?.text as { content: string }).content, "收起模型列表");
	assert.equal((toggle?.value as { expanded: boolean }).expanded, false, "展开态下点它应请求收起");
});

test("状态卡：收起态不含表格（省一次 listModels，卡片也不该无端变长）", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"], conversationKey: "k",
	}) as StatusCard;
	assert.equal(card.body.elements.find((e) => e.tag === "table"), undefined);
});

// ── 收回执：点 /models 展开也要给（用户要求）────────────────────────────

test("状态卡：展开表格时同样显示已执行回执（等价命令 /models）", () => {
	const card = buildModelStatusCard({
		currentLabel: "m", thinkingLevel: "high", availableLevels: ["high"],
		conversationKey: "k", expanded: true, models: [{ id: "a", provider: "p" }],
		lastExecuted: "/models",
	}) as StatusCard;
	const all = JSON.stringify(card);
	assert.match(all, /已执行/, "展开动作也要有回执");
	assert.match(all, /`\/models`/);
	// 回执仍在最上面：展开只是往卡片末尾追加表格，不该把回执挤走
	assert.ok(all.indexOf("已执行") < all.indexOf("\"tag\":\"table\""), "回执应在表格之前");
});
