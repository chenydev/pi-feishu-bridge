/**
 * P2-01 澄清/选择提问：
 * - 跨群、跨 run、错误用户、重复、过期、stop/重置/关闭后的点击一律拒绝；
 * - 正确选项**只消费一次**；
 * - 选择**不写入**审批 allowlist（澄清 ≠ 工具授权）；
 * - 无卡片权限时退化为文本选项，不阻塞继续对话。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ClarificationStore,
	buildClarificationCard,
	clarificationTextFallback,
	type ClarificationDecision,
} from "../src/interaction/clarification-store.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStore(options: { responders?: string[]; timeoutMs?: number; now?: () => number } = {}) {
	const audits: Array<{ decision: string; choice?: string }> = [];
	const store = new ClarificationStore({
		allowedResponderIds: () => options.responders ?? ["ou_admin"],
		timeoutMs: options.timeoutMs ?? 60_000,
		now: options.now,
		onAudit: (event) => { audits.push({ decision: event.decision, choice: event.choice }); },
	});
	return { store, audits };
}

function request(over: Partial<Parameters<ClarificationStore["create"]>[0]> = {}) {
	return {
		conversationKey: "oc_chat#ou_user", chatId: "oc_chat", threadId: "th_1",
		runId: "run-1", toolCallId: "tc-1",
		question: "选哪个方案？", options: ["方案A", "方案B"],
		...over,
	};
}

test("P2-01：正确选项只消费一次，重复点击被拒", async () => {
	const { store, audits } = makeStore();
	const pending = store.create(request());
	store.attachCard(pending.id, "om_card");

	const first = store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案A" });
	assert.equal(first.ok, true, first.reason);
	assert.ok(first.reason.includes("方案A"));
	const decision = await pending.verdict as ClarificationDecision;
	assert.deepEqual(decision, { status: "answered", choice: "方案A", operatorOpenId: "ou_admin" });

	const second = store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案B" });
	assert.equal(second.ok, false, "重复点击必须拒绝");
	assert.equal(store.pendingCount(), 0);
	assert.equal(audits.filter((event) => event.decision === "answered").length, 1, "只能审计一次回答");
});

test("P2-01：跨群点击被拒（不会串到别的会话）", () => {
	const { store } = makeStore();
	const pending = store.create(request());
	store.attachCard(pending.id, "om_card");
	const foreign = store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_other", operatorOpenId: "ou_admin", choice: "方案A" });
	assert.equal(foreign.ok, false);
	assert.ok(foreign.reason.includes("不属于当前会话"), foreign.reason);
	assert.equal(store.pendingCount(), 1, "被拒的点击不得消费等待点");
});

test("P2-01：错误用户无权作答", () => {
	const { store } = makeStore({ responders: ["ou_admin"] });
	const pending = store.create(request());
	store.attachCard(pending.id, "om_card");
	const outsider = store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_random", choice: "方案A" });
	assert.equal(outsider.ok, false);
	assert.ok(outsider.reason.includes("没有作答权限"), outsider.reason);
	assert.equal(store.pendingCount(), 1);
});

test("P2-01：token 与卡片消息不匹配时拒绝（旧卡/伪造值无效）", () => {
	const { store } = makeStore();
	const pending = store.create(request());
	store.attachCard(pending.id, "om_card");
	assert.equal(store.decide({ id: pending.id, token: "forged", messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案A" }).ok, false);
	assert.equal(store.decide({ id: pending.id, token: pending.token, messageId: "om_old_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案A" }).ok, false);
	assert.equal(store.decide({ id: "unknown-id", token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案A" }).ok, false);
	assert.equal(store.pendingCount(), 1, "三次非法点击都不得消费等待点");
});

test("P2-01：无效选项被拒", () => {
	const { store } = makeStore();
	const pending = store.create(request());
	store.attachCard(pending.id, "om_card");
	const invalid = store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案C" });
	assert.equal(invalid.ok, false);
	assert.ok(invalid.reason.includes("无效选项"));
	assert.equal(store.pendingCount(), 1);
});

test("P2-01：超时后点击被拒，verdict 返回 timeout", async () => {
	const { store } = makeStore({ timeoutMs: 1_000 });
	const pending = store.create(request());
	await tick(1_100);
	const decision = await pending.verdict;
	assert.equal(decision.status, "timeout");
	const late = store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案A" });
	assert.equal(late.ok, false, "超时后点击必须拒绝");
	assert.ok(late.reason.includes("失效") || late.reason.includes("超时"), late.reason);
});

test("P2-01：run 结束 / 会话重置 / 进程关闭都会撤销等待点", async () => {
	const { store } = makeStore();
	const a = store.create(request({ runId: "run-1" }));
	const b = store.create(request({ runId: "run-2", conversationKey: "oc_chat#ou_other" }));
	assert.equal(store.pendingCount(), 2);

	assert.equal(store.cancelRun("oc_chat#ou_user", "run-1"), 1, "run 结束只撤销该 run");
	assert.equal((await a.verdict as ClarificationDecision).status, "cancelled");
	assert.equal(store.pendingCount(), 1, "其他会话的等待点不受影响");

	assert.equal(store.cancelConversation("oc_chat#ou_other"), 1);
	assert.equal((await b.verdict as ClarificationDecision).status, "cancelled");

	const c = store.create(request({ runId: "run-3" }));
	assert.equal(store.shutdown(), 1, "关闭必须撤销全部等待点");
	assert.equal((await c.verdict as ClarificationDecision).status, "cancelled");
	// 关闭之后新建的等待也应立即失效（不留下无人回答的卡片）
	const d = store.create(request({ runId: "run-4" }));
	assert.equal((await d.verdict as ClarificationDecision).status, "cancelled");
});

test("P2-01：选项数量与问题内容校验", () => {
	const { store } = makeStore();
	assert.throws(() => store.create(request({ options: ["只有一个"] })), /至少需要 2 个选项/, "少于 2 个选项必须拒绝");
	const many = store.create(request({ options: ["a", "b", "c", "d", "e"] }));
	assert.equal(many.options.length, 4, "超过 4 个选项应截断");
	const long = store.create(request({ question: "x".repeat(1_000) }));
	assert.equal(long.question.length, 500, "问题应截断");
});

test("P2-01：卡片与文本回退都携带全部选项", () => {
	const { store } = makeStore();
	const pending = store.create(request({ options: ["方案A", "方案B", "方案C"] }));
	const card = JSON.stringify(buildClarificationCard(pending));
	for (const option of ["方案A", "方案B", "方案C"]) assert.ok(card.includes(option), `卡片必须含选项 ${option}`);
	assert.ok(card.includes("\"op\":\"clarify\""), "卡片回调 op 必须是 clarify（不是 approval）");
	assert.ok(!card.includes("\"op\":\"approval\""), "澄清卡片绝不能伪装成审批卡");

	const fallback = clarificationTextFallback(pending);
	assert.ok(fallback.includes("1. 方案A") && fallback.includes("3. 方案C"), "文本回退必须列出全部选项");
	assert.ok(fallback.includes("直接回复"), "文本回退必须说明如何回答");
});

test("P2-01：澄清等待点独立于审批（pending 计数分属两个 store）", async () => {
	// 关键安全断言：澄清只产生“回答内容”，不产生任何授权记录。
	const { store } = makeStore();
	const pending = store.create(request());
	store.attachCard(pending.id, "om_card");
	assert.equal(store.pendingForConversation("oc_chat#ou_user"), 1);
	store.decide({ id: pending.id, token: pending.token, messageId: "om_card", chatId: "oc_chat", operatorOpenId: "ou_admin", choice: "方案A" });
	await pending.verdict;
	assert.equal(store.pendingForConversation("oc_chat#ou_user"), 0);
	// ClarificationStore 不暴露任何授权接口：类型层面就没有 sessionAllow/autoApprove
	const api = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
	assert.ok(!api.some((name) => /allow|approve/i.test(name)), `澄清 store 不得暴露授权接口：${api.join(",")}`);
});
