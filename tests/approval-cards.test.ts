/**
 * 审批卡布局：4 个选项必须纵向一列（每个按钮独占 column_set），
 * 避免横排时在移动端误点；且回调 op 必须是 approval（不能与 clarify 混淆）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalCard, type ApprovalCardResolution } from "../src/approval/cards.js";
import type { PendingApproval } from "../src/approval/permission-bridge.js";

function pending(): PendingApproval {
	return {
		id: "ap-1", token: "tk-1", conversationKey: "oc_x#ou_y", chatId: "oc_x", threadId: "th",
		runId: "run-1", toolCallId: "tc-1", toolName: "bash", paramsText: "ls -la",
		sourceMessageId: "om_src", expiresAt: Date.now() + 60_000,
		sessionId: "sess-1", allowedOperatorIds: ["ou_admin"],
		verdict: Promise.resolve({ status: "timeout" } as never), resolve: () => {},
	};
}

interface CardShape {
	header?: { title?: { content: string }; subtitle?: { content: string }; template?: string };
	body: { elements: Array<Record<string, unknown>> };
}

const buttonsOf = (card: CardShape) => card.body.elements.filter((el) => el.tag === "button");
const markdownsOf = (card: CardShape) =>
	card.body.elements.filter((el) => el.tag === "markdown").map((el) => String((el as { content: string }).content));

test("审批卡：彩色 header + 4 个满宽按钮（纵向一列）", () => {
	const card = buildApprovalCard(pending()) as CardShape;
	assert.equal(card.header?.title?.content, "⚠️ 需要审批", "顶部应有标题栏（带警示符号）");
	assert.equal(card.header?.template, "orange", "待审批用橙色 header（警示色，参考 hermes）");
	assert.equal(card.header?.subtitle, undefined, "待审批不显示结论副标题");

	const buttons = buttonsOf(card);
	assert.equal(buttons.length, 4, "应有 4 个按钮");
	for (const btn of buttons) {
		assert.equal(btn.width, "fill", "按钮必须占满整行（纵向一列）");
		assert.equal(btn.disabled, undefined, "待审批按钮应可点");
		assert.ok(!String((btn.text as { content: string }).content).includes("✓"));
	}

	// 顺序与语义：批准三档在前、拒绝在最后，拒绝必须是 danger
	assert.deepEqual(buttons.map((b) => (b.value as { choice: string }).choice), ["once", "session", "always", "deny"]);
	assert.equal(buttons[0]!.type, "primary", "「仅本次批准」为强调色");
	assert.match((buttons[0]!.text as { content: string }).content, /^✅ /, "按钮文案带 emoji");
	assert.equal(buttons[3]!.type, "danger", "「拒绝」为危险色");

	// 回调 op 必须是 approval，且带 approvalId + token
	const first = buttons[0]!.value as Record<string, string>;
	assert.equal(first.op, "approval");
	assert.equal(first.approvalId, "ap-1");
	assert.equal(first.token, "tk-1");

	// 命令用代码块整块展示
	assert.ok(markdownsOf(card).some((t) => t.includes("bash")), "应显示工具名");
	assert.ok(markdownsOf(card).some((t) => t.startsWith("```") && t.includes("ls -la")), "命令应包在代码块里");
});

test("审批卡：超长参数按命令预算（3000）截断", () => {
	const long = pending();
	long.paramsText = "x".repeat(5000);
	const card = buildApprovalCard(long) as CardShape;
	const block = markdownsOf(card).find((t) => t.startsWith("```")) ?? "";
	// 命令预算 3000（参考 hermes 的 _EA_CMD_BUDGET）；代码块自身有若干字符开销
	assert.ok(block.length < 3100, `参数应被截断到约 3000，实际 ${block.length}`);
	assert.ok(block.includes("x".repeat(3000)), "应保留前 3000 字符");
	assert.ok(!block.includes("x".repeat(3001)), "不应出现第 3001 个字符");
});

/** 已处理状态的卡片结构（复用同一渲染函数）。 */
function resolvedCard(choice: ApprovalCardResolution["choice"], resultText = "已批准") {
	const p = pending();
	const resolution: ApprovalCardResolution = { choice, resultText, operatorOpenId: "ou_owner" };
	return buildApprovalCard(p, resolution) as CardShape;
}

test("已处理的审批卡：保留原文与参数，不退回只剩工具名的结果卡", () => {
	const card = resolvedCard("once");
	assert.equal(card.header?.subtitle?.content, "已批准 · 仅本次批准", "标题栏应显示结论");
	const texts = markdownsOf(card).join("\n");
	assert.ok(texts.includes("bash"), "原文必须保留工具名");
	assert.ok(texts.includes("ls -la"), "原文必须保留参数（事后回看要知道批了什么）");
});

test("已处理的审批卡：被选中按钮加 ✓ 且保留强调色，其余置灰禁用", () => {
	const card = resolvedCard("session");
	const buttons = buttonsOf(card);
	assert.equal(buttons.length, 4);
	assert.ok(buttons.every((b) => b.disabled === true), "所有按钮都应禁用");

	const chosen = buttons[1]!;   // session
	assert.ok(String((chosen.text as { content: string }).content).startsWith("✓"), "被选中按钮加 ✓ 标记");

	for (const [index, btn] of buttons.entries()) {
		if (index === 1) continue;
		assert.ok(!String((btn.text as { content: string }).content).includes("✓"), "未选中按钮不应有 ✓");
	}
});

test("已处理的审批卡：once/danger 保留强调色，header 随结论变色", () => {
	const once = resolvedCard("once");
	assert.equal(buttonsOf(once)[0]!.type, "primary", "once 高亮保持 primary");
	assert.equal(once.header?.template, "green", "已批准用绿色 header");
	assert.equal(once.header?.subtitle?.content, "已批准 · 仅本次批准", "副标题显示结论与所选项");

	const denied = resolvedCard("deny", "已拒绝");
	assert.equal(buttonsOf(denied)[3]!.type, "danger", "deny 高亮保持 danger");
	assert.equal(denied.header?.template, "red", "已拒绝用红色 header");
	assert.equal(denied.header?.subtitle?.content, "已拒绝 · 拒绝");
});

test("已处理的审批卡：标注处理人", () => {
	const card = resolvedCard("always");
	assert.ok(markdownsOf(card).some((t) => t.includes("ou_owner")), "应标注处理人");
});

test("待审批卡片不带禁用与 ✓（未处理时按钮可用）", () => {
	const card = buildApprovalCard(pending()) as CardShape;
	const buttons = buttonsOf(card);
	assert.equal(buttons.length, 4);
	for (const btn of buttons) {
		assert.equal(btn.disabled, undefined, "待审批按钮不应禁用");
		assert.ok(!String((btn.text as { content: string }).content).includes("✓"));
	}
});

test("卡片结构符合飞书 card 2.0：header 不能带 tag（否则 200621）", () => {
	const pendingCard = buildApprovalCard(pending()) as Record<string, unknown>;
	const resolved = buildApprovalCard(pending(), { choice: "once", resultText: "已批准", operatorOpenId: "ou_x" }) as Record<string, unknown>;
	for (const [label, card] of [["待审批", pendingCard], ["已处理", resolved]] as const) {
		const header = card.header as Record<string, unknown>;
		assert.ok(header, `${label}卡片应有 header`);
		assert.equal(header.tag, undefined, `${label}卡片的 header 不能有 tag 字段（飞书会报 200621）`);
		assert.equal((header.title as { tag: string }).tag, "plain_text", "title 才是带 tag 的元素");
		assert.ok(typeof header.template === "string", "应有 template 配色");
		// body 里的元素才需要 tag
		const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
		for (const el of elements) assert.ok(typeof el.tag === "string", "body 内元素必须有 tag");
	}
});

test("按钮 width=fill 且 value 带 approvalId/token/choice（点击可定位到具体审批）", () => {
	const card = buildApprovalCard(pending()) as CardShape;
	for (const btn of buttonsOf(card)) {
		assert.equal(btn.width, "fill");
		const value = btn.value as Record<string, string>;
		assert.equal(value.op, "approval");
		assert.equal(value.approvalId, "ap-1");
		assert.equal(value.token, "tk-1");
		assert.ok(["once", "session", "always", "deny"].includes(value.choice));
	}
});

test("超时终态：灰色 header、按钮全禁用、无 ✓、提示未处理", () => {
	const p = pending();
	const card = buildApprovalCard(p, { terminal: "timeout", resultText: "已超时（未处理）" }) as CardShape;
	assert.equal(card.header?.template, "grey", "超时用灰色 header");
	assert.equal(card.header?.subtitle?.content, "已超时（未处理）", "副标题只显示结论（没有所选项）");
	const buttons = buttonsOf(card);
	assert.equal(buttons.length, 4);
	assert.ok(buttons.every((b) => b.disabled === true), "超时后按钮必须全部禁用");
	assert.ok(buttons.every((b) => !String((b.text as { content: string }).content).includes("✓")), "超时没有「被选中」的选项");
	assert.ok(markdownsOf(card).some((t) => t.includes("超过时限未处理")), "应说明已自动放弃");
});

test("失效终态：红色 header、按钮全禁用、说明已结束", () => {
	const card = buildApprovalCard(pending(), { terminal: "invalidated", resultText: "已失效" }) as CardShape;
	assert.equal(card.header?.template, "red");
	assert.equal(card.header?.subtitle?.content, "已失效");
	assert.ok(buttonsOf(card).every((b) => b.disabled === true));
	assert.ok(markdownsOf(card).some((t) => t.includes("不再有效")), "应说明任务已结束/会话重置");
});

test("终态不能靠 choice 猜测配色：显式 terminal 优先", () => {
	// 用户点了拒绝 vs 因 run 结束而失效，两者都可能是 choice=undefined/deny，但配色语义不同
	const denied = buildApprovalCard(pending(), { choice: "deny", resultText: "已拒绝", operatorOpenId: "ou_x", terminal: "denied" }) as CardShape;
	assert.equal(denied.header?.template, "red");
	const approved = buildApprovalCard(pending(), { choice: "once", resultText: "已批准", operatorOpenId: "ou_x", terminal: "approved" }) as CardShape;
	assert.equal(approved.header?.template, "green");
});

test("转发审批卡：只渲染被允许的选项（不给做不到的按钮）", () => {
	// PS 转发路径无法把「始终批准」写进对方策略引擎的配置，所以那张卡不该出现该按钮。
	const p = pending();
	p.choices = ["once", "session", "deny"];
	const card = buildApprovalCard(p) as CardShape;
	const buttons = buttonsOf(card);
	assert.deepEqual(buttons.map((b) => (b.value as { choice: string }).choice), ["once", "session", "deny"]);
	assert.equal(buttons[0]!.type, "primary");
	assert.equal(buttons[2]!.type, "danger");

	const resolved = buildApprovalCard(p, { choice: "session", resultText: "已批准", operatorOpenId: "ou_owner" }) as CardShape;
	assert.equal(buttonsOf(resolved).length, 3, "已处理态沿用同一选项集合");
	assert.ok(String((buttonsOf(resolved)[1]!.text as { content: string }).content).startsWith("✓"));
});
