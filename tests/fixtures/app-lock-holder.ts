import { writeFileSync } from "node:fs";
import { AppLock } from "../../src/runtime/app-lock.js";

const [lockFile, readyFile] = process.argv.slice(2);
if (!lockFile || !readyFile) throw new Error("usage: app-lock-holder <lock> <ready>");
AppLock.acquire(lockFile, "shared-app");
writeFileSync(readyFile, String(process.pid));
setInterval(() => {}, 1_000);
