import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../electron/main/renderer-file-reader.ts", import.meta.url), "utf8");
const module = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, module, module.exports);
const { createRendererFileReader } = module.exports;

async function fixture(t) {
  assert.ok(process.env.PI_SCRATCH_DIR);
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "renderer-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("完整字节读取保留中文文件名、超过预览上限的二进制和会话作用域", async (t) => {
  const directory = await fixture(t);
  const path = join(directory, "原始内容.zip");
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  await writeFile(path, bytes);
  const calls = [];
  const read = createRendererFileReader({
    isRemote: async (sessionId) => { calls.push(sessionId); return false; },
    resolve: async (input) => { calls.push(input); return { match: { absolutePath: path } }; },
  });
  const input = { path: "原始内容.zip", sessionId: "session-worktree" };
  const result = await read(input);
  assert.equal(result.name, "原始内容.zip");
  assert.deepEqual(Buffer.from(result.body, "base64"), bytes);
  assert.deepEqual(calls, [input.sessionId, input]);
});

test("远程工作区不会误读同名本机文件，失效会话和解析失败继续回传", async () => {
  let resolved = 0;
  const read = createRendererFileReader({ isRemote: async () => true, resolve: async () => { resolved++; } });
  await assert.rejects(read({ path: "/same/path" }), { code: "UNSUPPORTED" });
  assert.equal(resolved, 0);
  const missing = createRendererFileReader({ isRemote: async () => false, resolve: async () => ({ match: null }) });
  await assert.rejects(missing({ path: "/missing" }), { code: "NOT_FOUND" });
  const failed = createRendererFileReader({ isRemote: async () => { throw new Error("session missing"); }, resolve: async () => {} });
  await assert.rejects(failed({ path: "/missing", sessionId: "old-session" }), /session missing/);
});

test("目录、被删除的文件和无效请求不产生成功文件响应", async (t) => {
  const directory = await fixture(t);
  const dir = join(directory, "folder");
  await mkdir(dir);
  const read = createRendererFileReader({ isRemote: async () => false, resolve: async (input) => ({ match: { absolutePath: input.path } }) });
  await assert.rejects(read({ path: dir }), { code: "INVALID_PARAMS" });
  await assert.rejects(read({ path: join(directory, "deleted.txt") }), { code: "ENOENT" });
  for (const input of [null, {}, { path: "" }, { path: "x", sessionId: {} }]) await assert.rejects(read(input), { code: "INVALID_PARAMS" });
});
