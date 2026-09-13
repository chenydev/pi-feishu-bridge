import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveChannel } from "../src/outbound/live-channel.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("LiveChannel：合并 delta、补齐代码围栏并交接 final 编辑目标", async () => {
	const edits: string[] = [];
	const live = new LiveChannel({ edit: async (_id, text) => { edits.push(text); return true; }, throttleMs: 0 });
	live.open("run", "om_live");
	live.append("run", "```ts\n");
	live.append("run", "const x = 1");
	await tick();
	assert.equal(edits.length, 1);
	assert.match(edits[0], /\n```$/);
	assert.equal(await live.claimFinalTarget("run"), "om_live");
	live.append("run", "late");
	await tick();
	assert.equal(edits.length, 1);
});

test("LiveChannel：连续编辑失败后熔断，final 改走新消息", async () => {
	const live = new LiveChannel({ edit: async () => false, throttleMs: 0, maxFailures: 2 });
	live.open("run", "om_live");
	live.append("run", "a");
	await tick();
	live.append("run", "b");
	await tick();
	assert.equal(await live.claimFinalTarget("run"), undefined);
});

test("LiveChannel：final 交接等待正在进行的旧 patch，避免覆盖 durable final", async () => {
	let releaseEdit: (() => void) | undefined;
	const order: string[] = [];
	const live = new LiveChannel({
		throttleMs: 0,
		edit: async () => {
			order.push("live-start");
			await new Promise<void>((resolve) => { releaseEdit = resolve; });
			order.push("live-end");
			return true;
		},
	});
	live.open("run", "om_live");
	live.append("run", "partial");
	await tick();
	const claimed = live.claimFinalTarget("run").then((messageId) => { order.push("claimed"); return messageId; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(order, ["live-start"]);
	releaseEdit?.();
	assert.equal(await claimed, "om_live");
	assert.deepEqual(order, ["live-start", "live-end", "claimed"]);
});
