import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readVerifiedArtifact, stageArtifact, validateLocalArtifact } from "../src/outbound/artifact.js";

test("出站产物：魔数识别图片、固化摘要并复制到 0600 spool", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-artifact-"));
	try {
		const path = join(dir, "answer.bin");
		writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("payload")]));
		const artifact = validateLocalArtifact(path, dir);
		assert.equal(artifact.mediaType, "image");
		const staged = stageArtifact(artifact, join(dir, "spool"));
		assert.equal(staged.deleteAfterSend, true);
		assert.deepEqual(readVerifiedArtifact(staged), readFileSync(path));
		writeFileSync(staged.localPath, "changed");
		assert.throws(() => readVerifiedArtifact(staged), /发生变化/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("出站产物：realpath 阻止符号链接逃逸", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-artifact-root-"));
	const outside = mkdtempSync(join(tmpdir(), "feishu-artifact-outside-"));
	try {
		mkdirSync(join(dir, "inside"));
		const secret = join(outside, "secret.txt");
		writeFileSync(secret, "secret");
		symlinkSync(secret, join(dir, "inside", "link.txt"));
		assert.throws(() => validateLocalArtifact("inside/link.txt", dir), /不在当前工作区/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("出站产物：MP4 与 Opus 使用飞书原生媒体类型", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-artifact-media-"));
	try {
		const video = join(dir, "clip.mp4");
		writeFileSync(video, Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom")]))
		const audio = join(dir, "voice.opus");
		writeFileSync(audio, Buffer.from("OggSvoice"));
		assert.equal(validateLocalArtifact(video, dir).mediaType, "video");
		assert.equal(validateLocalArtifact(audio, dir).mediaType, "audio");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("出站产物：stage 使用已验证内容并拒绝 spool 符号链接", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-artifact-stage-"));
	const outside = mkdtempSync(join(tmpdir(), "feishu-artifact-spool-outside-"));
	try {
		const source = join(dir, "result.txt");
		writeFileSync(source, "original");
		const artifact = validateLocalArtifact(source, dir);
		writeFileSync(source, "replaced");
		assert.throws(() => stageArtifact(artifact, join(dir, "spool")), /发生变化/);
		const linkedSpool = join(dir, "linked-spool");
		symlinkSync(outside, linkedSpool);
		const fresh = validateLocalArtifact(source, dir);
		assert.throws(() => stageArtifact(fresh, linkedSpool), /可信目录/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("出站产物：media spool 总容量超限时明确失败", () => {
	const dir = mkdtempSync(join(tmpdir(), "feishu-artifact-capacity-"));
	try {
		const source = join(dir, "result.txt");
		writeFileSync(source, "12345");
		const artifact = validateLocalArtifact(source, dir);
		assert.throws(() => stageArtifact(artifact, join(dir, "spool"), 4), /spool capacity exceeded/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
