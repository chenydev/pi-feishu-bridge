/**
 * pi 会话后端：每个 chat 一个 createAgentSession（B3 根治：会话隔离）。
 * 设计依据：docs/DESIGN.md §3.4；API 契约见 DESIGN §7.2（只使用官方导出）。
 */
import { join } from "node:path";
import type { PiImageContent, SessionBackend } from "../types.js";
import { stripGatewayExtensions, type ExtensionDiscoveryResult, type InlineBridgeExtension } from "./pi-bridge-hooks.js";

interface PiSdk {
	getAgentDir(): string;
	SessionManager: {
		open(file: string, opts?: unknown, cwd?: string): unknown;
	
		list(cwd: string, sessionDir?: string): Promise<PiSessionListInfo[]>;
	};
	DefaultResourceLoader: new (options: {
		cwd: string;
		agentDir: string;
		extensionFactories?: InlineBridgeExtension[];
		extensionsOverride?: (base: unknown) => unknown;
	}) => { reload(options?: unknown): Promise<void> };
	createAgentSession(opts: {
		session?: unknown;
		sessionManager?: unknown;
		cwd: string;
		modelId?: string;
		resourceLoader?: unknown;
		customTools?: unknown[];
	}): Promise<{ session: PiAgentSession }>;
}

interface PiSessionListInfo {
	path: string;
	id: string;
	name?: string;
	modified: Date | string | number;
	messageCount?: number;
}

interface PiAgentSession {
	sessionId: string;
	model: { id: string };
	prompt(text: string, opts?: { images?: PiImageContent[] }): Promise<unknown>;
	steer(text: string, images?: PiImageContent[]): Promise<void>;
	followUp(text: string, images?: PiImageContent[]): Promise<void>;
	subscribe(fn: (event: unknown) => void): () => void;
	abort(): Promise<void>;
	dispose(): void;
	compact(instructions?: string): Promise<{ summary?: string; tokens?: number }>;
	setModel(model: { id: string; provider?: string }): Promise<void>;
	modelRuntime: { getAvailable(providerId?: string): Promise<ReadonlyArray<{ id: string; provider?: string }>> };
	/** P1-06：思考等级（可选，老版本 SDK 可能没有）。 */
	thinkingLevel?: string;
	setThinkingLevel?(level: string): void;
	getAvailableThinkingLevels?(): string[];
	/** P1-04：会话名称（Pi transcript 中的 session_info）。 */
	sessionName?: string;
	setSessionName?(name: string): void;
}

export interface PiSessionBackendDeps {
	/** 会话文件目录（默认 config.sessionDir 由桥层传入）。 */
	sessionDir: string;
	modelId?: string;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
	/**
	 * P0-02：注入到每个子会话的桥侧内联扩展（tool_call 审批 gate + 文件工具）。
	 * 不设时子会话不会挂载桥的审批/工具（outer session 的 hook 不会转发进子会话）。
	 */
	bridgeExtensionFactory?: InlineBridgeExtension;
	/** P0-02：子会话扩展发现时剔除网关扩展（默认启用，防止每个子会话重复启动飞书 WS）。 */
	filterGatewayExtensions?: boolean;
	/** 网关扩展识别特征（默认 ["pi-feishu-bridge"]）。 */
	gatewayExtensionMarkers?: string[];
	/** agent 配置目录；默认用 sdk.getAgentDir()。 */
	agentDir?: string;
}

export class PiSessionBackend implements SessionBackend {
	private sdk: PiSdk | undefined;

	constructor(private deps: PiSessionBackendDeps) {}

	private async ensureSdk(): Promise<PiSdk> {
		if (this.sdk) return this.sdk;
		const sdk = (await import("@earendil-works/pi-coding-agent")) as unknown as PiSdk;
		this.sdk = sdk;
		return sdk;
	}

	/**
	 * P0-02：为子会话构造 ResourceLoader —— 注入桥侧 hook，并从扩展发现中剔除网关扩展。
	 * 返回 undefined 表示既不注入也不过滤（保持 SDK 默认行为）。
	 * 失败时抛出：注入失败不能静默降级成“子会话无审批”。
	 */
	private async buildResourceLoader(sdk: PiSdk, cwd: string): Promise<unknown | undefined> {
		const factory = this.deps.bridgeExtensionFactory;
		const filter = this.deps.filterGatewayExtensions !== false;
		if (!factory && !filter) return undefined;
		const agentDir = this.deps.agentDir ?? sdk.getAgentDir();
		const markers = this.deps.gatewayExtensionMarkers ?? ["pi-feishu-bridge"];
		const options: Record<string, unknown> = {
			cwd,
			agentDir,
			extensionFactories: factory ? [factory] : [],
		};
		if (filter) {
			options.extensionsOverride = (base: unknown) =>
				stripGatewayExtensions(base as ExtensionDiscoveryResult, markers);
		}
		try {
			const loader = new sdk.DefaultResourceLoader(options as never);
			await loader.reload();
			this.deps.log?.("debug", "feishu.session.resource_loader_ready", {
				cwd, agentDir, injected: Boolean(factory), filtered: filter,
			});
			return loader;
		} catch (error) {
			this.deps.log?.("error", "feishu.session.resource_loader_failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async createSession(opts: { chatId: string; conversationKey: string; sessionFile?: string; cwd?: string }): Promise<{
		sessionId: string;
			prompt(text: string, images?: PiImageContent[]): Promise<unknown>;
			steer(text: string, images?: PiImageContent[]): Promise<void>;
			followUp(text: string, images?: PiImageContent[]): Promise<void>;
		subscribe(fn: (event: unknown) => void): () => void;
		abort(): Promise<void>;
			dispose(): Promise<void>;
			modelId: string;
			compact(instructions?: string): Promise<string>;
			setModel(modelId: string): Promise<boolean>;
			listModels(): Promise<Array<{ id: string; provider?: string }>>;
			availableThinkingLevels(): string[];
			thinkingLevel(): string;
			setThinkingLevel(level: string): void;
			listSessions(): Promise<Array<{ path: string; id: string; name?: string; modified: number; messageCount: number }>>;
			sessionName(): string | undefined;
			setSessionName(name: string): void;
	}> {
		const sdk = await this.ensureSdk();
		// P2-02：按会话传入的 cwd（默认进程 cwd）；不修改 process.cwd()
		const cwd = opts.cwd ?? process.cwd();
		const sessionDir = this.deps.sessionDir;
		const sessionFile = opts.sessionFile ?? join(sessionDir, `${opts.chatId}.jsonl`);

		let sessionManager: unknown;
		try {
			sessionManager = sdk.SessionManager.open(sessionFile, undefined, cwd);
		} catch (err) {
			this.deps.log?.("error", "feishu.session.open_failed", { sessionFile, error: err instanceof Error ? err.message : String(err) });
			throw err;
		}

		// P0-02：把桥侧 hook 注入子会话（并剔除会重复启动网关的扩展）。
		const resourceLoader = await this.buildResourceLoader(sdk, cwd);

		const { session: createdSession } = await sdk.createAgentSession({
			session: sessionManager,
			sessionManager,
			cwd,
			modelId: this.deps.modelId,
			...(resourceLoader ? { resourceLoader } : {}),
		});
		const agentSession = createdSession as PiAgentSession;
		this.deps.log?.("info", "feishu.session.created", { chatId: opts.chatId, sessionId: agentSession.sessionId, sessionFile });

		return {
			sessionId: agentSession.sessionId,
				async prompt(text, images) {
					return agentSession.prompt(text, { images });
				},
				async steer(text, images) {
					await agentSession.steer(text, images);
				},
				async followUp(text, images) {
					await agentSession.followUp(text, images);
				},
			subscribe(fn) {
				return agentSession.subscribe(fn);
			},
			async abort() {
				await agentSession.abort();
			},
			async dispose() {
				agentSession.dispose();
			},
			get modelId() { return agentSession.model?.id ?? "default"; },
			async compact(instructions) {
				const result = await agentSession.compact(instructions);
				return result.summary ? `会话已压缩：${result.summary.slice(0, 200)}` : "会话已压缩";
			},
			async setModel(modelId) {
				const slash = modelId.indexOf("/");
				const provider = slash > 0 ? modelId.slice(0, slash) : undefined;
				const id = slash > 0 ? modelId.slice(slash + 1) : modelId;
				const available = await agentSession.modelRuntime.getAvailable(provider);
				const found = available.find((model) => model.id === id && (!provider || model.provider === provider));
				if (!found) return false;
				await agentSession.setModel(found);
				return true;
			},
			// P1-06：模型候选与思考等级（能力缺失时给空值，由上层提示"不支持"）
			async listModels() {
				const available = await agentSession.modelRuntime.getAvailable();
				return available.map((model) => ({ id: model.id, provider: model.provider }));
			},
			availableThinkingLevels() {
				try { return agentSession.getAvailableThinkingLevels?.() ?? []; } catch { return []; }
			},
			thinkingLevel() {
				try { return agentSession.thinkingLevel ?? ""; } catch { return ""; }
			},
			setThinkingLevel(level) {
				// 会话级变更不持久化到全局默认（persist 省略 = false）
				agentSession.setThinkingLevel?.(level);
			},
			// P1-04：会话清单（浏览用）与命名
			async listSessions() {
				const sessions = await sdk.SessionManager.list(cwd, sessionDir);
				return sessions.map((info) => ({
					path: info.path,
					id: info.id,
					name: info.name,
					modified: info.modified instanceof Date ? info.modified.getTime() : new Date(info.modified).getTime(),
					messageCount: info.messageCount ?? 0,
				}));
			},
			sessionName() {
				try { return agentSession.sessionName; } catch { return undefined; }
			},
			setSessionName(name) {
				agentSession.setSessionName?.(name);
			},
		};
	}
}
