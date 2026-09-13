import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

interface LockOwner {
	appId: string;
	pid: number;
	token: string;
	createdAt: number;
	processStartToken?: string;
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function processStartToken(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fieldsAfterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
		return fieldsAfterName[19];
	} catch {
		return undefined;
	}
}

function ownerAlive(owner: LockOwner): boolean {
	if (!pidAlive(owner.pid)) return false;
	if (!owner.processStartToken) return true;
	return processStartToken(owner.pid) === owner.processStartToken;
}

export class AppLock {
	private released = false;

	private constructor(private file: string, private owner: LockOwner) {}

	static acquire(file: string, appId: string, now: () => number = Date.now): AppLock {
		mkdirSync(dirname(file), { recursive: true });
		const owner: LockOwner = { appId, pid: process.pid, token: randomUUID(), createdAt: now(), processStartToken: processStartToken(process.pid) };
		for (let attempt = 0; attempt < 4; attempt += 1) {
			try {
				const fd = openSync(file, "wx", 0o600);
				try { writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8"); } finally { closeSync(fd); }
				return new AppLock(file, owner);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let current: LockOwner | undefined;
				let observed = "";
				try { observed = readFileSync(file, "utf8"); current = JSON.parse(observed) as LockOwner; } catch { /* corrupt lock is stale */ }
				if (current && current.appId === appId && ownerAlive(current)) {
					throw new Error(`bridge already running for appId ${appId} (pid ${current.pid})`);
				}
				try {
					if (readFileSync(file, "utf8") !== observed) continue;
				} catch {
					continue;
				}
				try { unlinkSync(file); } catch (unlinkError) {
					if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
				}
			}
		}
		throw new Error(`failed to acquire bridge lock for appId ${appId}`);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		if (!existsSync(this.file)) return;
		try {
			const current = JSON.parse(readFileSync(this.file, "utf8")) as LockOwner;
			if (current.token !== this.owner.token) return;
			unlinkSync(this.file);
		} catch { /* never remove a lock whose ownership cannot be verified */ }
	}
}
