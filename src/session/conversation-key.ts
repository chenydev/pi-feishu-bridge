import type { BridgeConfig, FeishuInboundMessage } from "../types.js";

/**
 * 飞书消息的唯一会话键真源。
 *
 * - 话题默认由参与者共享；
 * - 群主聊天默认按发送者隔离；
 * - 私聊直接使用 chatId。
 */
export function buildConversationKey(
	msg: Pick<FeishuInboundMessage, "chatId" | "chatType" | "senderId" | "threadId">,
	config: Pick<BridgeConfig, "groupSessionsPerUser">,
): string {
	if (msg.threadId) return `${msg.chatId}:t:${msg.threadId}`;
	if (msg.chatType === "group" && config.groupSessionsPerUser) {
		return `${msg.chatId}:u:${msg.senderId || "unknown"}`;
	}
	return msg.chatId;
}
