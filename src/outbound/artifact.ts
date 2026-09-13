import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type OutboundMediaType = "image" | "file" | "video" | "audio";

export interface ValidatedArtifact {
	localPath: string;
	fileName: string;
	mediaType: OutboundMediaType;
	byteLength: number;
	sha256: string;
	deleteAfterSend?: boolean;
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_SPOOL_MAX_BYTES = 256 * 1024 * 1024;

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 将产物复制到持久 outbox spool，避免原文件在重试前被删除或改写。 */
export function stageArtifact(artifact: ValidatedArtifact, spoolDir: string, maxSpoolBytes = DEFAULT_SPOOL_MAX_BYTES): ValidatedArtifact {
	mkdirSync(spoolDir, { recursive: true });
	if (lstatSync(spoolDir).isSymbolicLink() || !lstatSync(spoolDir).isDirectory()) throw new Error("outbox spool 不是可信目录");
	const buffer = readVerifiedArtifact(artifact);
	const usedBytes = readdirSync(spoolDir).reduce((total, name) => {
		try {
			const stat = lstatSync(join(spoolDir, name));
			return total + (stat.isFile() ? stat.size : 0);
		} catch { return total; }
	}, 0);
	if (usedBytes + buffer.length > maxSpoolBytes) throw new Error("outbox media spool capacity exceeded");
	const stagedPath = join(spoolDir, `${artifact.sha256.slice(0, 20)}-${randomUUID()}-${artifact.fileName}`);
	let fd: number | undefined;
	try {
		fd = openSync(stagedPath, "wx", 0o600);
		writeFileSync(fd, buffer);
	} catch (error) {
		try { unlinkSync(stagedPath); } catch { /* best effort */ }
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return { ...artifact, localPath: realpathSync(stagedPath), deleteAfterSend: true };
}

function sniffMedia(buffer: Buffer, fileName: string): OutboundMediaType {
	if (
		(buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
		(buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
		(buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) ||
		(buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
	) return "image";
	if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video";
	if (/\.(?:opus|ogg)$/i.test(fileName) && buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") return "audio";
	return "file";
}

/**
 * 将模型给出的路径约束在当前工作区内，并固化大小与摘要供 outbox 重试时复核。
 * realpath 同时阻止 `..` 与符号链接逃逸。
 */
export function validateLocalArtifact(path: string, allowedRoot: string): ValidatedArtifact {
	const root = realpathSync(resolve(allowedRoot));
	const localPath = realpathSync(resolve(allowedRoot, path));
	if (!isInside(root, localPath)) throw new Error("文件不在当前工作区内");
	const stat = statSync(localPath);
	if (!stat.isFile()) throw new Error("路径不是普通文件");
	const buffer = readFileSync(localPath);
	const mediaType = sniffMedia(buffer, localPath);
	const maxBytes = mediaType === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
	if (buffer.length > maxBytes) throw new Error(`${mediaType === "image" ? "图片" : "文件"}超过 ${maxBytes / 1024 / 1024}MB 上限`);
	return {
		localPath,
		fileName: basename(localPath).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 240) || "artifact",
		mediaType,
		byteLength: buffer.length,
		sha256: createHash("sha256").update(buffer).digest("hex"),
	};
}

export function readVerifiedArtifact(artifact: ValidatedArtifact): Buffer {
	const buffer = readFileSync(artifact.localPath);
	if (buffer.length !== artifact.byteLength) throw new Error("文件在排队后已发生变化（大小不一致）");
	const sha256 = createHash("sha256").update(buffer).digest("hex");
	if (sha256 !== artifact.sha256) throw new Error("文件在排队后已发生变化（摘要不一致）");
	return buffer;
}
