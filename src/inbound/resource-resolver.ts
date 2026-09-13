import { basename, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { PiImageContent, ResourceRef } from "../types.js";

export interface ResolvedTurnResources {
	promptSuffix: string;
	images: PiImageContent[];
	cleanup(): void;
}

export interface ResourceResolverDeps {
	baseDir: string;
	download(ref: ResourceRef, maxBytes: number): Promise<{ buffer: Buffer; mimeType?: string }>;
	maxCount?: number;
	maxItemBytes?: number;
	maxTotalBytes?: number;
	maxTextChars?: number;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXT = /\.(?:txt|md|markdown|json|jsonl|csv|tsv|xml|ya?ml|log|js|ts|py|java|go|rs|sh|css|html)$/i;

function sniffImageMime(buffer: Buffer): string | undefined {
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
	if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

function safeName(ref: ResourceRef, index: number): string {
	const raw = basename(ref.name || `${ref.kind}-${index}`).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);
	return raw || `${ref.kind}-${index}`;
}

export class ResourceResolver {
	constructor(private deps: ResourceResolverDeps) {}

	async resolve(resources: ResourceRef[]): Promise<ResolvedTurnResources> {
		const maxCount = this.deps.maxCount ?? 8;
		const maxItemBytes = this.deps.maxItemBytes ?? 20 * 1024 * 1024;
		const maxTotalBytes = this.deps.maxTotalBytes ?? 50 * 1024 * 1024;
		const maxTextChars = this.deps.maxTextChars ?? 20_000;
		const images: PiImageContent[] = [];
		const notes: string[] = [];
		let tempDir: string | undefined;
		let totalBytes = 0;
		const selected = resources.slice(0, maxCount);
		if (resources.length > maxCount) notes.push(`[附件提示] 仅处理前 ${maxCount} 个附件，其余 ${resources.length - maxCount} 个已跳过。`);

		for (let index = 0; index < selected.length; index += 1) {
			const ref = selected[index];
			try {
				const remaining = Math.min(maxItemBytes, maxTotalBytes - totalBytes);
				if (remaining <= 0) throw new Error("附件总大小超过限制");
				if (ref.size !== undefined && ref.size > remaining) throw new Error(`附件声明大小超过限制 ${ref.size} > ${remaining}`);
				const downloaded = await this.deps.download(ref, remaining);
				if (ref.mimeType && downloaded.mimeType && ref.mimeType !== downloaded.mimeType) {
					throw new Error(`附件 MIME 与声明不一致 ${ref.mimeType} != ${downloaded.mimeType}`);
				}
				totalBytes += downloaded.buffer.length;
				if (ref.kind === "image") {
					const sniffed = sniffImageMime(downloaded.buffer);
					if (downloaded.mimeType && IMAGE_MIMES.has(downloaded.mimeType) && downloaded.mimeType !== sniffed) {
						throw new Error(`图片内容与声明类型不一致 ${downloaded.mimeType}`);
					}
					const mimeType = sniffed;
					if (!mimeType || !IMAGE_MIMES.has(mimeType)) throw new Error(`不支持的图片格式 ${downloaded.mimeType ?? "unknown"}`);
					images.push({ type: "image", data: downloaded.buffer.toString("base64"), mimeType });
					continue;
				}
				const name = safeName(ref, index);
				const isText = downloaded.mimeType?.startsWith("text/") || downloaded.mimeType === "application/json" || TEXT_EXT.test(name);
				if (isText) {
					try {
						const decoded = new TextDecoder("utf-8", { fatal: true }).decode(downloaded.buffer);
						if (decoded.includes("\u0000")) throw new Error("binary NUL");
						const text = decoded.slice(0, maxTextChars);
						notes.push(`[附件 ${name} 内容]\n${text}${decoded.length > maxTextChars ? "\n[内容已截断]" : ""}`);
						continue;
					} catch { /* 扩展名或 Content-Type 伪装的二进制按普通附件处理 */ }
				}
				if (!tempDir) {
					mkdirSync(this.deps.baseDir, { recursive: true });
					tempDir = mkdtempSync(join(this.deps.baseDir, "turn-"));
				}
				const path = join(tempDir, name);
				writeFileSync(path, downloaded.buffer, { mode: 0o600 });
				notes.push(`[附件 ${name}] 本地路径：${path}`);
			} catch (error) {
				notes.push(`[附件 ${ref.name ?? ref.kind} 无法读取] ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return {
			promptSuffix: notes.length ? `\n\n${notes.join("\n\n")}` : "",
			images,
			cleanup: () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); },
		};
	}
}
