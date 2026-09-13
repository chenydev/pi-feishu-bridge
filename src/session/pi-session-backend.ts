/**
 * pi 会话后端：每个 chat 一个 createAgentSession（B3 根治：会话隔离）。
 * 设计依据：docs/DESIGN.md §3.4；API 契约见 DESIGN §7.2（只使用官方导出）。
 */
import { join } from "node:path";
import type { PiImageContent, SessionBackend } from "../types.js";

interface PiSdk {
	getAgentDir(): string;
	SessionManager: {
		open(file: string, opts?: unknown, cwd?: string): unknown;
	};
	createAgentSession(opts: {
		session?: unknown;
		sessionManager?: unknown;
		cwd: string;
		modelId?: string;
	}): Promise<{ session: PiAgentSession }>;
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
}

export interface PiSessionBackendDeps {
	/** 会话文件目录（默认 config.sessionDir 由桥层传入）。 */
	sessionDir: string;
	modelId?: string;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string, meta?: unknown) => void;
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

	async createSession(opts: { chatId: string; conversationKey: string; sessionFile?: string }): Promise<{
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
	}> {
		const sdk = await this.ensureSdk();
		const cwd = process.cwd();
		const sessionFile = opts.sessionFile ?? join(this.deps.sessionDir, `${opts.chatId}.jsonl`);

		let sessionManager: unknown;
		try {
			sessionManager = sdk.SessionManager.open(sessionFile, undefined, cwd);
		} catch (err) {
			this.deps.log?.("error", "feishu.session.open_failed", { sessionFile, error: err instanceof Error ? err.message : String(err) });
			throw err;
		}

		const { session: createdSession } = await sdk.createAgentSession({
			session: sessionManager,
			sessionManager,
			cwd,
			modelId: this.deps.modelId,
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
		};
	}
}
