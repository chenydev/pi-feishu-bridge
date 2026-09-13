import type { FeishuInboundMessage } from "../types.js";

export interface HistoryCompensationResult {
	recovered: number;
	errors: number;
	windowTruncated: boolean;
	truncatedChats: number;
}

export async function compensateKnownChats(options: {
	chatIds: Iterable<string>;
	outageStartedAt: number;
	now: number;
	maxWindowMs: number;
	maxPerChat: number;
	list: (chatId: string, startTime: number, endTime: number, limit: number) => Promise<FeishuInboundMessage[]>;
	handle: (message: FeishuInboundMessage) => Promise<void>;
	onError?: (chatId: string, error: unknown) => void;
}): Promise<HistoryCompensationResult> {
	const startTime = Math.max(options.outageStartedAt, options.now - options.maxWindowMs);
	let recovered = 0;
	let errors = 0;
	let truncatedChats = 0;
	for (const chatId of options.chatIds) {
		try {
			const messages = await options.list(chatId, startTime, options.now, options.maxPerChat + 1);
			if (messages.length > options.maxPerChat) truncatedChats += 1;
			for (const message of messages.slice(0, options.maxPerChat)) await options.handle(message);
			recovered += Math.min(messages.length, options.maxPerChat);
		} catch (error) {
			errors += 1;
			options.onError?.(chatId, error);
		}
	}
	return { recovered, errors, windowTruncated: options.outageStartedAt < startTime, truncatedChats };
}
