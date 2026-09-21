/**
 * 执行进度渲染（L1–L3，对齐 hermes `agent/display.py` + `gateway/run.py` 的 tool-progress 方案）。
 *
 * 设计取舍 —— **追加式日志，不是"当前正在跑哪些工具"的瞬时快照**：
 * - hermes 的进度气泡是 append-only：工具*开始*时就把一行追加进气泡，之后**永不改写**；
 * - 因此用户看到的是"这轮做了什么"的历史，而不是"此刻还剩哪几个在跑"；
 * - 行一旦落地不可变 → 连续相同行可以安全折叠成 `(×N)`（hermes 的 `__dedup__` 哨兵）。
 *
 * 与 hermes 的三处刻意差异：
 * 1. 文案是中文动词短语（hermes 的 `_TOOL_VERBS` 是英文 "Reading …"）；
 * 2. bash **一律单行**，不因平台 markdown 能力升级成 fenced code block —— hermes 专门为
 *    飞书加了这个特判（`gateway/run.py` 里 `source.platform != Platform.FEISHU`，见其
 *    `llmdoc/reference/feishu-tool-progress.md`），说明飞书上代码块体验差；
 * 3. 不做消息溢出的多气泡滚动（hermes 的 `_roll_progress_overflow_if_needed`）——
 *    我们用 `maxLines` 截断 + 「共 N 步」提示，省掉一条会反复分叉的消息。
 *
 * 技能识别为飞书桥独有：pi 里"读技能"就是 `read` 一个 `SKILL.md`，不认出来只会显示
 * 「读取 SKILL.md」，看不出读的是哪个技能。
 */

/** 进度展示档位（对齐 hermes `display.tool_progress` 的 off/new/all/verbose）。 */
export type ProgressMode = "off" | "new" | "all" | "verbose";

/** 单行预览默认长度（对齐 hermes 飞书档位 `tool_preview_length: 40`）。 */
export const DEFAULT_PREVIEW_CHARS = 40;
/** 预览硬上限：与 `sanitizeCommand` 的截断保持一致，verbose 档也不越过它。 */
export const MAX_PREVIEW_CHARS = 180;

/**
 * P1-02：工具参数脱敏 —— 命令/参数可能含秘密，绝不原样展示。
 *
 * L2 起从 `conversation-manager` 移到这里，与渲染同处一地（`conversation-manager` 仍 re-export）。
 */
export function sanitizeCommand(command: string): string {
	return command
		.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)=([^\s]+)/gi, "$1=***")
		.replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1***")
		.replace(/(--(?:token|password|secret|api-key)(?:=|\s+))[^\s"']+/gi, "$1***")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_PREVIEW_CHARS);
}

interface ToolStyle {
	emoji: string;
	/** 动词短语（后面直接跟参数预览；无预览时单独成句）。 */
	verb: string;
}

/**
 * 工具 → emoji + 动词（hermes `_TOOL_VERBS` 的中文对应版）。
 *
 * 只收录"语义已知"的工具：MCP/插件工具没有条目，回退成 `🔧 <toolName>`，
 * 与 hermes「custom/plugin/MCP tools have no entry and fall back to the raw preview」一致。
 */
const TOOL_STYLES: Record<string, ToolStyle> = {
	read: { emoji: "📖", verb: "读取" },
	write: { emoji: "✏️", verb: "写入" },
	edit: { emoji: "✏️", verb: "修改" },
	bash: { emoji: "💻", verb: "运行" },
	terminal: { emoji: "💻", verb: "运行" },
	grep: { emoji: "🔍", verb: "搜索" },
	find: { emoji: "🗂", verb: "查找" },
	ls: { emoji: "🗂", verb: "列出" },
	fetch_content: { emoji: "🌐", verb: "抓取" },
	web_search: { emoji: "🔍", verb: "联网搜索" },
	browser: { emoji: "🌐", verb: "浏览" },
	agent_browser: { emoji: "🌐", verb: "浏览" },
	source_check: { emoji: "✅", verb: "核查" },
	stats_query: { emoji: "📊", verb: "查询统计" },
	subagent_spawn: { emoji: "🤖", verb: "启动子代理" },
	mcp: { emoji: "🔌", verb: "调用 MCP" },
	mcpScript: { emoji: "🔌", verb: "调用 MCP" },
	ask_user_question: { emoji: "❓", verb: "向你提问" },
	plan_mode_question: { emoji: "❓", verb: "确认方案" },
	todowrite: { emoji: "📋", verb: "更新任务" },
	todo: { emoji: "📋", verb: "更新任务" },
	marketplace_search: { emoji: "🧩", verb: "查找扩展" },
	marketplace_detail: { emoji: "🧩", verb: "查看扩展" },
	marketplace_audit: { emoji: "🧩", verb: "审计扩展" },
	marketplace_install: { emoji: "🧩", verb: "安装扩展" },
	ctx_search: { emoji: "🧠", verb: "检索记忆" },
	ctx_memory: { emoji: "🧠", verb: "写入记忆" },
	memory_search: { emoji: "🧠", verb: "检索记忆" },
	feishu_send_local_file: { emoji: "📎", verb: "发送文件" },
	feishu_notify: { emoji: "🔔", verb: "推送通知" },
	feishu_ask: { emoji: "❓", verb: "向你提问" },
};

const FALLBACK_STYLE: ToolStyle = { emoji: "🔧", verb: "" };

/** 各工具的"主参数"（hermes `build_tool_preview` 的 `primary_args` 对应版）。 */
const PRIMARY_ARGS: Record<string, string[]> = {
	bash: ["command", "cmd"],
	terminal: ["command", "cmd"],
	read: ["file_path", "path", "file"],
	write: ["file_path", "path", "file"],
	edit: ["file_path", "path", "file"],
	grep: ["pattern", "query"],
	find: ["pattern", "path"],
	ls: ["path"],
	fetch_content: ["url", "urls"],
	web_search: ["query", "queries"],
	subagent_spawn: ["task", "description", "prompt"],
	mcp: ["tool", "name"],
	mcpScript: ["code"],
	stats_query: ["query", "group_by"],
	todowrite: ["todos"],
	source_check: ["claim"],
	marketplace_search: ["query"],
	marketplace_detail: ["name"],
	marketplace_audit: ["name"],
	marketplace_install: ["name"],
	ctx_search: ["query"],
	ctx_memory: ["content", "category"],
};

/** 兜底字段链（hermes 同款：所有工具都认这几个"有信息量"的键）。 */
const FALLBACK_ARG_KEYS = ["query", "text", "command", "path", "name", "prompt", "pattern", "url", "file_path"];

const SKILL_FILE = /^SKILL\.md$/i;
/** `skills/<name>.md` 与 `skills/<group>/<name>.md`（pi 的 `.agents/skills/` 分组目录）两种单文件技能形态。 */
const SKILL_UNDER_DIR = /(?:^|\/)skills\/(?:.*\/)?([^/]+)\.md$/i;

/**
 * 从文件路径识别技能名。
 *
 * pi 的两种技能形态（见 `docs/skills.md` 的 Locations）：
 * - `<...>/<skill>/SKILL.md` → 取父目录名；
 * - `<...>/skills/<name>.md`（直接放进技能目录的单文件技能）→ 取文件名。
 */
export function skillNameFromPath(path: string): string | undefined {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalized) return undefined;
	// `<...>/<skill>/SKILL.md`：必须真的有一层父目录，裸 `SKILL.md` 给不出技能名。
	const skillFile = normalized.match(/^(.*)\/SKILL\.md$/i);
	if (skillFile) {
		return skillFile[1].split("/").pop() || undefined;
	}
	// `<...>/skills/<name>.md` 与 `<...>/skills/<group>/<name>.md`（pi 的 `.agents/skills/` 分组目录）
	return normalized.match(SKILL_UNDER_DIR)?.[1];
}

/** 按字段链取第一个非空字符串（数组取首元素，只取首行）。 */
function firstString(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!args) return undefined;
	for (const key of keys) {
		const value = args[key];
		const candidate = Array.isArray(value) ? value[0] : value;
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
	}
	return undefined;
}

function truncate(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	if (maxChars <= 3) return ".".repeat(maxChars);
	return `${text.slice(0, maxChars - 3)}...`;
}

export interface ToolLineOptions {
	/** 预览截断长度；`mode: "verbose"` 时按 `MAX_PREVIEW_CHARS` 放宽。 */
	previewChars?: number;
	mode?: ProgressMode;
}

/**
 * 渲染一行工具进度：`emoji + 动词 + 参数预览`。
 *
 * - 参数预览一律先过 `sanitizeCommand`（脱敏 + 折行 + 180 字硬上限），再按 `previewChars` 截断；
 * - 技能读取单独成句（`📖 读取技能：<name>`），因为"读的是哪个技能"比文件路径更有信息量；
 * - 无参数（或参数全是空值）时退化成 `emoji + 动词`，不留下一个孤零零的冒号。
 */
export function renderToolLine(toolName: string, args?: Record<string, unknown>, options: ToolLineOptions = {}): string {
	const style = TOOL_STYLES[toolName] ?? FALLBACK_STYLE;
	const limit = options.mode === "verbose"
		? MAX_PREVIEW_CHARS
		: Math.max(0, options.previewChars ?? DEFAULT_PREVIEW_CHARS);

	if ((toolName === "read" || toolName === "write" || toolName === "edit") && args) {
		const path = firstString(args, ["file_path", "path", "file"]);
		const skill = path ? skillNameFromPath(path) : undefined;
		if (skill) return `${style.emoji} ${style.verb}技能：${truncate(skill, limit)}`;
	}

	const raw = firstString(args, PRIMARY_ARGS[toolName] ?? FALLBACK_ARG_KEYS)
		?? firstString(args, FALLBACK_ARG_KEYS);
	if (!raw) return style.verb ? `${style.emoji} ${style.verb}` : `${style.emoji} ${toolName}`;

	const preview = truncate(sanitizeCommand(raw), limit);
	return style.verb ? `${style.emoji} ${style.verb} ${preview}` : `${style.emoji} ${toolName}：${preview}`;
}

/** 追加式日志里的一行：`count > 1` 时渲染成 `(×N)`（hermes `__dedup__` 的等价物）。 */
export interface ProgressLine {
	text: string;
	count: number;
}

export interface ProgressView {
	mode: ProgressMode;
	maxLines: number;
	previewChars: number;
}

export interface ProgressSnapshot {
	startedAt?: number;
	/** 已收尾时传入结束时刻，页脚从「运行中」切到「已完成/已中断」。 */
	finishedAt?: number;
	outcome?: "ok" | "failed" | "stopped";
	now: number;
	/**
	 * 这是**续气泡**：本条消息不再是本轮的第一个进度气泡（发生换气泡后为 true）。
	 *
	 * 换气泡时新消息只写「旧气泡从未展示过的行」，标题标成「执行过程（续）」——
	 * 一轮长任务因此读成一段连续日志（旧气泡留它自己的窗口、新气泡接着往后写），
	 * 而不是把旧气泡的尾部原样再贴一遍。
	 */
	continued?: boolean;
}

/** 把毫秒渲染成紧凑时长（`12.4s` / `2m30s`）。 */
export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 60_000) return `${(safe / 1_000).toFixed(1)}s`;
	return `${Math.floor(safe / 60_000)}m${Math.round((safe % 60_000) / 1_000)}s`;
}

/**
 * 渲染完整进度消息正文。
 *
 * 结构（对齐已确认的群聊视图）：
 * ```
 * 🤖 执行过程
 * …（共 23 步，仅显示最后 6 步）
 * 📖 读取技能：quanbu-login
 * 💻 运行 docker logs --tail 80 dm-pi-agent (×3)
 * ⏱ 12.4s
 * ```
 * 尚无工具行时标题为「正在处理…」（首次渲染不突兀）；收尾后标题固定为「执行过程」并由
 * 页脚（✅/⚠️）交代结果，避免出现「正在处理… + 已完成」这种自相矛盾的一屏。
 *
 * 传入的 `lines` 是**本条气泡自己的窗口**（调用方按气泡切片），不是全量日志：
 * 换气泡时新气泡只拿它该展示的那部分，因此不会重复旧气泡的内容。
 */
export function renderProgressText(
	lines: ProgressLine[],
	thinking: string | undefined,
	view: ProgressView,
	snapshot: ProgressSnapshot,
): string {
	const finished = snapshot.finishedAt !== undefined;
	const title = snapshot.continued ? "🤖 执行过程（续）" : "🤖 执行过程";
	const header = finished || lines.length > 0 ? title : "🤖 正在处理…";
	const output: string[] = [header];

	const maxLines = Math.max(1, view.maxLines);
	const shown = lines.slice(-maxLines);
	const hidden = lines.length - shown.length;
	if (hidden > 0) output.push(`…（共 ${lines.length} 步，仅显示最后 ${shown.length} 步）`);
	for (const line of shown) output.push(line.count > 1 ? `${line.text} (×${line.count})` : line.text);

	if (thinking) output.push(`💭 ${thinking}`);

	const startedAt = snapshot.startedAt;
	if (startedAt !== undefined) {
		const elapsed = formatDuration((snapshot.finishedAt ?? snapshot.now) - startedAt);
		if (finished) {
			const label = snapshot.outcome === "ok" ? "✅ 完成" : snapshot.outcome === "stopped" ? "⏹ 已中断" : "⚠️ 执行失败";
			output.push(`${label} · ${elapsed}`);
		} else {
			output.push(`⏱ ${elapsed}`);
		}
	}
	return output.join("\n");
}
