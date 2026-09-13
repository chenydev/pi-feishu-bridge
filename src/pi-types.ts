/**
 * pi 扩展 API 最小本地类型声明（运行时由 pi 提供，结构兼容官方 pi 0.84.x）。
 * 设计依据：docs/DESIGN.md §7.2（只使用官方确认导出的 API；本地声明保持独立 typecheck）。
 */
export interface ExtensionUI {
	setStatus(key: string, text: string): void;
	notify(message: string, type?: "warning" | "info" | "error"): void;
}

export interface ExtensionCommandContext {
	cwd: string;
	session: unknown;
}

export interface ExtensionRuntimeContext {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

export interface ExtensionToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
	isError?: boolean;
}

export interface ExtensionAPI {
	getAgentDir(): string;
	getPackageDir(): string;
	ui: ExtensionUI;
	on(event: string, handler: (event: unknown, ctx: ExtensionRuntimeContext) => unknown | Promise<unknown>): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: Record<string, unknown>;
		execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionRuntimeContext): Promise<ExtensionToolResult>;
	}): void;
	registerCommand(
		name: string,
		opts: {
			description?: string;
			handler: (args: string, ctx: ExtensionCommandContext, argsList: string[]) => string | Promise<string>;
		},
	): void;
	appendEntry(customType: string, data: unknown): void;
}
