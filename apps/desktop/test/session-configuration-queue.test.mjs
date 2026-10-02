import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Dependency-free checks of the real main-owned queue and IPC/finalizer code.
// This source checkout intentionally need not have Electron/node_modules.
function load(relative, names, bindings = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const code = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+/gm, "");
  return new Function(...Object.keys(bindings), `${code}\nreturn {${names.join(",")}};`)(...Object.values(bindings));
}
const { createSessionConfigurationQueue } = load("../electron/main/runtime/session-configuration.ts", ["createSessionConfigurationQueue"]);
const pause = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let current = { id: "s1", mode: "agent", permissionMode: "ask", thinkingLevel: "off", providerId: "p1", modelId: "m1" };
  let active = true;
  let blocked = false;
  let failure;
  let writeWait;
  const writes = [];
  const notifications = [];
  const host = { async call(method, params) {
    if (method === "session.get") return { session: current ? { ...current } : null };
    assert.equal(method, "session.configure");
    if (blocked || active) throw Object.assign(new Error("PLAN_CONFIGURATION_BLOCKED"), { data: { errorCode: "PLAN_CONFIGURATION_BLOCKED" } });
    if (failure) throw failure;
    if (writeWait) await writeWait.promise;
    writes.push(params);
    current = { ...current, ...params };
    return { session: { ...current } };
  } };
  const queue = createSessionConfigurationQueue({
    getHost: () => host,
    isTurnActive: () => active,
    onChanged: (...args) => notifications.push(args),
    log() {},
  });
  return { queue, host, writes, notifications, get current() { return current; },
    setActive: (value) => { active = value; }, setBlocked: (value) => { blocked = value; },
    setFailure: (value) => { failure = value; }, setWriteWait: (value) => { writeWait = value; },
    remove: () => { current = null; },
  };
}

test("running and waiting-tool-approval settings are drafts, and repeated edits merge latest", async () => {
  const f = fixture();
  const first = await f.queue.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
  assert.equal(first.queued, true);
  assert.equal(first.session.permissionMode, "ask");
  assert.deepEqual(first.session.pendingConfiguration, { permissionMode: "auto" });
  await f.queue.configure("s1", { modelId: "m2", thinkingLevel: "max", deferUntilIdle: true });
  const last = await f.queue.configure("s1", { permissionMode: "accept-edits", deferUntilIdle: true });
  assert.deepEqual(last.session.pendingConfiguration, { modelId: "m2", thinkingLevel: "max", permissionMode: "accept-edits" });
  assert.equal(f.writes.length, 0);
  assert.equal(f.current.modelId, "m1");
  await f.queue.flush("s1");
  assert.equal(f.writes.length, 0);
  f.setActive(false);
  await f.queue.flush("s1", true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.current.permissionMode, "accept-edits");
  assert.equal(f.current.modelId, "m2");
  assert.equal(f.queue.decorate(f.current).pendingConfiguration, undefined);
});

test("reverting every draft field to current settings cancels without writing", async () => {
  const f = fixture();
  await f.queue.configure("s1", { permissionMode: "auto", modelId: "m2", deferUntilIdle: true });
  await f.queue.configure("s1", { permissionMode: "ask", deferUntilIdle: true });
  assert.deepEqual(f.queue.decorate(f.current).pendingConfiguration, { modelId: "m2" });
  const result = await f.queue.configure("s1", { modelId: "m1", deferUntilIdle: true });
  assert.equal(result.queued, false);
  assert.equal(result.session.pendingConfiguration, undefined);
  f.setActive(false);
  await f.queue.flush("s1");
  assert.equal(f.writes.length, 0);
});

test("idle edits apply immediately; legacy immediate calls still honor the host busy gate", async () => {
  const f = fixture();
  await assert.rejects(f.queue.configure("s1", { mode: "plan" }), /PLAN_CONFIGURATION_BLOCKED/);
  assert.equal(f.queue.hasPending("s1"), false);
  f.setActive(false);
  const result = await f.queue.configure("s1", { mode: "plan", deferUntilIdle: true });
  assert.equal(result.queued, false);
  assert.equal(result.session.mode, "plan");
});

test("pending Plan or execution remains immutable until its durable finish", async () => {
  const f = fixture();
  f.setActive(false); f.setBlocked(true);
  const result = await f.queue.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
  assert.equal(result.queued, true);
  await f.queue.flush("s1");
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.queue.flush("s1", true), /PLAN_CONFIGURATION_BLOCKED/);
  f.setBlocked(false);
  await f.queue.flush("s1", true);
  assert.equal(f.current.permissionMode, "auto");
});

test("apply failures retain a visible draft and error; strict prompt guard rejects stale settings", async () => {
  const f = fixture();
  await f.queue.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
  f.setActive(false); f.setFailure(new Error("disk write failed"));
  await f.queue.flush("s1");
  assert.equal(f.queue.decorate(f.current).pendingConfigurationError, "disk write failed");
  await assert.rejects(f.queue.flush("s1", true), /disk write failed/);
  assert.equal(f.current.permissionMode, "ask");
  f.setFailure(undefined);
  await f.queue.flush("s1", true);
  assert.equal(f.queue.hasPending("s1"), false);
  assert.equal(f.queue.decorate(f.current).pendingConfigurationError, undefined);
});

test("invalid queued input is rejected before replacing a valid draft", async () => {
  const f = fixture();
  await f.queue.configure("s1", { mode: "plan", deferUntilIdle: true });
  for (const config of [{ permissionMode: "wide-open" }, { thinkingLevel: "inherit" }, { mode: "unknown" }, { modelId: 3 }]) {
    await assert.rejects(f.queue.configure("s1", { ...config, deferUntilIdle: true }), /Invalid|must be a string/);
  }
  assert.deepEqual(f.queue.decorate(f.current).pendingConfiguration, { mode: "plan" });
});

test("a pending flush and a concurrent new edit serialize without losing the later edit", async () => {
  const f = fixture();
  await f.queue.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
  f.setActive(false);
  const wait = pause(); f.setWriteWait(wait);
  const flush = f.queue.flush("s1");
  const next = f.queue.configure("s1", { permissionMode: "ask", deferUntilIdle: true });
  await Promise.resolve(); wait.resolve();
  await Promise.all([flush, next]);
  assert.equal(f.current.permissionMode, "ask");
  assert.equal(f.writes.length, 2);
});

test("deleted sessions drop pending configuration and return a clear not-found failure", async () => {
  const f = fixture();
  await f.queue.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
  f.setActive(false); f.remove();
  await assert.rejects(f.queue.flush("s1", true), /Session not found/);
  assert.equal(f.queue.hasPending("s1"), false);
});

test("session IPC reads expose actual plus pending, and configure takes the admission lock", async () => {
  const f = fixture();
  const handlers = new Map();
  const channels = new Proxy({}, { get: (_target, key) => String(key) });
  const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", ["registerSessionIpc"], {
    IPC: { invoke: channels }, ErrorCodes: { INVALID_ARGUMENT: "INVALID_ARGUMENT", NOT_FOUND: "NOT_FOUND" },
  });
  let held = false;
  registerSessionIpc({
    registrar: { handle: (name, fn) => handlers.set(name, fn) }, getHost: () => f.host, getSidecar: () => null,
    sessionConfiguration: f.queue,
    acquireSessionOperation: async () => { held = true; return () => { held = false; }; },
    sessionCapabilityContext: async () => { assert.equal(held, true); return {}; },
    enrichSession: (session) => session,
  });
  const result = await handlers.get("sessionConfigure")("s1", { mode: "agent", permissionMode: "auto", deferUntilIdle: true });
  assert.equal(held, false);
  assert.equal(result.queued, true);
  assert.equal(result.session.permissionMode, "ask");
  // Read enrichment shares a dependency; no admission lock is needed for reads.
  held = true;
  const read = await handlers.get("sessionGet")("s1");
  assert.deepEqual(read.session.pendingConfiguration, { permissionMode: "auto" });
  assert.equal(read.session.permissionMode, "ask");
});

for (const reason of ["completed", "aborted", "error"]) {
  test(`turn finalizer applies pending settings before announcement and queue release (${reason})`, async () => {
    const f = fixture();
    const activeTurns = new Map([["s1", "t1"]]);
    await f.queue.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
    const sequence = [];
    const { createPlanRuntime } = load("../electron/main/runtime/plans.ts", ["createPlanRuntime"], {
      IPC: { event: {} }, ErrorCodes: {},
    });
    const coordination = {
      activeTurns, activeTurnUsages: new Map(), turnFinalizations: new Map(), turnSettlements: new Map(),
      planSubmissionTurnKey: (id, turn) => `${id}:${turn}`, isActiveTurn: (id, turn) => activeTurns.get(id) === turn,
      peekAbortReason() {}, clearAbortReason() {}, releaseTurnClaims() {}, shouldCreateTaskNotification: () => false,
      taskTranscript: { finish: async () => {}, usage() {} },
    };
    const { finishTurn } = createPlanRuntime({
      coordination,
      runtimeState: { host: { call: async (method) => { assert.equal(method, "session.endTurn"); sequence.push("durable end"); f.setActive(false); return {}; } },
        agentHostBridge: { endTurn() { assert.equal(f.current.permissionMode, "auto"); sequence.push("bridge end"); }, agentHost: { kick() { sequence.push("kick"); } } } },
      sessionConfiguration: { flush: async (id) => { assert.equal(activeTurns.has(id), false); await f.queue.flush(id); sequence.push("applied"); } },
      planState: {}, logger: { app() {} }, scheduledRunsBySession: new Map(), activeToolCalls: new Map(), planSubmissionTurnIds: new Set(),
      announceTurnEnded: () => { assert.equal(f.current.permissionMode, "auto"); sequence.push("announcement"); }, isQuitting: () => false,
    });
    await finishTurn("s1", reason, undefined, { turnId: "t1" });
    assert.deepEqual(sequence, ["durable end", "applied", "announcement", "bridge end", "kick"]);
  });
}

test("prompt paths recheck the immutable ceiling after applying pending config under the session lock", () => {
  const source = readFileSync(new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url), "utf8");
  const start = source.indexOf("handle(IPC.invoke.agentPrompt");
  const prompt = source.slice(start, source.indexOf("handle(IPC.invoke.", start + 10));
  assert.ok(prompt.indexOf("acquireSessionOperation(req.sessionId)") < prompt.indexOf("sessionConfiguration.flush(req.sessionId, true)"));
  assert.ok(prompt.indexOf("sessionConfiguration.flush(req.sessionId, true)") < prompt.indexOf("expectedPermissionMode !== effectivePermissionMode"));
  assert.ok(prompt.indexOf("expectedPermissionMode !== effectivePermissionMode") < prompt.indexOf('"session.beginTurn"'));
  const bridge = readFileSync(new URL("../electron/main/agent-host-bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /request\.submittedAt,\s+request\.effectivePermissionMode,/);
  assert.match(bridge, /confirm the session settings and resubmit this message/);
});

for (const [mode, expected] of [["goal", "goal"], ["chat", "plan"]]) {
  test(`configuration accepts ${mode} with host-compatible normalization`, async () => {
    const f = fixture();
    const draft = await f.queue.configure("s1", { mode, deferUntilIdle: true });
    assert.equal(draft.session.pendingConfiguration.mode, expected);
    f.setActive(false); await f.queue.flush("s1", true);
    assert.equal(f.current.mode, expected);
  });
}

for (const [configured, globalMode, expectedCap, accepted] of [
  ["inherit", "auto", "ask", false],
  ["inherit", "auto", "auto", true],
  ["ask", "auto", "auto", false],
  ["inherit", "ask", "ask", true],
]) {
  test(`locked IPC ceiling validates ${configured}/${globalMode} against ${expectedCap}`, async () => {
    const f = fixture();
    await f.queue.configure("s1", { permissionMode: configured, deferUntilIdle: true });
    f.setActive(false);
    const handlers = new Map();
    let held = false;
    let launches = 0;
    let settingsReads = 0;
    const host = { call: async (method, params) => {
      if (method === "settings.get") {
        settingsReads++;
        // Simulate global policy changing during admission. The final
        // under-lock check must use the fresh read, not the first snapshot.
        return { defaultPermissionMode: settingsReads === 1 ? "ask" : globalMode };
      }
      return f.host.call(method, params);
    } };
    const { registerAgentIpc } = load("../electron/main/ipc/agent-ipc.ts", ["registerAgentIpc"], {
      IPC: { invoke: new Proxy({}, { get: (_target, key) => String(key) }) },
      ErrorCodes: {}, resolveSessionMessageInput: async () => undefined,
    });
    registerAgentIpc({
      registrar: { handle: (name, fn) => handlers.set(name, fn) }, getHost: () => host,
      getSidecar: () => ({}), getAgentHostBridge: () => null,
      acquireSessionOperation: async () => { held = true; return () => { held = false; }; },
      sessionConfiguration: f.queue, setNotificationViewingSessionId() {},
      resolveAgentRuntimeLaunch: async () => { assert.equal(held, true); launches++; throw new Error("launch reached"); },
    });
    await assert.rejects(handlers.get("agentPrompt")({ sessionId: "s1", content: "hello" }, undefined, expectedCap),
      accepted ? /launch reached/ : (error) => error.errorCode === "FORBIDDEN" && /resubmit/.test(error.message));
    assert.equal(launches, accepted ? 1 : 0);
    assert.equal(held, false);
    assert.equal(settingsReads, 2);
  });
}
