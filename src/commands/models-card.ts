/**
 * 模型列表卡片：把 /models 的纯文本分页换成**表格卡片**。
 *
 * 为什么是表格而不是按钮列表：模型常有几十个，「有哪些」是查看型需求，
 * 不是选择型需求 —— 切换模型本来就有 /model <provider>/<id> 命令。
 * 用按钮把列表变成表单反而逼着用户去点，而我们要的是**能看清、能复制**。
 *
 * 分页由飞书客户端完成（table 组件的 page_size），**不经过服务端回调**：
 * 老实现靠按钮回调 + 按 conversationKey 查内存会话，会话被空闲回收后翻页就失效；
 * 表格分页没有这个问题，也不需要我们在 value 里塞会话标识。
 *
 * 单元格用纯文本（data_type: "text"）而非 markdown 反引号：实测两者都能正常
 * 选中复制，纯文本在移动端的排版更紧凑。
 */

export interface ModelEntry {
	id: string;
	provider?: string;
	/** 显示名（可选：不是所有模型来源都提供）。 */
	name?: string;
}

export interface ModelsTableInput {
	models: ModelEntry[];
	currentId: string;
	/** 每页行数。table 组件的 page_size，客户端翻页用。 */
	pageSize?: number;
}

export const MODELS_TABLE_PAGE_SIZE = 10;

/** 状态卡里档位按钮每行放几个（固定等宽，放不下换行）。 */
export const THINKING_LEVELS_PER_ROW = 3;

/** provider/id 形式（同一 id 可能来自不同 provider，必须带前缀才能无歧义）。 */
export function modelLabel(entry: ModelEntry): string {
	return entry.provider ? `${entry.provider}/${entry.id}` : entry.id;
}

/**
 * 「已执行」区块 —— **独立一块**（上下各一条分割线 + 引用块）。
 *
 * 单独成块而不是混在正文里：它是"回执"，与设置项、说明文字是不同性质的信息，
 * 贴在一起容易被当成正文的一部分读过去。
 *
 * 只用在**状态卡**上：那张卡的按钮会让卡片内容发生变化（档位/模型的勾要移动），
 * 所以需要一条回执说明"刚才跑的是什么命令"。表格卡片是纯展示的列表，
 * 从它那里点进来的场景不需要回执（用户自己知道点了什么）。
 */
function executedBlock(command?: string): unknown[] {
	if (!command) return [];
	return [
		{ tag: "hr" },
		{ tag: "markdown", content: `> **已执行**：\`${command}\`` },
		{ tag: "hr" },
	];
}

/** 表格元素（供独立表格卡片与状态卡的展开态共用）。 */
function tableElements(models: ModelEntry[], currentId: string, pageSize = MODELS_TABLE_PAGE_SIZE): unknown[] {
	const rows = models.map((entry) => ({
		model: modelLabel(entry),
		...(entry.name ? { name: entry.name } : {}),
	}));

	// 名称列只在真的有数据时出现 —— 全空的一列比没有这一列更难看。
	const hasName = rows.some((row) => row.name !== undefined);
	const columns = [
		{ name: "model", display_name: "模型（provider/model）", data_type: "text", width: "auto" },
		...(hasName ? [{ name: "name", display_name: "名称", data_type: "text", width: "auto" }] : []),
	];

	return [{
		tag: "table",
		page_size: pageSize,
		row_height: "low",
		header_style: {
			text_align: "left",
			text_size: "normal",
			background_style: "grey",
			text_color: "default",
			bold: true,
		},
		columns,
		rows,
	}];
}

export function buildModelsTable(input: ModelsTableInput): unknown {
	const pageSize = input.pageSize ?? MODELS_TABLE_PAGE_SIZE;
	const current = input.models.find((m) => m.id === input.currentId);

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: {
			title: { tag: "plain_text", content: `可用模型（${input.models.length}）` },
			template: "blue",
		},
		body: {
			elements: [
				{
					tag: "markdown",
					content: `当前：**${current ? modelLabel(current) : input.currentId}**\n`
						+ "切换用 `/model <provider>/<模型>`。表格可翻页，单元格可直接选中复制。",
				},
				...tableElements(input.models, input.currentId, pageSize),
			],
		},
	};
}

// ────────────────────────────────────── /model 状态卡 ────────────────────

export interface ModelStatusInput {
	/** 当前模型（已尽量补上 provider 前缀，便于直接复制）。 */
	currentLabel: string;
	thinkingLevel?: string;
	/** 可用档位（来自 agent.availableThinkingLevels()）。 */
	availableLevels?: string[];
	/** 回调时用于定位会话（卡片发到哪个会话，就带哪个 key）。 */
	conversationKey: string;
	/**
	 * 刚刚通过这张卡片执行的命令（如 `/thinking high`）。
	 *
	 * 卡片按钮是黑盒：点完只知道"变了"，不知道背后跑了什么。把刚执行的命令写出来，
	 * 用户才能复制它去加 `-g`、转发给别人、或记进笔记。只有回调触发的重渲染才带它。
	 */
	lastExecuted?: string;
	/**
	 * 是否已展开模型表格（点 `/models` 展开；**任何刷新都回到收起**）。
	 *
	 * 展开只是"这一次渲染"的形态，不记忆：点档位刷新后表格自动收起 —— 用户要的是
	 * 干净的状态卡，表格是临时查阅用的。因此桥侧**不需要**为每个会话存展开状态。
	 */
	expanded?: boolean;
	/** 展开时并入的模型清单（收起时不传，省一次 listModels）。 */
	models?: ModelEntry[];
}

/** 两列 key-value（column_set）：标签与值严格左对齐，比全角空格排版可靠。 */
function kvRow(label: string, value: string, bold = false): unknown {
	return {
		tag: "column_set",
		flex_mode: "none",
		horizontal_spacing: "default",
		columns: [
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{ tag: "markdown", content: label, text_align: "left" }],
			},
			{
				tag: "column",
				width: "weighted",
				weight: 3,
				elements: [{ tag: "markdown", content: bold ? `**${value}**` : value, text_align: "left" }],
			},
		],
	};
}

/**
 * 状态卡：只回答「我现在用什么、怎么换」，不重复候选列表（那在 /models 里）。
 *
 * 两个按钮都是**动作**而非状态展示：
 * - 档位按钮：点一下切换思考等级（等价于 /thinking <level>）
 * - 「查看全部模型」：点一下触发 /models 的效果（发一张模型表格卡片）
 *
 * ⚠️ 按钮回调要按 conversationKey 找回会话，因此**会话被空闲回收后点击会失效**
 * （与旧的 /models 翻页按钮同一限制）。表格分页没这个问题，因为它在客户端完成。
 */
export function buildModelStatusCard(input: ModelStatusInput): unknown {
	const elements: unknown[] = [
		// 「已执行」放**最上面**：它属于「刚刚发生了什么」，最新信息该在最先看到的位置
		// （像聊天记录倒序）。夹在按钮与说明之间时容易被当成正文读过去。
		...executedBlock(input.lastExecuted),
		{ tag: "markdown", content: `**${input.currentLabel}**` },
		{ tag: "hr" },
	];

	// 档位：一行标签 + 一排按钮。当前档位禁用并打勾，避免"点了没变化"的困惑。
	const levels = input.availableLevels ?? [];
	if (input.thinkingLevel) {
		if (levels.length > 0) {
			elements.push(kvRow("思考等级", input.thinkingLevel, true));
			// 档位排版：标签独占一行，按钮**每行 3 个**（等宽），放不下的换行。
			//
			// 不把标签和按钮塞在同一行：pi 最多 6 档（minimal/low/medium/high/max/xhigh），
			// 一行平分下来每个按钮只剩一两个字母宽，手机端没法点。
			// 也不用 flex_mode:"flow" 自动换行：那会让按钮宽度随文字长短参差
			// （"xhigh" 比 "low" 宽），六个按钮排起来很乱；固定 3 列等宽更像一组。
			//
			// 注意**不要嵌套 column_set**（column 里再放 column_set）：飞书会拒卡
			// （230099 / ErrPath: ...(tag: column_set); ErrMsg: invalid width）。
			// L3 方案是在顶层平铺多行 column_set，不涉及嵌套。
			elements.push({ tag: "markdown", content: "可选档位" });
			const PER_ROW = THINKING_LEVELS_PER_ROW;
			for (let i = 0; i < levels.length; i += PER_ROW) {
				const row = levels.slice(i, i + PER_ROW);
				const columns: unknown[] = [{
					// 占位列：让按钮与上面的「思考等级」值列左对齐
					tag: "column", width: "weighted", weight: 1,
					elements: [{ tag: "markdown", content: " " }],
				}];
				for (const level of row) {
					columns.push({
						tag: "column", width: "weighted", weight: 1,
						elements: [{
							tag: "button",
							size: "small",
							// 有颜色的才是可点的：可点 = primary（蓝），当前 = default（灰）+ 禁用 + 勾。
							// 反过来（当前蓝、可点灰）会让灰色按钮看着像不可点，正是要避免的。
							type: level === input.thinkingLevel ? "default" : "primary",
							disabled: level === input.thinkingLevel,
							text: {
								tag: "plain_text",
								content: level === input.thinkingLevel ? `✓ ${level}` : level,
							},
							value: { op: "thinking.set", level, conversationKey: input.conversationKey },
						}],
					});
				}
				// 末行不足时补空列，保持与上一行等宽（否则最后一行的按钮会被拉伸）
				for (let k = row.length; k < PER_ROW; k++) {
					columns.push({
						tag: "column", width: "weighted", weight: 1,
						elements: [{ tag: "markdown", content: " " }],
					});
				}
				elements.push({
					tag: "column_set", flex_mode: "none", horizontal_spacing: "small", columns,
				});
			}

		} else {
			// 模型不支持推理时不显示空按钮组 —— 一张空的按钮行比没有更让人困惑
			elements.push(kvRow("思考等级", `${input.thinkingLevel}（当前模型无可用档位）`));
		}
	}

	elements.push({ tag: "hr" });
	elements.push({
		tag: "column_set",
		flex_mode: "none",
		horizontal_spacing: "default",
		columns: [
			{
				tag: "column", width: "weighted", weight: 1,
				elements: [{ tag: "markdown", content: "模型列表", text_align: "left" }],
			},
			{
				tag: "column", width: "weighted", weight: 3,
				elements: [{
					tag: "button", size: "small", type: "primary",
					text: {
						tag: "plain_text",
						content: input.expanded ? "收起模型列表" : "/models",
					},
					value: {
						op: "models.toggle",
						expanded: !input.expanded,
						conversationKey: input.conversationKey,
					},
				}],
			},
		],
	});
	elements.push(kvRow("切换模型", "`/model <provider>/<模型>`"));
	// 底部小字：把「怎么把改动变成全局默认」写在入口旁边 —— 否则这个能力
	// 只有读过文档的人知道，而卡片是绝大多数人唯一的入口。
	elements.push({
		tag: "markdown",
		text_size: "notation",
		content: "以上操作都等价于对应的斜杠命令。**加 `-g`（或 `--global`）可设为全局默认**，"
			+ "对**之后新建的**会话生效（当前会话不受影响）。",
	});

	// 展开：把模型表格并进同一张卡（用户要的就是「一张卡、表格在下面」）。
	// 复用 buildModelsTable 的表格元素，避免两处各写一份、改一处漏一处。
	if (input.expanded) {
		elements.push({ tag: "hr" });
		elements.push({
			tag: "markdown",
			content: `**可用模型（${(input.models ?? []).length}）**　` + "切换用 `/model <provider>/<模型>`",
		});
		elements.push(...tableElements(input.models ?? [], input.currentLabel));
	}

	return {
		schema: "2.0",
		config: { wide_screen_mode: true },
		header: { title: { tag: "plain_text", content: "模型" }, template: "blue" },
		body: { elements },
	};
}
