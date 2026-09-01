/**
 * pi 会话后端：每个 chat 一个 createAgentSession（B3 根治：会话隔离）。
 * 设计依据：docs/DESIGN.md §3.4；API 契约见 DESIGN §7.2（只使用官方导出）。
 */
import { join } from "node:path";
import type { SessionBackend } from "../types.js";

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
	prompt(text: string, opts?: { images?: unknown[] }): Promise<unknown>;
	subscribe(fn: (event: unknown) => void): () => void;
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
		prompt(text: string, images?: unknown[]): Promise<unknown>;
		subscribe(fn: (event: unknown) => void): () => void;
		modelId: string;
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
			subscribe(fn) {
				return agentSession.subscribe(fn);
			},
			modelId: agentSession.model?.id ?? "default",
		};
	}
}
