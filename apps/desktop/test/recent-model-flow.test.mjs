import i18n from "i18next";
import { en } from "@pi-desktop/i18n";
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { useAppStore, materializeDraftSession } = await import("../src/stores/app-store.ts");
const { api } = await import("../src/lib/api.ts");
const { loadRecentModels } = await import("../src/lib/recent-models.ts");

test("only accepted message submission updates recent models while new chats inherit the default", async t => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  const previousStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  t.after(() => { globalThis.localStorage = previousStorage; });
  const provider = { id: "p", enabled: true, authKind: "none", models: [{ id: "a" }, { id: "b" }] };
  useAppStore.setState({ providers: [provider], activeSessionId: null, sessions: [], recentModels: [], draftConfiguration: null,
    settings: { defaultProviderId: "p", defaultModelId: "a", defaultMode: "agent" }, workspace: null });
  const configure = modelId => useAppStore.getState().configureActiveSession({ mode: "agent", providerId: "p", modelId, thinkingLevel: "off" });
  let nextId = 0;
  t.mock.method(api, "createSession", async config => ({ session: { ...config, id: `s${++nextId}`, title: "Existing conversation", messages: [] } }));
  t.mock.method(api, "configureSession", async (id, config) => ({ session: {
    ...useAppStore.getState().sessions.find(session => session.id === id), ...config, id,
  } }));
  t.mock.method(api, "prompt", async () => ({}));
  await configure("b");
  assert.deepEqual(loadRecentModels(), [], "clicking a model is not usage");
  await materializeDraftSession();
  assert.equal(await useAppStore.getState().sendPrompt("use b"), true);
  assert.deepEqual(loadRecentModels(), [{ providerId: "p", modelId: "b" }]);
  useAppStore.setState({ runningSessions: {}, isRunning: false });
  await configure("a");
  assert.equal(loadRecentModels()[0].modelId, "b", "configuration alone does not reorder history");
  t.mock.method(api, "prompt", async () => { throw new Error("submission rejected"); });
  assert.equal(await useAppStore.getState().sendPrompt("rejected"), false);
  assert.equal(loadRecentModels()[0].modelId, "b");
  useAppStore.setState({ activeSessionId: null, draftConfiguration: null, recentModels: loadRecentModels() });
  await materializeDraftSession();
  assert.equal(useAppStore.getState().sessions.find(s => s.id === "s2").modelId, "a", "new chat inherits the configured default after reload");
  t.mock.method(api, "getSession", async id => ({ session: {
    ...useAppStore.getState().sessions.find(session => session.id === id), messages: [],
  } }));
  useAppStore.setState({ runningSessions: {}, isRunning: false });
  await useAppStore.getState().selectSession("s1");
  assert.equal(useAppStore.getState().activeSessionId, "s1");
  assert.equal(useAppStore.getState().sessions.find(s => s.id === "s1").modelId, "a", "opening old chat preserves its model");
  assert.equal(loadRecentModels()[0].modelId, "b", "opening old chat does not count as usage");
  t.mock.method(api, "prompt", async () => ({}));
  assert.equal(await useAppStore.getState().sendPrompt("use a in the old chat"), true);
  assert.deepEqual(loadRecentModels().map(model => model.modelId), ["a", "b"]);
  useAppStore.setState({ activeSessionId: null, draftConfiguration: null });
  await materializeDraftSession();
  assert.equal(useAppStore.getState().sessions.find(s => s.id === "s3").modelId, "a");
  assert.equal(useAppStore.getState().sessions.find(s => s.id === "s2").modelId, "a", "other existing chats retain their binding");
});
