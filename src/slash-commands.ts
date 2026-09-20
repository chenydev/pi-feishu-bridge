export interface SlashCommandHelp {
	usage: string;
	description: string;
}

/** 飞书端真正由 V2 消费的命令；未知 slash 仍交给 Pi 的扩展/技能/模板解析。 */
export const FEISHU_SLASH_COMMANDS: ReadonlyArray<SlashCommandHelp> = [
	{ usage: "/help（别名 /commands、/feishu help）", description: "列出本帮助" },
	{ usage: "/new", description: "创建新的会话上下文" },
	{ usage: "/stop", description: "中止当前任务；已用 /queue 排队的后续任务保留" },
	{ usage: "/steer <内容>", description: "在当前 assistant turn/工具批次结束后注入；空闲时直接开始" },
	{ usage: "/queue <内容>（别名 /q）", description: "当前任务全部结束后，作为独立 turn FIFO 执行" },
	{ usage: "/compact [说明]", description: "压缩当前会话上下文（忙碌时不可用）" },
	{ usage: "/model [provider/model]", description: "查看或切换模型（忙碌时不可切换）" },
	{ usage: "/models [页]", description: "列出已认证模型（provider/id，分页）" },
	{ usage: "/thinking [等级]", description: "查看或设置当前模型的思考等级" },
	{ usage: "/sessions [页]", description: "浏览本会话可访问的历史（含名称与最近活动）" },
	{ usage: "/name <名称>", description: "重命名当前会话" },
	{ usage: "/workspace [别名]", description: "查看（任何人）或切换（仅管理员）受控工作区" },
	{ usage: "/resume <选择 id>", description: "恢复 /sessions 列出的历史会话（忙碌时不可用）" },
	{ usage: "/feishu status", description: "查看连接、会话、队列和 outbox 状态" },
	{ usage: "/feishu doctor", description: "运行飞书桥可解释诊断（积压/错误类别/限流/待审批）" },
	{ usage: "/feishu export", description: "管理员导出脱敏诊断包（0600，仅计数与枚举）" },
	{ usage: "/feishu policy <策略>", description: "管理员设置当前群策略" },
	{ usage: "/feishu always [revoke <规则名>]", description: "管理员查看/撤销「始终批准」规则" },
];

export function formatSlashCommandHelp(): string {
	return [
		"V2 支持的斜杠命令：",
		...FEISHU_SLASH_COMMANDS.map((entry) => `${entry.usage}\n  ${entry.description}`),
		"",
		"忙碌时直接发送普通消息等价于 steer；需要等待当前任务完整结束时使用 /queue。",
	].join("\n");
}
