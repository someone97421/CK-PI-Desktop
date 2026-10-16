import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../electron/main/entry.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false,
  plugins: [{ name: "启动边界", setup(builder) {
    builder.onResolve({ filter: /^electron$|^\.\/installation$|^\.\/storage\/bootstrap$|^\.\/index$/ },
      ({ path }) => ({ path, namespace: "entry-test" }));
    builder.onLoad({ filter: /.*/, namespace: "entry-test" }, ({ path }) => {
      if (path === "electron") return { contents: `
        export const { app, dialog, BrowserWindow, protocol } = globalThis.harness;
        export const net = {}; export const nativeImage = {};
      ` };
      if (path === "./installation") return { contents: `
        export const { hasSingleInstanceLock, isBackupLockProcess } = globalThis.harness;
        export const defaultDataDir = "/test-data", storageOverridden = true;
      ` };
      if (path === "./storage/bootstrap") return { contents: `
        export function prepareStorage() {
          globalThis.harness.events.push("storage");
          return globalThis.harness.storage;
        }
      ` };
      return { contents: `
        globalThis.harness.events.push("business");
        if (globalThis.harness.bootError) throw globalThis.harness.bootError;
      ` };
    });
  } }],
});

function fixture(overrides = {}) {
  const harness = {
    events: [], registrations: [], errors: [], exits: [], logs: [], ready: false,
    hasSingleInstanceLock: true, isBackupLockProcess: false,
    storage: Promise.resolve(), ...overrides,
  };
  harness.app = { on() {}, exit(code) { harness.exits.push(code); } };
  harness.BrowserWindow = { getAllWindows: () => [] };
  harness.dialog = { showErrorBox(...args) { harness.errors.push(args); } };
  harness.protocol = { registerSchemesAsPrivileged(schemes) {
    assert.equal(harness.ready, false, "协议必须在 ready 之前注册");
    harness.events.push("schemes");
    harness.registrations.push(schemes);
  } };
  runInNewContext(outputFiles[0].text, {
    harness, require, process, Buffer, URL, Response, Headers, TextEncoder, TextDecoder, Error,
    console: { error: (...args) => harness.logs.push(args) },
  });
  return harness;
}

test("冷维护延迟到 ready 之后，协议仍同步注册一次且业务入口等待存储完成", async () => {
  let finish;
  const harness = fixture({ storage: new Promise(resolve => { finish = resolve; }) });
  assert.deepEqual(harness.events, ["schemes", "storage"]);
  assert.equal(harness.registrations.length, 1);
  const schemes = harness.registrations[0];
  assert.equal(schemes.length, 3);
  assert.equal(new Set(schemes.map(item => item.scheme)).size, 3);
  for (const { privileges } of schemes) {
    assert.equal(privileges.secure, true);
    assert.equal(privileges.supportFetchAPI, true);
    assert.equal(privileges.corsEnabled, true);
  }
  harness.ready = true;
  finish();
  await tick();
  assert.deepEqual(harness.events, ["schemes", "storage", "business"]);
  assert.deepEqual(harness.exits, []);
});

for (const stage of ["storage", "business"]) {
  test(`${stage} 启动失败时显示原因、记录错误并退出`, async () => {
    const error = new ReferenceError("startup dependency is not defined");
    const harness = fixture(stage === "storage"
      ? { storage: Promise.reject(error) } : { bootError: error });
    await tick();
    assert.equal(harness.errors.length, 1);
    assert.equal(harness.errors[0][0], "应用启动失败");
    assert.match(harness.errors[0][1], /startup dependency is not defined/);
    assert.equal(harness.logs.length, 1);
    assert.deepEqual(harness.exits, [1]);
    assert.equal(harness.events.includes("business"), stage === "business");
  });
}

for (const overrides of [{ hasSingleInstanceLock: false }, { isBackupLockProcess: true }]) {
  test(`无业务启动资格时不注册协议或加载业务：${JSON.stringify(overrides)}`, async () => {
    const harness = fixture(overrides);
    await tick();
    assert.deepEqual(harness.events, []);
    assert.deepEqual(harness.errors, []);
  });
}
