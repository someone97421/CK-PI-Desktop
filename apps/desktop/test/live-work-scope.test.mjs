import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function loadScope(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return server.ssrLoadModule("/electron/main/live-voice/work-scope.ts");
}

test("work scope requires the still-active call binding and a supported local session", async (t) => {
  const { requireSupportedWorkSession } = await loadScope(t);
  const bindings = new Map([["call-a", { workSessionId: "session-a" }]]);
  let lookups = 0;
  const host = {
    call: async () => {
      lookups += 1;
      return { sessions: [{ id: "session-a", source: "desktop" }] };
    },
  };

  assert.deepEqual(await requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-a" }), {
    id: "session-a",
    source: "desktop",
  });
  await assert.rejects(
    requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-b" }),
    { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" },
  );
  await assert.rejects(
    requireSupportedWorkSession({
      host: { call: async () => ({ sessions: [{ id: "session-a", source: "pi-native" }] }) },
      bindings,
      sessionId: "session-a",
      callId: "call-a",
    }),
    { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" },
  );
  await assert.rejects(
    requireSupportedWorkSession({
      host: { call: async () => ({ sessions: [{ id: "session-a", source: "remote" }] }) },
      bindings,
      sessionId: "session-a",
      callId: "call-a",
    }),
    { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" },
  );
  assert.equal(lookups, 1, "an invalid call binding is rejected before Host access");
});

test("a work session removed while Host metadata is being read cannot pass revalidation", async (t) => {
  const { requireSupportedWorkSession } = await loadScope(t);
  const bindings = new Map([["call-a", { workSessionId: "session-a" }]]);
  let finishLookup;
  let lookupStarted;
  const started = new Promise((resolve) => { lookupStarted = resolve; });
  const host = {
    call: () => new Promise((resolve) => {
      finishLookup = resolve;
      lookupStarted();
    }),
  };

  const validation = requireSupportedWorkSession({ host, bindings, sessionId: "session-a", callId: "call-a" });
  await started;
  bindings.delete("call-a");
  finishLookup({ sessions: [{ id: "session-a", source: "desktop" }] });
  await assert.rejects(validation, { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
});

test("selection references are opaque, call-scoped, short-lived, and removed with the call", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { LiveWorkSelectionRegistry } = await server.ssrLoadModule("/electron/main/live-voice/work-selections.ts");
  let now = 10;
  let nextId = 0;
  const registry = new LiveWorkSelectionRegistry(() => now, () => `ref-${++nextId}`);
  const options = registry.issue("call-a", 3, [
    { kind: "project", value: "/private/worktree/demo", label: "demo" },
    { kind: "project", value: "/private/worktree/other", label: "demo" },
  ], "create");

  assert.deepEqual(options, [
    { selectionRef: "ref-1", kind: "project", action: "create", label: "demo", duplicateLabel: true },
    { selectionRef: "ref-2", kind: "project", action: "create", label: "demo", duplicateLabel: true },
  ]);
  assert.equal(JSON.stringify(options).includes("/private/worktree"), false);
  assert.equal(registry.resolve({ callId: "call-b", workBindingRevision: 3, selectionRef: "ref-1" }), undefined);
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 4, selectionRef: "ref-1" }), undefined);
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 3, selectionRef: "ref-1" })?.value, "/private/worktree/demo");

  now += 60_000;
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 3, selectionRef: "ref-2" }), undefined);
  const next = registry.issue("call-a", 3, [{ kind: "project", value: "/private/worktree/new", label: "new" }], "none")[0];
  registry.removeCall("call-a");
  assert.equal(registry.resolve({ callId: "call-a", workBindingRevision: 3, selectionRef: next.selectionRef }), undefined);
});
