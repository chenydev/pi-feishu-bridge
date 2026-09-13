import type { PendingApproval, ApprovalChoice } from "./permission-bridge.js";

function button(text: string, choice: ApprovalChoice, pending: PendingApproval, type: "primary" | "danger" | "default" = "default") {
	return { tag: "button", text: { tag: "plain_text", content: text }, type, value: { op: "approval", approvalId: pending.id, token: pending.token, choice } };
}

export function buildApprovalCard(pending: PendingApproval): unknown {
	return {
		schema: "2.0",
		body: { elements: [
			{ tag: "markdown", content: `**工具审批**\n\n**${pending.toolName}** 请求执行：\n\n\`\`\`\n${pending.paramsText.slice(0, 500)}\n\`\`\`` },
			button("仅本次批准", "once", pending, "primary"),
			button("本会话批准", "session", pending),
			button("始终批准", "always", pending),
			button("拒绝", "deny", pending, "danger"),
		] },
	};
}

export function buildApprovalResultCard(toolName: string, result: string): unknown {
	return { schema: "2.0", body: { elements: [{ tag: "markdown", content: `**工具审批：${result}**\n\n${toolName}` }] } };
}
