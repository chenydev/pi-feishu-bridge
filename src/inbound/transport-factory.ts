/**
 * 真实 lark SDK 工厂：动态导入 @larksuiteoapi/node-sdk（lazy，避免阻塞扩展加载）。
 */
import type { LarkSdkLike } from "./transport.js";
import type { BridgeConfig } from "../types.js";
import { FeishuTransport, type TransportDeps } from "./transport.js";

export async function createFeishuTransport(
	config: BridgeConfig,
	deps: Omit<TransportDeps, "sdk" | "config">,
): Promise<FeishuTransport> {
	const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSdkLike;
	return new FeishuTransport({ sdk: lark, config, ...deps });
}
