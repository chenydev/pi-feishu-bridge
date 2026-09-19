import type { PendingApproval, ApprovalChoice } from "./permission-bridge.js";

/**
 * 审批卡（同一份渲染逻辑服务「待审批」与「已处理」两种状态）。
 *
 * 设计要点（对齐飞书卡片观感）：
 * - 顶部用彩色 header 条承载状态：待审批=蓝、已批准=绿、已拒绝=红；
 * - 命令用代码块整块展示（等宽、可复制），不再塞进引号里；
 * - 按钮 `width: "fill"` 各自占满一行，纵向排列，移动端不会误点相邻项；
 * - 已处理时**保留原文与参数**，被选中的按钮加 ✓ 保留强调色，其余置灰禁用。
 */
import type { ApprovalCardTerminal } from "./permission-bridge.js";

export interface ApprovalCardResolution {
	/**
	 * 用户点的那个选项；超时/失效等非用户操作没有选项，用 undefined。
	 */
	choice?: ApprovalChoice;
	/** 终态种类：决定 header 配色与是否显示 ✓。 */
	terminal?: ApprovalCardTerminal;
	/** 结论文案（如「已批准」「已拒绝」）。 */
	resultText: string;
	/** 处理者 open_id（用于展示「谁批的」）；超时/失效等非用户操作没有处理人。 */
	operatorOpenId?: string;
}

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
	once: "仅本次批准",
	session: "本会话批准",
	always: "始终批准",
	deny: "拒绝",
};

type ButtonType = "primary" | "danger" | "default";

function button(
	text: string,
	choice: ApprovalChoice,
	pending: PendingApproval,
	type: ButtonType,
	disabled: boolean,
): Record<string, unknown> {
	return {
		tag: "button",
		text: { tag: "plain_text", content: text },
		type,
		// 占满整行：飞书 card 2.0 的 button 支持 width: fill，无需再包 column_set
		width: "fill",
		...(disabled ? { disabled: true } : {}),
		value: { op: "approval", approvalId: pending.id, token: pending.token, choice },
	};
}

/** 终态配色：待审批蓝、通过绿、拒绝/失效红、超时灰。 */
function headerTemplate(resolution?: ApprovalCardResolution): string {
	if (!resolution) return "blue";
	const terminal = resolution.terminal ?? (resolution.choice === "deny" ? "denied" : "approved");
	if (terminal === "timeout") return "grey";
	if (terminal === "denied" || terminal === "invalidated") return "red";
	return "green";
}

export function buildApprovalCard(pending: PendingApproval, resolution?: ApprovalCardResolution): unknown {
	// 注意：飞书 card 2.0 的 header 是**对象本身**，不接受 `tag` 字段
	// （带 tag 会被拒：200621 unknown property, path: ROOT -> header）。
	const header = {
		title: { tag: "plain_text", content: "工具审批" },
		...(resolution
			? {
				subtitle: {
					tag: "plain_text",
					content: resolution.choice
						? `${resolution.resultText} · ${CHOICE_LABEL[resolution.choice]}`
						: resolution.resultText,
				},
			}
			: {}),
		template: headerTemplate(resolution),
	};

	const elements: unknown[] = [
		{ tag: "markdown", content: `**${pending.toolName}** 请求执行：` },
		// 代码块：等宽字体 + 独立成块，长命令可换行，也便于复制
		{ tag: "markdown", content: `\`\`\`\n${pending.paramsText.slice(0, 500)}\n\`\`\`` },
	];
	if (resolution?.operatorOpenId && resolution.terminal !== "timeout" && resolution.terminal !== "invalidated") {
		elements.push({
			tag: "markdown",
			content: `由 <at id=${resolution.operatorOpenId}></at> 处理完成`,
		});
	} else if (resolution?.terminal === "timeout") {
		elements.push({ tag: "markdown", content: "超过时限未处理，本次请求已自动放弃" });
	} else if (resolution?.terminal === "invalidated") {
		elements.push({ tag: "markdown", content: "该请求已结束（任务中止或会话重置），此审批不再有效" });
	}
	for (const choice of ["once", "session", "always", "deny"] as ApprovalChoice[]) {
		const chosen = resolution?.choice === choice;
		const type: ButtonType = choice === "once" ? "primary" : choice === "deny" ? "danger" : "default";
		elements.push(button(
			resolution && chosen ? `✓ ${CHOICE_LABEL[choice]}` : CHOICE_LABEL[choice],
			choice,
			pending,
			resolution ? (chosen ? type : "default") : type,
			Boolean(resolution),
		));
	}
	return { schema: "2.0", header, body: { elements } };
}

export function buildApprovalResultCard(toolName: string, result: string): unknown {
	return {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: "工具审批" }, subtitle: { tag: "plain_text", content: result }, template: "grey" },
		body: { elements: [{ tag: "markdown", content: `**${toolName}**` }] },
	};
}
