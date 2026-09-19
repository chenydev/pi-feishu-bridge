/**
 * 长文安全分片（P0-06）。
 *
 * 修复的缺陷（R3）：
 * - 旧实现用 `String.slice` 按 UTF-16 码元切分 → 拆开代理对（`'aaa😀bbb'` 切成 `'aaa\ud83d'` + `'\ude00bbb'`，两片都不合法）；
 * - 围栏状态不跨片携带 → 中间片失去 ``` 上下文，`buildMarkdownPostPayload` 渲染出的不是 code_block，代码块语义丢失；
 * - 对 tail 首部做 `replace(/^\n/, "")` 会改变原始内容。
 *
 * 现在的做法（先分块、再分片）：
 *   1. 把文本切成「文本段 / 代码段」两类逻辑块，代码段记录围栏标记与语言；
 *   2. 文本段按行累积成片（保留空行）；
 *   3. 代码段每片自带围栏开合（预留开销后按行分片），语言标记保留；
 *   4. 切分一律走 grapheme 边界（`safeCutIndex`），不拆坏 emoji/组合字符。
 */

const DEFAULT_MAX_CHARS = 16_000;
/** 代码段每片至少留出的正文额度，避免围栏开销把小片切碎。 */
const MIN_CODE_BODY = 32;

const segmenter: Intl.Segmenter | undefined = typeof Intl.Segmenter === "function"
	? new Intl.Segmenter("zh", { granularity: "grapheme" })
	: undefined;

/**
 * 返回不超过 maxChars 个 UTF-16 单元、且落在 grapheme 边界的最长前缀长度。
 * 若首个 grapheme 本身就超过上限（超长 ZWJ 序列），**整体返回它** ——
 * 宁可单片略超限，也不拆坏不可分割的字形。
 */
export function safeCutIndex(text: string, maxChars: number): number {
	if (maxChars <= 0) return 0;
	if (text.length <= maxChars) return text.length;
	if (!segmenter) {
		let cut = maxChars;
		const code = text.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 不切开代理对
		return Math.max(cut, 1);
	}
	let consumed = 0;
	let firstSegmentLength = 0;
	for (const { segment } of segmenter.segment(text)) {
		if (firstSegmentLength === 0) firstSegmentLength = segment.length;
		const next = consumed + segment.length;
		if (next > maxChars) break;
		consumed = next;
	}
	if (consumed > 0) return consumed;
	return firstSegmentLength > 0 ? firstSegmentLength : 1;
}

/** 围栏行：``` 或 ~~~（允许缩进与语言标记）。 */
const FENCE_RE = /^\s*(`{3,}|~{3,})(\w*)\s*$/;

export interface MarkdownSegment {
	type: "text" | "code";
	lines: string[];
	/** 代码段的围栏标记（``` 或 ~~~ 或更长）。 */
	marker?: string;
	/** 代码段语言。 */
	language?: string;
	/** 代码段是否在源文本中闭合（未闭合时保持原样，不凭空补围栏）。 */
	closed?: boolean;
}

/** 按围栏把文本切成文本段与代码段。 */
export function splitMarkdownSegments(text: string): MarkdownSegment[] {
	const segments: MarkdownSegment[] = [];
	let section: MarkdownSegment = { type: "text", lines: [] };
	let fence: { marker: string; language: string } | undefined;

	const flushText = (): void => {
		if (section.lines.length > 0) segments.push(section);
	};

	for (const line of text.split("\n")) {
		const match = line.match(FENCE_RE);
		if (!fence && match) {
			flushText();
			fence = { marker: match[1], language: match[2] ?? "" };
			section = { type: "code", lines: [], marker: fence.marker, language: fence.language, closed: false };
			continue;
		}
		if (fence && match) {
			section.closed = true;
			segments.push(section);
			fence = undefined;
			section = { type: "text", lines: [] };
			continue;
		}
		section.lines.push(line);
	}
	if (section.lines.length > 0) segments.push(section);
	else if (section.type === "code" && section.lines.length === 0) segments.push(section);
	return segments;
}

/** 把若干行累积成不超过 limit 的片段（单行超长时走 grapheme 安全硬切）。 */
function splitLines(lines: string[], limit: number): string[] {
	const parts: string[] = [];
	let buffer: string[] = [];
	let length = 0;

	const flush = (): void => {
		if (buffer.length === 0) return;
		parts.push(buffer.join("\n"));
		buffer = [];
		length = 0;
	};

	for (const line of lines) {
		if (line.length > limit) {
			flush();
			let rest = line;
			while (rest.length > limit) {
				const cut = safeCutIndex(rest, limit);
				if (cut <= 0) break;
				parts.push(rest.slice(0, cut));
				rest = rest.slice(cut);
			}
			if (rest.length > 0) {
				buffer.push(rest);
				length = rest.length;
			}
			continue;
		}
		const addition = buffer.length > 0 ? line.length + 1 : line.length;
		if (buffer.length > 0 && length + addition > limit) flush();
		buffer.push(line);
		length += addition;
	}
	flush();
	return parts;
}

/**
 * 把 markdown 长文切成可独立渲染的片：
 * 文本段按行分片，代码段每片自带围栏开合与语言标记。
 */
export function chunkMarkdown(text: string, maxChars: number = DEFAULT_MAX_CHARS): string[] {
	if (text.length === 0) return [];
	const limit = Math.max(1, maxChars);
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	for (const segment of splitMarkdownSegments(text)) {
		if (segment.type === "text") {
			for (const part of splitLines(segment.lines, limit)) {
				if (part.length > 0) chunks.push(part);
			}
			continue;
		}
		const marker = segment.marker ?? "```";
		const language = segment.language ?? "";
		const opener = `${marker}${language}`;
		// 每片的围栏开销：opener + "\n" + 正文 + "\n" + marker
		const overhead = opener.length + marker.length + 2;
		const bodyLimit = Math.max(MIN_CODE_BODY, limit - overhead);
		const parts = splitLines(segment.lines, bodyLimit);
		if (parts.length === 0) {
			chunks.push(segment.closed ? `${opener}\n${marker}` : opener);
			continue;
		}
		for (const part of parts) {
			chunks.push(segment.closed ? `${opener}\n${part}\n${marker}` : `${opener}\n${part}`);
		}
	}
	return chunks.length > 0 ? chunks : [text];
}
