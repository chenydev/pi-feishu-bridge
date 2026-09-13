import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BridgeStatus } from "../types.js";

export function writeStatus(file: string, status: BridgeStatus): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, file);
}
