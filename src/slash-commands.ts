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
	{ usage: "/feishu status", description: "查看连接、会话、队列和 outbox 状态" },
	{ usage: "/feishu doctor", description: "运行飞书桥配置与运行环境诊断" },
	{ usage: "/feishu policy <策略>", description: "管理员设置当前群策略" },
];

export function formatSlashCommandHelp(): string {
	return [
		"V2 支持的斜杠命令：",
		...FEISHU_SLASH_COMMANDS.map((entry) => `${entry.usage}\n  ${entry.description}`),
		"",
		"忙碌时直接发送普通消息等价于 steer；需要等待当前任务完整结束时使用 /queue。",
	].join("\n");
}
