/**
 * 模型列表卡片：把 /models 的纯文本分页换成可点按的卡片。
 *
 * 为什么用卡片：模型常有几十个，纯文本一次只能列一页，翻页要靠输入
 * `/models 1`、`/models 2`；卡片可以原地翻页，并让「切换」变成一次点击。
 *
 * 回调契约（与审批卡/澄清卡一致，见 src/index.ts 的 handleCardAction）：
 *   { op: "models", page, conversationKey }
 *   { op: "models.pick", provider, id, conversationKey } —— 直接切换到某个模型
 *   （两个 op 都带 conversationKey：回调不必重建 key，避免按 chatId 猜测用户身份）
 *
 * 安全：卡片只发到发起命令的那个会话，value 里带的 conversationKey 同样是
 * 该会话自己的 key，不构成跨会话信息泄露。真正的切换动作仍由桥在回调里
 * 校验会话归属后执行（见 index.ts），不信任客户端传入的任意模型名以外的内容。
 */

export interface ModelEntry {
	id: string;
	provider?: string;
}

export interface ModelsCardInput {
	models: ModelEntry[];
	currentId: string;
	page: number;
	/** 每页条数。卡片比纯文本更占高度，默认比文本分页小。 */
	pageSize?: number;
	/** 回调时用于定位会话（卡片发到哪个会话，就带哪个 key）。 */
	conversationKey: string;
}

export const MODELS_PAGE_SIZE = 8;

/** provider/id 形式（同一 id 可能来自不同 provider，必须带前缀才能无歧义）。 */
export function modelLabel(entry: ModelEntry): string {
	return entry.provider ? `${entry.provider}/${entry.id}` : entry.id;
}

export function buildModelsCard(input: ModelsCardInput): unknown {
	const pageSize = input.pageSize ?? MODELS_PAGE_SIZE;
	const total = input.models.length;
	const pages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(Math.max(0, input.page), pages - 1);
	const slice = input.models.slice(page * pageSize, page * pageSize + pageSize);

	const elements: unknown[] = [];

	// 当前模型单独一行置顶，翻页时始终可见
	const current = input.models.find((m) => m.id === input.currentId);
	elements.push({
		tag: "markdown",
		content: `当前：**${current ? modelLabel(current) : input.currentId}**`,
	});

	for (const entry of slice) {
		const isCurrent = entry.id === input.currentId;
		elements.push({
			tag: "button",
			text: { tag: "plain_text", content: isCurrent ? `✓ ${modelLabel(entry)}` : modelLabel(entry) },
			type: isCurrent ? "primary" : "default",
			width: "fill",
			...(isCurrent ? { disabled: true } : {}),
			value: { op: "models.pick", provider: entry.provider, id: entry.id, conversationKey: input.conversationKey },
		});
	}

	// 翻页行：只有多于一页时才出现，避免单页场景多两个无用按钮
	if (pages > 1) {
		const nav = (label: string, target: number, disabled: boolean) => ({
			tag: "button",
			text: { tag: "plain_text", content: label },
			type: "default" as const,
			width: "fill",
			disabled,
			value: { op: "models", page: target, conversationKey: input.conversationKey },
		});
		elements.push(nav(`← 上一页（${page === 0 ? 1 : page} / ${pages}）`, page - 1, page === 0));
		elements.push(nav(`下一页（${page + 2 > pages ? pages : page + 2} / ${pages}）`, page + 1, page + 1 >= pages));
	}

	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: `可用模型（${total}）` },
			subtitle: { tag: "plain_text", content: `第 ${page + 1}/${pages} 页` },
			template: "blue",
		},
		body: { elements },
	};
}

/** 点击某个模型后原地替换的卡片：标题改成结论，其余按钮禁用。 */
export function buildModelsCardResolved(input: ModelsCardInput, label: string, ok: boolean, reason: string): unknown {
	const base = buildModelsCard(input) as { header: Record<string, unknown>; body: { elements: unknown[] } };
	const elements = base.body.elements.map((el) => {
		const node = el as Record<string, unknown>;
		if (node.tag !== "button") return node;
		return { ...node, disabled: true, type: "default" };
	});
	elements.splice(1, 0, { tag: "markdown", content: ok ? `已切换到 **${label}**` : reason });
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: `可用模型（${input.models.length}）` },
			subtitle: { tag: "plain_text", content: ok ? `已切换到 ${label}` : reason },
			template: ok ? "green" : "red",
		},
		body: { elements },
	};
}
