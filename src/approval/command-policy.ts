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
	// `cd` 只切换目录、不修改任何东西（Agent 常写 `cd /workspace && git status`）。
	// 后续命令仍按各自命令名独立判定，所以放行 cd 不会让危险命令漏网。
	"cd",
	"git", "jq", "yq", "tree", "basename", "dirname", "realpath", "readlink", "env", "printenv",
]);

/** `git` 中**永远只读**的子命令；其余（push/commit/reset/clean…）一律走审批。 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"status", "diff", "log", "show",
	"blame", "describe", "rev-parse", "ls-files", "ls-tree", "cat-file", "shortlog", "whatchanged", "grep",
]);

/**
 * **多态**子命令：同一子命令既能读也能写，必须看参数才能判定。
 * 修复前把 branch/tag/remote/config 当作永远只读 —— 但
 * `git config --global user.name x`、`git remote add`、`git tag v1`、`git branch foo`
 * 都是**写操作**，会被误放。这是安全性问题，宁可判为询问。
 *
 * `readArgCount`：不带「写选项」时，额外的非选项参数个数不超过该值才算只读。
 *   git branch          → 0 个参数 = 列分支（读）
 *   git branch -a       → 0 个（-a 是选项）= 读
 *   git branch foo      → 1 个 = 创建分支（写）
 *   git config user.name      → 1 个 = 查询（读）
 *   git config user.name foo  → 2 个 = 赋值（写）
 */
const GIT_POLYMORPHIC_SUBCOMMANDS: Record<string, number> = {
	branch: 0,
	tag: 0,
	remote: 0,
	config: 1,
};

/** 显式只读选项：出现即强制判定为读（即使参数个数超限）。 */
const GIT_READ_OPTIONS = ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"];

/** 危险命令：直接拒绝，连审批都不给（避免"手滑点批准"）。 */
const DANGEROUS_COMMANDS = new Set([
	"rm", "dd", "mkfs", "fdisk", "parted", "shred", "wipefs",
	"shutdown", "reboot", "halt", "poweroff", "init",
	"sudo", "su", "doas", "chown", "chgrp", "useradd", "userdel", "passwd", "visudo",
	"iptables", "nft", "ufw", "mount", "umount", "swapoff", "mkswap",
]);

/** 危险模式（正则）：命中即拒绝。 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
	// 锚定到「命令位」（行首或分隔符之后）——否则 `grep -rn 'rm -rf /' docs/` 这类
	// 只是"文本里提到"的只读搜索也会被拒，且无法通过审批绕过。
	{ re: /(?:^|[;&|]|\n)\s*rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/(?!tmp\/|var\/tmp\/)|\/\*|~|\$HOME)\b/, reason: "递归删除根目录或家目录" },
	{ re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork 炸弹" },
	{ re: /(?:^|[;&|]|\n)\s*mkfs(\.\w+)?\b/, reason: "格式化文件系统" },
	{ re: /(?:^|[;&|]|\n)\s*dd\b[^\n]*\bof=\/dev\//, reason: "向块设备写入" },
	{ re: />\s*\/dev\/[sh]d[a-z]/, reason: "覆盖磁盘设备" },
	{ re: /(?:^|[;&|]|\n)\s*chmod\s+(-R\s+)?0?777\s+\//, reason: "把根目录权限改为 777" },
	{ re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/, reason: "下载内容直接管道给 shell 执行" },
	{ re: /\bgit\s+push\b[^\n]*(--force\b|(?<!-)-f\b)/, reason: "强制推送（可能覆盖远端历史）" },
	{ re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx])/, reason: "丢弃本地改动" },
];

/** 复合结构：出现即要求逐段判定；无法安全拆分时降级为 ask。 */
// P1 修复：原正则不含 `&` 与换行，导致 `ls & git push`、多行脚本的第二行之后完全不判 → 放行任意命令
const COMPOUND_SEPARATOR = /\s*(?:&&|\|\||;|\||&|\r?\n)\s*/;
/** 这些构造让静态判定不可靠：命令替换、进程替换、后台执行、eval 类。 */
const UNSAFE_CONSTRUCTS: Array<{ re: RegExp; reason: string }> = [
	{ re: /\$\(|`/, reason: "包含命令替换，内容无法静态判定" },
	{ re: /<\(|>\(/, reason: "包含进程替换" },
	{ re: /&\s*$/, reason: "后台执行" },
	{ re: /\beval\b|\bexec\b|\bsource\b|^\s*\.\s/, reason: "动态执行" },
];
/** 写重定向：只读判定必须失效。 */
// P4 修复：原正则要求 `>` 前不是数字，于是 `2>/etc/x`、`1>&2` 全部漏判。
// 改为先剔除无副作用 fd 复制（2>&1 / 1>&2 / >&2），再看还有没有 `>`。
const FD_DUP = /[0-9]*>&[0-9-]+/g;
function hasWriteRedirect(text: string): boolean {
	return />/.test(text.replace(FD_DUP, ""));
}

/**
 * 白名单命令的「越权参数」：命令本身只读，但某个参数能让它执行任意操作/写文件。
 * 命中即收回白名单、降级为询问 —— 否则白名单形同虚设（`find -exec rm` 就是任意命令执行）。
 */
const ALLOWLIST_ESCAPES: Array<{ re: RegExp; reason: string }> = [
	{ re: /\bfind\b[^\n]*\s-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/, reason: "find 带执行/删除/写文件动作" },
	{ re: /\bsort\b[^\n]*\s(-o|-\-output)\b/, reason: "sort 带写文件输出" },
	{ re: /\bdate\b[^\n]*\s(-s|--set)\b/, reason: "date 带设置系统时间" },
	{ re: /\benv\b\s+\S+\s+\S/, reason: "env 可用于执行其他命令" },
	// P2 修复：白名单里还有这些命令，带特定参数即可执行任意命令/写任意文件
	{ re: /\bfd\b[^\n]*\s(-x|--exec|-X|--exec-batch)\b/, reason: "fd 带执行动作" },
	{ re: /\brg\b[^\n]*\s--pre\b/, reason: "rg 带 --pre 执行器" },
	{ re: /\btree\b[^\n]*\s(-o|--output)\b/, reason: "tree 带输出文件" },
	{ re: /\buniq\b\s+\S+\s+\S+\s*$/, reason: "uniq 第二参数会写文件" },
	{ re: /\bhostname\b\s+\S/, reason: "hostname 带参数会改主机名" },
	{ re: /\byq\b[^\n]*\s(-i|--inplace)\b/, reason: "yq 原地改写文件" },
	// P3 修复：git 的越权参数（git 分支提前 return，此前完全绕过本表）
	{ re: /\bgit\s+(diff|show|log|grep)\b[^\n]*\s--output\b/, reason: "git 写输出文件" },
	{ re: /\bgit\s+grep\b[^\n]*\s-O\b/, reason: "git grep 指定 pager 可执行命令" },
	{ re: /\bgit\s+config\b[^\n]*\s(--unset|--unset-all|--add|--replace-all|--edit|--remove-section|--rename-section)\b/, reason: "git config 写操作" },
];


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
		// P6：限定在 /tmp、/var/tmp 或相对路径（= 工作目录内）的删除降为「询问」。
		// Agent 需要清理自己产生的临时文件，一刀切 deny 会让它无法收尾；
		// 宿主环境的同类策略同样显式允许 /tmp。系统路径仍保持 deny。
		if (cmd === "rm") {
			const args = trimmed.split(/\s+/).slice(1).filter((t) => !t.startsWith("-"));
			// `~`/`$HOME`/`$VAR` 开头的"相对"路径不算工作目录内 —— 它们展开后是家目录或未知位置
			const safePaths = args.length > 0 && args.every((path) =>
				path.startsWith("/tmp/") || path.startsWith("/var/tmp/")
				|| (!path.startsWith("/") && !path.startsWith("~") && !path.startsWith("$")));
			if (safePaths) return { verdict: "ask", reason: "删除临时/工作目录内的文件" };
		}
		return { verdict: "deny", reason: `危险命令：${cmd}` };
	}
	if (hasWriteRedirect(trimmed)) {
		return { verdict: "ask", reason: "包含写重定向" };
	}
	// P3 修复：越权参数检查必须在 git 分支之前 —— 否则 git 的 --output/-O/--unset 等
	// 会在下一行提前 return，永远走不到 ALLOWLIST_ESCAPES。
	for (const { re, reason } of ALLOWLIST_ESCAPES) {
		if (re.test(trimmed)) return { verdict: "ask", reason };
	}
	if (cmd === "git") {
		const tokens = trimmed.split(/\s+/);
		const sub = tokens.find((t) => !t.startsWith("-") && t !== "git") ?? "";
		if (GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
			return { verdict: "allow", reason: `只读：git ${sub}` };
		}
		if (sub in GIT_POLYMORPHIC_SUBCOMMANDS) {
			if (GIT_READ_OPTIONS.some((opt) => tokens.includes(opt))) {
				return { verdict: "allow", reason: `只读：git ${sub}（显式只读选项）` };
			}
			// 统计「子命令之后」的非选项参数个数
			const afterSub = tokens.slice(tokens.indexOf(sub) + 1).filter((t) => !t.startsWith("-"));
			const limit = GIT_POLYMORPHIC_SUBCOMMANDS[sub]!;
			if (afterSub.length <= limit) {
				return { verdict: "allow", reason: `只读：git ${sub}（查询）` };
			}
			return { verdict: "ask", reason: `git ${sub} 带参数可写仓库配置/引用` };
		}
		return { verdict: "ask", reason: `git ${sub} 可能修改仓库` };
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

	// fork 炸弹无论在什么位置出现都是灾难，保留整串预检
	if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) {
		return { verdict: "deny", reason: "fork 炸弹" };
	}
	// 「下载内容直接管道给 shell 执行」：分段后会丢失管道语义，必须在整串上判
	if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/.test(raw)) {
		return { verdict: "deny", reason: "下载内容直接管道给 shell 执行" };
	}
	for (const { re, reason } of UNSAFE_CONSTRUCTS) {
		if (re.test(raw)) return { verdict: "ask", reason };
	}

	// 复合命令：每一段都必须 allow，整体才 allow；任一段 deny，整体 deny。
	// 注意：先剔除 fd 复制（`2>&1`），否则其中的 `&` 会被 COMPOUND_SEPARATOR 当成分隔符，
	// 拆出 `>1` 这样的假段并误判为「未知命令 → 询问」（实测 `ls 2>&1` 曾因此被拦）。
	const segments = raw.replace(FD_DUP, " ").split(COMPOUND_SEPARATOR).filter((s) => s.trim().length > 0);
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
