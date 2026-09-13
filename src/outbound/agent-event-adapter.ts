export type AdaptedAgentEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "tool_start"; toolCallId?: string; toolName: string; args?: Record<string, unknown> }
	| { type: "tool_end"; toolCallId?: string; toolName: string; isError?: boolean }
	| { type: "message_end"; role?: string; text: string; messageId?: string; stopReason?: string; errorMessage?: string }
	| { type: "turn_end"; text: string; messageId?: string };

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part && typeof part === "object" && (part as { type?: string }).type === "text"
		? (part as { text?: string }).text ?? "" : "").join("");
}

/** 将 Pi 0.84.x 的公开事件收敛成桥内部稳定事件，未知事件静默忽略。 */
export function adaptAgentEvent(event: unknown): AdaptedAgentEvent | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as Record<string, unknown>;
	const type = value.type;
	if (type === "message_update") {
		const nested = value.assistantMessageEvent as Record<string, unknown> | undefined;
		if (nested?.type === "text_delta" && typeof nested.delta === "string") return { type: "text_delta", delta: nested.delta };
		if (nested?.type === "thinking_delta" && typeof nested.delta === "string") return { type: "reasoning_delta", delta: nested.delta };
		return undefined;
	}
	if (type === "tool_execution_start") return {
		type: "tool_start", toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		toolName: typeof value.toolName === "string" ? value.toolName : "tool",
		args: value.args && typeof value.args === "object" ? value.args as Record<string, unknown> : undefined,
	};
	if (type === "tool_execution_end") return {
		type: "tool_end", toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		toolName: typeof value.toolName === "string" ? value.toolName : "tool", isError: value.isError === true,
	};
	if (type === "message_end" || type === "turn_end") {
		const message = value.message as Record<string, unknown> | undefined;
		const text = textFromContent(message?.content ?? value.content);
		const messageId = typeof message?.id === "string" ? message.id : undefined;
		const stopReason = typeof message?.stopReason === "string" ? message.stopReason
			: typeof value.stopReason === "string" ? value.stopReason : undefined;
		const errorMessage = typeof message?.errorMessage === "string" ? message.errorMessage
			: typeof value.errorMessage === "string" ? value.errorMessage : undefined;
		return type === "turn_end"
			? { type: "turn_end", text, messageId }
			: {
				type: "message_end", role: typeof message?.role === "string" ? message.role : undefined, text, messageId,
				...(stopReason === undefined ? {} : { stopReason }),
				...(errorMessage === undefined ? {} : { errorMessage }),
			};
	}
	return undefined;
}
