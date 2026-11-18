import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as sidebar from "../src/lib/sidebar-preferences.ts";
import { settleBootstrapRequests } from "../src/lib/bootstrap-result.ts";

const source = await readFile(new URL("../src/stores/app-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("app-store.ts", source, ts.ScriptTarget.Latest, true);
let bootstrap;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === "bootstrap") bootstrap = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule(`let bootstrapGeneration = 0; return (${bootstrap.getText(ast)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

test("startup waits for saved models on retry and restores registered project tabs", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  let state = { ready: false, ...sidebar.loadSidebarPreferences(), navStack: [], navIndex: -1 };
  const bindings = {
    get: () => ({ ...state, refreshPluginViews: async () => {} }),
    set: update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    api: {
      getSettings: async () => ({ defaultMode: "agent" }), getVersion: async () => ({ protocolVersion: 11 }),
      health: async () => ({ ok: true }), listSessions: async () => ({ sessions: [] }),
      listProviders: async () => ({ providers: [] }), getProject: async () => ({ workspace: { path: "/active" } }),
      getOnboarding: async () => ({}), listPlugins: async () => ({ plugins: [] }),
      listNotifications: async () => ({ notifications: [], unreadCount: 0 }), pendingPlans: async () => ({ plans: [] }),
      getSidebarPreferences: async () => null, setSidebarPreferences: async () => {},
      listProjects: async () => ({ projects: [{ path: "/synthetic/alpha" }, { path: "/synthetic/beta" }] }),
    },
    window: {}, normalizeBuiltinMode: mode => mode, migrateKeybindingOverrides: value => value,
    restoreSidebarPreferences: sidebar.restoreSidebarPreferences, sidebarPreferencesState: sidebar.sidebarPreferencesState,
    settleBootstrapRequests, PROTOCOL_VERSION: 11,
    withProjectDisplayName: value => value, projectWorkspaceFromPath: path => ({ path }),
    promoteProjectPath: (paths, path) => [...new Set([...paths, path])],
    upsertWorkspace: (projects, workspace) => [...projects.filter(p => p.path !== workspace.path), workspace],
    decorateSessions: value => value, isPendingPlan: () => false, latestSessionOutcomes: () => ({}),
    saveSidebarPreferences: sidebar.saveSidebarPreferences,
    preferencesFromState: value => value, rememberProject: () => {},
    switchWorkPanelSession: () => ({}), clearSessionPanes: () => ({}),
  };
  const run = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
  bindings.api.listProviders = async () => ({ providers: [{ id: "saved" }] });
  bindings.api.listProviderModels = async () => { throw new Error("cache unavailable"); };
  await run();
  assert.equal(state.ready, false);
  assert.equal(state.startupReadFailed, true);
  assert.equal(state.error, "cache unavailable");
  const reading = Promise.withResolvers();
  const pendingModels = Promise.withResolvers();
  bindings.api.listProviderModels = () => {
    reading.resolve();
    return pendingModels.promise;
  };
  const retry = run();
  await reading.promise;
  assert.equal(state.ready, false);
  pendingModels.resolve({ models: [{ modelId: "saved-model" }] });
  await retry;
  assert.equal(state.ready, true);
  assert.equal(state.error, null);
  assert.equal(state.providerModels.saved[0].modelId, "saved-model");
  assert.deepEqual(state.openProjectPaths, ["/synthetic/alpha", "/synthetic/beta", "/active"]);
});
