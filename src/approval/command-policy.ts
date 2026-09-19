/**
 * 命令级审批策略：让「只读命令」免审、「危险命令」直接拒绝，其余才弹审批卡。
 *
 * 背景：桥原有的 `approval.autoApprove` 是**工具级**白名单 —— 但 `bash` 是同一个工具，
 * `ls` 与 `rm -rf /` 无法区分，只能「全审」或「全放」。结果是每个 shell 命令都要点一次审批，
 * 审批失去意义（用户会无脑点批准）。
 *
 * 本模块按命令语义分级，安全默认：
 *   - 判定不确定时一律归为 "ask"（宁可问，不可放）
 *   - 复合命令（`;` `&&` `||` `|` 串接）要求**每一段**都安全，否则降级
 *   - 出现重定向写、命令替换、后台执行等，一律降级为 "ask"
 */

export type CommandVerdict = "allow" | "ask" | "deny";

export interface CommandPolicyConfig {
	enabled: boolean;
	/** 追加到内置只读白名单的命令名。 */
	extraReadOnly?: string[];
	/** 追加到内置危险黑名单的命令名。 */
	extraDangerous?: string[];
}

export interface CommandPolicyResult {
	verdict: CommandVerdict;
	/** 判定依据（用于审批卡说明与审计）。 */
	reason: string;
}

/**
 * 只读命令白名单：默认只放行「不修改任何东西、也不联网」的命令。
 * 注意 `git` 这类多态命令单独处理（见 GIT_READ_ONLY_SUBCOMMANDS）。
 */
const READ_ONLY_COMMANDS = new Set([
	"ls", "pwd", "whoami", "id", "date", "hostname", "uname", "uptime",
	"cat", "head", "tail", "wc", "nl", "tac", "cut", "sort", "uniq", "tr",
	"grep", "rg", "egrep", "fgrep", "ag", "ack",
	"find", "fd", "locate", "which", "whereis", "type", "file", "stat", "du", "df",
	"echo", "printf", "true", "false", "test", "[",
	"git", "jq", "yq", "tree", "basename", "dirname", "realpath", "readlink", "env", "printenv",
]);

/** `git` 的只读子命令；其余（push/commit/reset/clean…）一律走审批。 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status", "diff", "log", "show", "branch", "tag", "remote", "config",
	"blame", "describe", "rev-parse", "ls-files", "ls-tree", "cat-file", "shortlog", "whatchanged", "grep",
]);

/** 危险命令：直接拒绝，连审批都不给（避免"手滑点批准"）。 */
const DANGEROUS_COMMANDS = new Set([
	"rm", "dd", "mkfs", "fdisk", "parted", "shred", "wipefs",
	"shutdown", "reboot", "halt", "poweroff", "init",
	"sudo", "su", "doas", "chown", "chgrp", "useradd", "userdel", "passwd", "visudo",
	"iptables", "nft", "ufw", "mount", "umount", "swapoff", "mkswap",
]);

/** 危险模式（正则）：命中即拒绝。 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
	{ re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|\/\*|~|\$HOME)\b/, reason: "递归删除根目录或家目录" },
	{ re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, reason: "强制递归删除" },
	{ re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork 炸弹" },
	{ re: /\bmkfs(\.\w+)?\b/, reason: "格式化文件系统" },
	{ re: /\bdd\b[^\n]*\bof=\/dev\//, reason: "向块设备写入" },
	{ re: />\s*\/dev\/[sh]d[a-z]/, reason: "覆盖磁盘设备" },
	{ re: /\bchmod\s+(-R\s+)?0?777\s+\//, reason: "把根目录权限改为 777" },
	{ re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/, reason: "下载内容直接管道给 shell 执行" },
	{ re: /\bgit\s+push\b[^\n]*(--force\b|(?<!-)-f\b)/, reason: "强制推送（可能覆盖远端历史）" },
	{ re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx])/, reason: "丢弃本地改动" },
];

/** 复合结构：出现即要求逐段判定；无法安全拆分时降级为 ask。 */
const COMPOUND_SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;
/** 这些构造让静态判定不可靠：命令替换、进程替换、后台执行、eval 类。 */
const UNSAFE_CONSTRUCTS: Array<{ re: RegExp; reason: string }> = [
	{ re: /\$\(|`/, reason: "包含命令替换，内容无法静态判定" },
	{ re: /<\(|>\(/, reason: "包含进程替换" },
	{ re: /&\s*$/, reason: "后台执行" },
	{ re: /\beval\b|\bexec\b|\bsource\b|^\s*\.\s/, reason: "动态执行" },
];
/** 写重定向：只读判定必须失效。 */
const WRITE_REDIRECT = /(^|[^0-9])>>?\s*[^\s>]|(^|[^0-9])>>?\s*$/;

function firstWord(segment: string): string {
	// 跳过前置的变量赋值（FOO=bar cmd），取真正的命令名
	const tokens = segment.trim().split(/\s+/);
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
	return (tokens[i] ?? "").replace(/^[\\'"]+/, "");
}

/** 判定单段（已拆分）命令。 */
function classifySegment(segment: string, cfg: Required<CommandPolicyConfig>): CommandPolicyResult {
	const trimmed = segment.trim();
	if (!trimmed) return { verdict: "ask", reason: "空命令段" };

	for (const { re, reason } of DANGEROUS_PATTERNS) {
		if (re.test(trimmed)) return { verdict: "deny", reason };
	}
	const cmd = firstWord(trimmed);
	if (!cmd) return { verdict: "ask", reason: "无法识别命令名" };
	if (DANGEROUS_COMMANDS.has(cmd) || cfg.extraDangerous.includes(cmd)) {
		return { verdict: "deny", reason: `危险命令：${cmd}` };
	}
	if (WRITE_REDIRECT.test(trimmed)) {
		return { verdict: "ask", reason: "包含写重定向" };
	}
	if (cmd === "git") {
		const sub = trimmed.split(/\s+/).find((t) => !t.startsWith("-") && t !== "git") ?? "";
		return GIT_READ_ONLY_SUBCOMMANDS.has(sub)
			? { verdict: "allow", reason: `只读：git ${sub}` }
			: { verdict: "ask", reason: `git ${sub} 可能修改仓库` };
	}
	if (READ_ONLY_COMMANDS.has(cmd) || cfg.extraReadOnly.includes(cmd)) {
		return { verdict: "allow", reason: `只读命令：${cmd}` };
	}
	return { verdict: "ask", reason: `${cmd} 未在只读白名单内` };
}

/**
 * 判定一条 bash 命令。
 * 返回值：allow（免审执行）/ ask（弹审批卡）/ deny（直接拒绝）。
 */
export function classifyCommand(
	command: string,
	policy?: Partial<CommandPolicyConfig>,
): CommandPolicyResult {
	const cfg: Required<CommandPolicyConfig> = {
		enabled: policy?.enabled ?? true,
		extraReadOnly: policy?.extraReadOnly ?? [],
		extraDangerous: policy?.extraDangerous ?? [],
	};
	if (!cfg.enabled) return { verdict: "ask", reason: "命令策略未启用" };
	const raw = command.trim();
	if (!raw) return { verdict: "ask", reason: "空命令" };

	for (const { re, reason } of DANGEROUS_PATTERNS) {
		if (re.test(raw)) return { verdict: "deny", reason };
	}
	for (const { re, reason } of UNSAFE_CONSTRUCTS) {
		if (re.test(raw)) return { verdict: "ask", reason };
	}

	// 复合命令：每一段都必须 allow，整体才 allow；任一段 deny，整体 deny。
	const segments = raw.split(COMPOUND_SEPARATOR).filter((s) => s.trim().length > 0);
	// 用分隔符还原失败（例如引号内含分号）时保守处理：段数异常则走 ask
	if (segments.length === 0) return { verdict: "ask", reason: "无法拆分命令" };
	let sawAsk: string | undefined;
	for (const segment of segments) {
		const result = classifySegment(segment, cfg);
		if (result.verdict === "deny") return result;
		if (result.verdict === "ask" && !sawAsk) sawAsk = result.reason;
	}
	if (sawAsk) return { verdict: "ask", reason: sawAsk };
	return { verdict: "allow", reason: `全部为只读命令（${segments.length} 段）` };
}
