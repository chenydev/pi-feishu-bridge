import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ResourceResolver } from "../src/inbound/resource-resolver.js";
import type { ResourceRef } from "../src/types.js";

function ref(kind: ResourceRef["kind"], key: string, name?: string): ResourceRef {
	return { kind, key, name, messageId: "om_resource" };
}

test("ResourceResolver：图片转 Pi 裸 base64，文本有界注入，二进制临时文件可清理", async () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-feishu-resources-"));
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
	try {
		const resolver = new ResourceResolver({
			baseDir,
			maxTextChars: 5,
			download: async (resource) => {
				if (resource.kind === "image") return { buffer: png, mimeType: "application/octet-stream" };
				if (resource.name === "note.txt") return { buffer: Buffer.from("123456789"), mimeType: "text/plain" };
				return { buffer: Buffer.from([1, 2, 3]), mimeType: "application/pdf" };
			},
		});
		const resolved = await resolver.resolve([ref("image", "img"), ref("file", "text", "note.txt"), ref("file", "pdf", "../../report.pdf")]);
		assert.deepEqual(resolved.images, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
		assert.match(resolved.promptSuffix, /12345/);
		assert.match(resolved.promptSuffix, /内容已截断/);
		const path = resolved.promptSuffix.match(/本地路径：([^\n]+)/)?.[1];
		assert.ok(path);
		assert.equal(existsSync(path), true);
		assert.equal(path.includes(".."), false);
		resolved.cleanup();
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("ResourceResolver：数量、单条和总量超限给出明确提示", async () => {
	const resolver = new ResourceResolver({
		baseDir: join(tmpdir(), "not-created"),
		maxCount: 1,
		maxItemBytes: 2,
		maxTotalBytes: 2,
		download: async () => { throw new Error("resource too large: 3 > 2"); },
	});
	const resolved = await resolver.resolve([ref("file", "one"), ref("file", "two")]);
	assert.match(resolved.promptSuffix, /仅处理前 1 个附件/);
	assert.match(resolved.promptSuffix, /resource too large/);
});

test("ResourceResolver：图片声明 MIME 与魔数不一致时拒绝", async () => {
	const resolver = new ResourceResolver({
		baseDir: join(tmpdir(), "not-created-mime"),
		download: async () => ({ buffer: Buffer.from("not-an-image"), mimeType: "image/png" }),
	});
	const resolved = await resolver.resolve([ref("image", "fake")]);
	assert.equal(resolved.images.length, 0);
	assert.match(resolved.promptSuffix, /内容与声明类型不一致/);
});

test("ResourceResolver：下载前拒绝声明超限，伪装 txt 的二进制不注入 prompt", async () => {
	let downloads = 0;
	const baseDir = mkdtempSync(join(tmpdir(), "pi-feishu-resource-meta-"));
	try {
		const resolver = new ResourceResolver({
			baseDir, maxItemBytes: 4,
			download: async (resource) => {
				downloads += 1;
				if (resource.key === "binary") return { buffer: Buffer.from([0xff, 0xfe, 0, 1]), mimeType: "text/plain" };
				return { buffer: Buffer.from("ok"), mimeType: "text/plain" };
			},
		});
		const resolved = await resolver.resolve([
			{ ...ref("file", "large", "large.txt"), size: 5 },
			ref("file", "binary", "fake.txt"),
		]);
		assert.equal(downloads, 1);
		assert.match(resolved.promptSuffix, /声明大小超过限制/);
		assert.doesNotMatch(resolved.promptSuffix, /附件 fake\.txt 内容/);
		assert.match(resolved.promptSuffix, /本地路径/);
		resolved.cleanup();
	} finally { rmSync(baseDir, { recursive: true, force: true }); }
});
