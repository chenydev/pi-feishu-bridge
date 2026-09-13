import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptAgentEvent } from "../src/outbound/agent-event-adapter.js";

test("AgentEventAdapter：只转发显式 text/thinking delta", () => {
	assert.deepEqual(adaptAgentEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "答" } }), { type: "text_delta", delta: "答" });
	assert.deepEqual(adaptAgentEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "隐式推理" } }), { type: "reasoning_delta", delta: "隐式推理" });
	assert.equal(adaptAgentEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } }), undefined);
});

test("AgentEventAdapter：message_end 仅提取文本块", () => {
	assert.deepEqual(adaptAgentEvent({
		type: "message_end", message: { role: "assistant", id: "a1", content: [{ type: "text", text: "完成" }, { type: "toolCall", name: "x" }] },
	}), { type: "message_end", role: "assistant", text: "完成", messageId: "a1" });
});

test("AgentEventAdapter：保留 assistant error 的停止原因和错误信息", () => {
	assert.deepEqual(adaptAgentEvent({
		type: "message_end",
		message: { role: "assistant", id: "a-error", content: [], stopReason: "error", errorMessage: "Failed to extract accountId from token" },
	}), {
		type: "message_end", role: "assistant", text: "", messageId: "a-error",
		stopReason: "error", errorMessage: "Failed to extract accountId from token",
	});
});

test("AgentEventAdapter：turn_end 提取权威最终文本", () => {
	assert.deepEqual(adaptAgentEvent({
		type: "turn_end", message: { id: "turn-1", content: [{ type: "text", text: "最终" }] },
	}), { type: "turn_end", text: "最终", messageId: "turn-1" });
});
