import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendPromptFallbackPaths, preparePromptAttachments } from "../electron/main/prompt-attachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9z8AAAAASUVORK5CYII=",
  "base64",
);
const sessionId = "inline-placement";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-attachments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const pasted = join(data, "scratch", sessionId, "pasted");
  await mkdir(pasted, { recursive: true });
  const path = join(pasted, "pasted-a.png");
  await writeFile(path, png);
  return { data, path };
}

test("正文中的图片保存位置与可读取的媒体引用", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const content = `compare @${path} with the rest`;
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    true,
    {},
    content,
  );
  assert.equal(prepared.message.kind, "image");
  assert.equal(prepared.message.inlinePath, `@${path}`);
  assert.equal(prepared.inlineData, undefined);
  assert.deepEqual(prepared.mediaRef, {
    ref: prepared.message.ref,
    mimeType: "image/png",
    size: png.length,
  });
  assert.match(prepared.mediaRef.ref, /^attachments\/[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(join(data, prepared.mediaRef.ref)), png);
  assert.equal(appendPromptFallbackPaths(content, [prepared]), content);
});

test("未在正文中引用的图片不记录行内位置并保留文件回退", async (t) => {
  const { data, path } = await fixture(t);
  const attachment = { path, name: "pasted-a.png", kind: "image", mimeType: "image/png" };
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    {},
    "look at this",
  );
  assert.equal(prepared.message.inlinePath, undefined);
  assert.equal(prepared.inlineData, undefined);
  assert.equal(prepared.mediaRef, undefined);
  const text = appendPromptFallbackPaths("look at this", [prepared]);
  assert.ok(text.startsWith("look at this"));
  assert.ok(text.includes(path));
});

test("正文引用历史附件时仍追加可用的回放路径", async (t) => {
  const { data } = await fixture(t);
  const ref = `attachments/${"a".repeat(64)}`;
  await mkdir(join(data, "attachments"), { recursive: true });
  await writeFile(join(data, ref), png);
  const attachment = { path: ref, name: "a.png", kind: "image", mimeType: "image/png" };
  const content = `look @${ref}`;
  const [prepared] = await preparePromptAttachments(
    data,
    sessionId,
    undefined,
    [attachment],
    false,
    {},
    content,
  );
  assert.equal(prepared.message.inlinePath, `@${ref}`);
  assert.equal(prepared.mediaRef, undefined);
  const text = appendPromptFallbackPaths(content, [prepared]);
  assert.ok(text.startsWith(content));
  assert.notEqual(prepared.fallbackPath, ref);
  assert.ok(text.includes(prepared.fallbackPath));
  assert.deepEqual(await readFile(prepared.fallbackPath), png);
});

test("图片媒体引用与旧内联数据均不追加文件回退", async (t) => {
  const { data, path } = await fixture(t);
  const [prepared] = await preparePromptAttachments(
    data, sessionId, undefined,
    [{ path, name: "pasted-a.png", kind: "image", mimeType: "image/png" }],
    true, {}, "look at this",
  );
  assert.equal(prepared.message.inlinePath, undefined);
  assert.ok(prepared.mediaRef);
  assert.equal(appendPromptFallbackPaths("look at this", [prepared]), "look at this");
  const legacy = { ...prepared, mediaRef: undefined, inlineData: png.toString("base64") };
  assert.equal(appendPromptFallbackPaths("look at this", [legacy]), "look at this");
});

test("音频媒体引用保留正文路径但不记录图片行内位置", async (t) => {
  const { data, path } = await fixture(t);
  const audioPath = join(path, "..", "recording.wav");
  await writeFile(audioPath, Buffer.from("audio-fixture"));
  const content = `listen @${audioPath} please`;
  const [prepared] = await preparePromptAttachments(
    data, sessionId, undefined,
    [{ path: audioPath, name: "recording.wav", kind: "file", mimeType: "audio/wav" }],
    false, { supportsAudio: true }, content,
  );
  assert.equal(prepared.message.kind, "file");
  assert.equal(prepared.message.inlinePath, undefined);
  assert.equal(prepared.mediaRef?.mimeType, "audio/wav");
  assert.equal(appendPromptFallbackPaths(content, [prepared]), content);
});
