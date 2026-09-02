/**
 * 入站消息规范化（normalize）：把飞书事件原始负载转成 FeishuInboundMessage。
 * 覆盖：text / image / video / audio / file / post(富文本→markdown) /
 * merge_forward(合并转发递归展开) / share_chat(共享名片) / interactive。
 * 设计依据：docs/DESIGN.md §3.3；参考 hermes feishu adapter normalize 系列函数。
 */
import type { BotIdentity, FeishuInboundMessage, FeishuMentionRef, InboundMsgType } from "../types.js";

export const MSG_TYPE_MAP: Record<string, InboundMsgType> = {
	text: "text",
	image: "image",
	video: "video",
	audio: "audio",
	file: "file",
	post: "post",
	merge_forward: "merge_forward",
	share_chat: "share_chat",
	interactive: "interactive",
	media: "file",
	"system": "unknown",
};

// ------------------------------------------------------------- 富文本 ----

interface PostElement {
	tag?: string;
	text?: string;
	href?: string;
	user_id?: string;
	image_key?: string;
	file_key?: string;
	language?: string;
	lines?: unknown[];
	content?: unknown[];
	style?: string[];
}

function isStyleEnabled(style: string[] | undefined, key: string): boolean {
	return Array.isArray(style) && style.includes(key);
}

function wrapInline(text: string, style: string[] | undefined): string {
	let out = text;
	if (isStyleEnabled(style, "bold")) out = `**${out}**`;
	if (isStyleEnabled(style, "italic")) out = `*${out}*`;
	if (isStyleEnabled(style, "strike")) out = `~~${out}~~`;
	if (isStyleEnabled(style, "code")) out = "`" + out.replace(/`/g, "\\`") + "`";
	return out;
}

export function renderTextElement(el: PostElement): string {
	if (!el.text) return "";
	if (el.tag === "a" && el.href) return `[${el.text}](${el.href})`;
	// 飞书 post <at>.user_id 的值就是占位符本身（"@_user_N" / "@_all"），
	// 不再拼前缀，由 resolveMentionPlaceholders 统一替换为真实名（hermes 对齐）。
	if (el.tag === "at" && el.user_id) return el.user_id;
	return wrapInline(el.text, el.style);
}

function renderCodeBlock(el: PostElement): string {
	const lang = el.language || "";
	const lines = Array.isArray(el.lines) ? el.lines.map(String) : [];
	return `\`\`\`${lang}\n${lines.join("\n")}\n\`\`\``;
}

export function renderPostElement(el: PostElement): string {
	if (el.tag === "code_block") return renderCodeBlock(el);
	const text = renderTextElement(el);
	if (el.tag === "img" && el.image_key) return `![图片](${el.image_key})`;
	if (el.tag === "file" && el.file_key) return `[文件](file://${el.file_key})`;
	return text;
}

export function renderPostElements(content: unknown): string {
	const lines: string[] = [];
	const renderLine = (line: unknown): string => {
		if (Array.isArray(line)) return line.map((e) => renderPostElement(e as PostElement)).join("");
		const el = line as PostElement | undefined;
		if (el && typeof el === "object" && el.tag) return renderPostElement(el);
		return "";
	};
	if (Array.isArray(content)) {
		for (const row of content) {
			const text = renderLine(row);
			if (text.trim()) lines.push(text);
		}
	} else if (content && typeof content === "object") {
		const c = content as Record<string, unknown>;
		if (Array.isArray(c.content)) return renderPostElements(c.content);
		if (Array.isArray(c.lines)) lines.push(renderPostElement(content as PostElement));
	}
	return lines.join("\n");
}

// -------------------------------------------------------- 合并转发 ----

/** 递归展开合并转发：返回条目文本列表。 */
export function collectForwardEntries(payload: unknown, depth = 0): string[] {
	if (depth > 8) return [];
	if (!payload || typeof payload !== "object") return [];
	const p = payload as Record<string, unknown>;
	const entries: string[] = [];
	const push = (obj: unknown): void => {
		if (!obj || typeof obj !== "object") return;
		const o = obj as Record<string, unknown>;
		const name = typeof o.name === "string" ? o.name : "";
		const msgType = typeof o.msg_type === "string" ? o.msg_type : "";
		let body = "";
		if (o.body && typeof o.body === "object") {
			body = extractBodyText(o.body as Record<string, unknown>);
		}
		if (o.content) {
			try {
				const parsed = typeof o.content === "string" ? JSON.parse(o.content) : o.content;
				body = extractBodyText(parsed as Record<string, unknown>) || body;
			} catch {
				/* ignore */
			}
		}
		entries.push(`${name ? `${name}：` : ""}${body || `[${msgType || "消息"}]`}`);
	};
	if (Array.isArray(p.items)) {
		for (const item of p.items) {
			const nested = collectForwardEntries(item, depth + 1);
			if (nested.length > 0) entries.push(...nested);
			else push(item);
		}
	} else if (Array.isArray(p.list)) {
		for (const item of p.list) push(item);
	} else {
		push(payload);
	}
	return entries;
}

function extractBodyText(body: Record<string, unknown>): string {
	if (!body) return "";
	if (typeof body.text === "string") return body.text;
	if (Array.isArray(body.content)) return renderPostElements(body.content);
	if (body.content && typeof body.content === "object") {
		const c = body.content as Record<string, unknown>;
		if (typeof c.text === "string") return c.text;
		if (Array.isArray(c.content)) return renderPostElements(c.content);
	}
	return "";
}

// ------------------------------------------------------------ 提及 ----

/** 提取 mention 引用（兼容 lark SDK 的 mentions[].id / mentions[].name 结构）。 */
export function extractMentionIds(mention: unknown): { open_id?: string; user_id?: string; union_id?: string; name?: string } {
	if (!mention || typeof mention !== "object") return {};
	const m = mention as Record<string, unknown>;
	const id = (m.id && typeof m.id === "object" ? (m.id as Record<string, unknown>) : {}) as Record<string, string>;
	return {
		open_id: typeof id.open_id === "string" ? id.open_id : undefined,
		user_id: typeof id.user_id === "string" ? id.user_id : undefined,
		union_id: typeof id.union_id === "string" ? id.union_id : undefined,
		name: typeof m.name === "string" ? m.name : undefined,
	};
}

/**
 * mention 判定（hermes 设计，B2 根治）：
 * - mention 的 open_id/user_id 与 bot 对应 ID 相等 → 命中（ID 优先）
 * - 任一侧缺 ID → name 兜底匹配
 */
export function buildMentionsMap(mentions: unknown[] | undefined, bot: BotIdentity): FeishuMentionRef[] {
	if (!Array.isArray(mentions)) return [];
	const refs: FeishuMentionRef[] = [];
	for (const raw of mentions) {
		const m = extractMentionIds(raw);
		let isSelf = false;
		if (m.open_id && bot.openId) {
			isSelf = m.open_id === bot.openId;
		} else if (m.user_id && bot.userId) {
			isSelf = m.user_id === bot.userId;
		} else if (m.name && bot.name) {
			isSelf = m.name === bot.name;
		}
		refs.push({ id: { open_id: m.open_id, user_id: m.user_id, union_id: m.union_id }, name: m.name, isSelf });
	}
	return refs;
}

/**
 * 消息是否提及 bot：@_all（@所有人）或任一 mention isSelf。
 */
export function mentionsBot(rawContent: string, mentions: FeishuMentionRef[]): boolean {
	if (rawContent.includes("@_all")) return true;
	return mentions.some((m) => m.isSelf);
}

const MENTION_PLACEHOLDER_RE = /@_user_\d+/g;

/**
 * 把 @_user_N 占位符替换为真实显示名（hermes _render_post_element 对齐）：
 * mentions 里每个 mention 自带 key（占位符）+ name（真实名），查表替换；
 * @_all → @all；查不到 → @user。
 */
export function resolveMentionPlaceholders(text: string, mentions: FeishuMentionRef[]): string {
	if (!text || !MENTION_PLACEHOLDER_RE.test(text)) return text;
	MENTION_PLACEHOLDER_RE.lastIndex = 0;
	const byKey = new Map<string, FeishuMentionRef>();
	for (const m of mentions) {
		if (m.key) byKey.set(m.key, m);
		if (m.name) byKey.set(m.name, m); // 兼容无 key 的 mention：名字也能对上
	}
	return text.replace(MENTION_PLACEHOLDER_RE, (placeholder) => {
		const ref = byKey.get(placeholder);
		if (!ref) return "@user";
		return `@${ref.name || ref.id?.open_id || "user"}`;
	}).replace(/@_all/g, "@all");
}

/** 剥离开头的自身 mention 占位（@_user_xxx）与 @name 前缀。 */
export function stripEdgeSelfMentions(text: string, mentions: FeishuMentionRef[]): string {
	let out = text;
	const selfNames = mentions.filter((m) => m.isSelf && m.name).map((m) => m.name as string);
	for (const name of selfNames) {
		// 最长优先，避免部分匹配
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`^@${escaped}\\s*`), "").replace(new RegExp(`^@${escaped}(?=\\s|$)`), "");
	}
	out = out.replace(/^@_user_\w+\s*/g, "").trim();
	return out;
}

// ------------------------------------------------------------ 主入口 ----

export interface NormalizeInput {
	messageId: string;
	chatId: string;
	chatType: string; // p2p | group | topic
	messageType: string;
	content: string; // 原始 content JSON 字符串
	sender: unknown;
	mentions?: unknown[];
	parentId?: string;
	upperMessageId?: string;
	rootId?: string;
	threadId?: string;
	bot: BotIdentity;
}

/**
 * 规范化入口：把事件负载归一化为 FeishuInboundMessage。
 * 纯函数（无 I/O），便于单元测试。
 */
export function normalizeFeishuMessage(input: NormalizeInput): FeishuInboundMessage {
	const msgType: InboundMsgType = MSG_TYPE_MAP[input.messageType] ?? "unknown";
	let text = "";
	let rawContent: unknown;
	try {
		rawContent = input.content ? JSON.parse(input.content) : undefined;
	} catch {
		rawContent = undefined;
	}

	switch (msgType) {
		case "text": {
			const t = rawContent as Record<string, unknown> | undefined;
			text = typeof t?.text === "string" ? t.text : input.content;
			break;
		}
		case "post": {
			text = renderPostElements((rawContent as Record<string, unknown> | undefined)?.content);
			break;
		}
		case "merge_forward": {
			const entries = collectForwardEntries(rawContent);
			text = entries.join("\n———\n");
			break;
		}
		case "share_chat": {
			const s = rawContent as Record<string, unknown> | undefined;
			text = `[共享名片] ${typeof s?.chat_name === "string" ? s.chat_name : ""}`.trim();
			break;
		}
		case "image": {
			const img = rawContent as Record<string, unknown> | undefined;
			text = img?.image_key ? `![图片](image_key:${img.image_key})` : "[图片]";
			break;
		}
		case "video": {
			const v = rawContent as Record<string, unknown> | undefined;
			text = v?.file_key ? `[视频](file_key:${v.file_key})` : "[视频]";
			break;
		}
		case "audio": {
			const a = rawContent as Record<string, unknown> | undefined;
			text = a?.file_key ? `[语音](file_key:${a.file_key})` : "[语音]";
			break;
		}
		case "file": {
			const f = rawContent as Record<string, unknown> | undefined;
			text = f?.file_name ? `[文件] ${f.file_name}` : "[文件]";
			break;
		}
		case "interactive": {
			text = input.content || "[卡片]";
			break;
		}
		default:
			text = input.content || "";
	}

	const mentions = buildMentionsMap(input.mentions, input.bot);
	// @_user_N 占位符 → 真实名（hermes 对齐）；再剥离自身 @ 前缀（不注入提示前缀）。
	const finalText = stripEdgeSelfMentions(resolveMentionPlaceholders(text, mentions), mentions);

	const sender = (input.sender ?? {}) as Record<string, unknown>;
	const senderIdObj = (sender.sender_id ?? {}) as Record<string, string>;
	const senderOpenId = senderIdObj.open_id ?? sender.open_id ?? "";

	return {
		messageId: input.messageId,
		chatId: input.chatId,
		chatType: (input.chatType === "p2p" ? "p2p" : input.chatType === "topic" ? "topic" : "group") as FeishuInboundMessage["chatType"],
		senderId: typeof senderOpenId === "string" ? senderOpenId : "",
		senderName: typeof sender.sender_name === "string" ? sender.sender_name : undefined,
		isBot: Boolean(sender.sender_type === "app" || sender.sender_type === "bot"),
		msgType,
		text: finalText,
		mentions,
		replyToMessageId: input.parentId ?? input.upperMessageId ?? input.rootId ?? undefined,
		threadId: input.threadId ?? undefined,
		raw: input,
		ts: Date.now(),
	};
}
