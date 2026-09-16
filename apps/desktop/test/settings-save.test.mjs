import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/settings-save.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(normalize = () => {}) {
  const initial = { theme: "system", fontScale: 1.25, fontFamily: "Legacy", appearance: { dark: { background: "#121212" } }, future: true };
  let state = { settings: initial };
  const writes = [];
  const starts = new Map();
  const store = { getState: () => state, setState: (patch) => { state = { ...state, ...patch }; } };
  const api = { setSettings: (settings) => new Promise((resolve, reject) => {
    normalize(settings);
    const index = writes.length;
    const write = { settings, resolve, reject };
    writes.push(write);
    starts.get(index)?.(write);
  }) };
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    if (name === "./api") return { api };
    if (name === "../stores/app-store") return { useAppStore: store };
    throw new Error(`Unexpected import: ${name}`);
  }, exports);
  return {
    ...exports, initial, store, writes,
    started: (index) => writes[index] ? Promise.resolve(writes[index]) : new Promise((resolve) => starts.set(index, resolve)),
  };
}

test("only edited fields roll back, preserving external theme updates before and during a save", async () => {
  const f = fixture();
  for (const during of [false, true]) {
    const theme = during ? "plugin:during" : "plugin:before";
    const changeTheme = () => f.store.setState({ settings: { ...f.store.getState().settings, theme } });
    if (!during) changeTheme();
    const index = f.writes.length;
    const promise = f.saveSettingsPatch({ appearance: { light: { accent: "#ABCDEF" } } });
    const rejected = assert.rejects(promise, /offline/);
    const write = await f.started(index);
    if (during) changeTheme();
    write.reject(new Error("offline"));
    await rejected;
    assert.deepEqual(f.store.getState().settings, { ...f.initial, theme });
    assert.equal(f.getSettingsSaveError(), true);
  }
});

for (const firstSucceeds of [false, true]) {
  test(`navigation keeps one baseline and queue when first write ${firstSucceeds ? "succeeds" : "fails"}`, async () => {
    const f = fixture();
    const a = { ...f.initial.appearance, light: { accent: "#111111" } };
    const b = { ...a, light: { accent: "#222222" } };
    let oldNotifications = 0;
    const unmount = f.subscribeSettingsSaveError(() => { oldNotifications += 1; });
    const first = f.saveSettingsPatch({ appearance: a });
    const firstResult = firstSucceeds ? first : assert.rejects(first, /first failed/);
    const firstWrite = await f.started(0);
    unmount();
    let newNotifications = 0;
    const unsubscribe = f.subscribeSettingsSaveError(() => { newNotifications += 1; });
    const second = f.saveSettingsPatch({ appearance: b });
    const secondResult = assert.rejects(second, /second failed/);
    assert.equal(f.store.getState().settings.appearance, b);
    assert.equal(f.writes.length, 1);
    if (firstSucceeds) firstWrite.resolve({ ok: true });
    else firstWrite.reject(new Error("first failed"));
    await firstResult;
    const secondWrite = await f.started(1);
    assert.equal(f.store.getState().settings.appearance, b);
    secondWrite.reject(new Error("second failed"));
    await secondResult;
    assert.equal(f.store.getState().settings.appearance, firstSucceeds ? a : f.initial.appearance);
    assert.equal(oldNotifications, 0);
    assert.equal(newNotifications, 1);
    assert.equal(f.getSettingsSaveError(), true);
    unsubscribe();
  });
}

test("pending snapshots coalesce and a failed chain never becomes a later baseline", async () => {
  const f = fixture();
  const first = f.saveSettingsPatch({ appearance: { ...f.initial.appearance, light: { accent: "#111111" } } });
  const rejected = assert.rejects(first, /first failed/);
  const firstWrite = await f.started(0);
  const second = f.saveSettingsPatch({ fontScale: 1.4 });
  const third = f.saveSettingsPatch({ appearance: { ...f.initial.appearance, light: { accent: "#333333" } } });
  const lastRejected = assert.rejects(third, /last failed/);
  firstWrite.reject(new Error("first failed"));
  await rejected;
  await second;
  const lastWrite = await f.started(1);
  assert.equal(lastWrite.settings.fontScale, 1.4);
  assert.equal(lastWrite.settings.appearance.light.accent, "#333333");
  lastWrite.reject(new Error("last failed"));
  await lastRejected;
  assert.deepEqual(f.store.getState().settings, f.initial);
  const retry = f.saveSettingsPatch({ fontScale: 1.3 });
  const retryWrite = await f.started(2);
  assert.equal(retryWrite.settings.appearance, f.initial.appearance);
  retryWrite.resolve({ ok: true });
  await retry;
  assert.equal(f.getSettingsSaveError(), false);
});

test("external changes supersede local values without being reverted on failure", async () => {
  const f = fixture();
  const first = f.saveSettingsPatch({ theme: "light" });
  const rejected = assert.rejects(first, /offline/);
  const write = await f.started(0);
  f.store.setState({ settings: { ...f.store.getState().settings, theme: "plugin:external" } });
  write.reject(new Error("offline"));
  await rejected;
  assert.equal(f.store.getState().settings.theme, "plugin:external");
});

test("API normalization cannot mutate optimistic settings or defeat rollback", async () => {
  const f = fixture((settings) => {
    settings.networkProxy = { ...settings.networkProxy };
  });
  const proxy = { mode: "system" };
  const save = f.saveSettingsPatch({ networkProxy: proxy });
  const rejected = assert.rejects(save, /offline/);
  const write = await f.started(0);
  assert.equal(f.store.getState().settings.networkProxy, proxy);
  assert.notEqual(write.settings.networkProxy, proxy);
  write.reject(new Error("offline"));
  await rejected;
  assert.equal(f.store.getState().settings.networkProxy, undefined);
});
