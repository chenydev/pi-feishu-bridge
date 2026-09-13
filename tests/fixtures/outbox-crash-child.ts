import { appendFileSync } from "node:fs";
import { Outbox } from "../../src/outbound/outbox.js";
import type { PreparedSend } from "../../src/outbound/sender.js";

const [file, marker, mode] = process.argv.slice(2);
if (!file || !marker || !mode) throw new Error("usage: outbox-crash-child <file> <marker> <mode>");

const prepare = (chatId: string, content: string): PreparedSend[] => [{
	chatId, msgType: "text", payload: JSON.stringify({ text: content }), plainTextPayload: JSON.stringify({ text: content }),
	opts: {}, uuid: "stable-crash-uuid", contentFallbackUuid: "content-uuid", routeFallbackUuid: "route-uuid",
}];
const outbox = new Outbox({
	file,
	prepare,
	send: async (request) => {
		appendFileSync(marker, `${request.uuid}\n`);
		process.kill(process.pid, "SIGKILL");
		return { success: true, messageId: "unreachable" };
	},
});
outbox.enqueue("oc", "answer", {}, { dedupeKey: "crash-final", laneKey: "lane", kind: "final" });
if (mode === "before-send") process.kill(process.pid, "SIGKILL");
await outbox.drainDue();
