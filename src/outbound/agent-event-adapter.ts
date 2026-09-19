export type AdaptedAgentEvent =
	| { type: "text_delta"; delta: string }
	| { type: "reasoning_delta"; delta: string }
	| { type: "tool_start"; toolCallId?: string; toolName: string; args?: Record<string, unknown> }
	| { type: "tool_end"; toolCallId?: string; toolName: string; isError?: boolean }
	| {
		type: "message_end"; role?: string; text: string; messageId?: string; stopReason?: string; errorMessage?: string;
		provider?: string; model?: string; usage?: AdaptedUsage;
	}
	| { type: "turn_end"; text: string; messageId?: string };

/** P1-03：Pi assistant message 的用量字段（reasoning 是 output 子集，不单独累加）。 */
export interface AdaptedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 按模型配置估算的费用；缺失表示"未知"，不得当作 0。 */
	cost?: number;
}

function usageFrom(value: unknown): AdaptedUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Record<string, unknown>;
	const num = (key: string): number => (typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] as number : 0);
	const parsed: AdaptedUsage = {
		input: num("input"), output: num("output"),
		cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite"),
	};
	if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) parsed.cost = usage.cost;
	return parsed;
}

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
		if (type === "turn_end") return { type: "turn_end", text, messageId };
		const provider = typeof message?.provider === "string" ? message.provider : undefined;
		const model = typeof message?.model === "string" ? message.model : undefined;
		const usage = usageFrom(message?.usage);
		return {
			type: "message_end", role: typeof message?.role === "string" ? message.role : undefined, text, messageId,
			...(stopReason === undefined ? {} : { stopReason }),
			...(errorMessage === undefined ? {} : { errorMessage }),
			...(provider === undefined ? {} : { provider }),
			...(model === undefined ? {} : { model }),
			...(usage === undefined ? {} : { usage }),
		};
	}
	return undefined;
}
