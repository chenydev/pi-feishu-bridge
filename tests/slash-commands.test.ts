import assert from "node:assert/strict";
import { test } from "node:test";
import { FEISHU_SLASH_COMMANDS, formatSlashCommandHelp } from "../src/slash-commands.js";

test("斜杠命令帮助完整列出 V2 支持的命令和用途", () => {
	const help = formatSlashCommandHelp();
	for (const command of ["/help", "/commands", "/new", "/stop", "/steer <内容>", "/queue <内容>", "/q", "/compact", "/model", "/models", "/thinking", "/sessions", "/name", "/resume", "/workspace", "/feishu status", "/feishu usage", "/feishu doctor", "/feishu export", "/feishu policy", "/feishu always", "/feishu footer"]) {
		assert.match(help, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(help, /普通消息等价于 steer/);
	assert.equal(FEISHU_SLASH_COMMANDS.length, 20, "P1/P2 新增命令（含 /workspace、/feishu always、/feishu usage、/feishu footer）");
});
