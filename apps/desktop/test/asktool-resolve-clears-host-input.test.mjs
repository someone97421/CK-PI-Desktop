import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "@pi-desktop/agent-runtime";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await import("../electron/main/agent-host-bridge.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
const { createInteractionRuntime } = await import("../src/stores/runtime/interaction-runtime.ts");

const answer = { sessionId: "s1", requestId: "ask_1", answers: [["a"]] };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// Real registered IPC -> real bridge/AgentHost, with only the sidecar transport
// replaced. The sidecar executes the runtime's real answer validator/resolver;
// unlike a successful invoke stub, this also catches recursive IPC wiring.
function fixture() {
  const handlers = new Map();
  const calls = [];
  const notifications = [];
  const accepted = [];
  const runtimes = new Map();
  let failure;
  let gate;
  let acknowledgement;
  const host = { async call(method, params) {
    if (method === "session.get") return { session: {
      id: params.id, title: "Session", mode: "agent", permissionMode: "ask",
      createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", messages: [],
    } };
    if (method === "permissions.pending") return { requests: [] };
    throw new Error(`unexpected host method: ${method}`);
  } };
  const sidecar = { async call(method, resolution) {
    calls.push({ method, resolution });
    assert.equal(method, "asktool.resolve");
    if (gate) await gate.promise;
    if (failure) throw failure;
    if (acknowledgement) return acknowledgement;
    const runtime = runtimes.get(resolution.sessionId);
    if (!runtime) throw Object.assign(new Error("runtime not found"), { errorCode: "ASKTOOL_NOT_FOUND" });
    return runtime.resolveAskTool(resolution);
  } };
  let bridge;
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => sidecar, getAgentHostBridge: () => bridge,
  });
  const invoke = (channel, args) => handlers.get(channel)(...args);
  bridge = createAgentHostBridge({
    channels: IPC.invoke, getHost: () => host, invoke, log() {},
    onInputResolved: (event) => notifications.push(event),
  });
  function addAsk(sessionId = "s1", requestId = "ask_1", mirror = true) {
    let runtime = runtimes.get(sessionId);
    if (!runtime) {
      runtime = Object.create(DesktopAgentRuntime.prototype);
      runtime.sessionId = sessionId;
      runtime.pendingAskTools = new Map();
      runtimes.set(sessionId, runtime);
      bridge.ingest({ sessionId, turnId: `turn-${sessionId}`, ts: Date.now(), event: { type: "agent_start" } });
    }
    const request = { sessionId, requestId, toolCallId: `tool-${requestId}`, questions: [{ question: "Which?", options: ["a", "b"] }] };
    runtime.pendingAskTools.set(requestId, { request, resolve(answers) {
      runtime.pendingAskTools.delete(requestId);
      accepted.push({ sessionId, requestId, answers });
    } });
    if (mirror) bridge.ingest({ sessionId, turnId: `turn-${sessionId}`, ts: Date.now(), event: { type: "asktool_request", request } });
    return request;
  }
  const ask = addAsk();
  return {
    bridge, ask, calls, accepted, notifications, addAsk, invoke,
    submit: (resolution = answer) => invoke(IPC.invoke.askToolResolve, [resolution]),
    snapshot: (sessionId = "s1") => bridge.agentHost.snapshot(sessionId),
    setFailure: (value) => { failure = value; }, setGate: (value) => { gate = value; },
    setAcknowledgement: (value) => { acknowledgement = value; },
  };
}

function renderer(f, t) {
  const previous = globalThis.window;
  globalThis.window = { piDesktop: { async invoke(channel, ...args) {
    try { return { ok: true, data: await f.invoke(channel, args) }; }
    catch (error) { return { ok: false, error: { message: error.message, code: error.errorCode } }; }
  } } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  let state = { pendingAsks: { s1: [f.ask] } };
  const runtime = createInteractionRuntime();
  const actions = createInteractionSlice({
    get: () => state,
    set: (update) => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; },
    interactionRuntime: runtime,
    runtime: {},
  });
  return { actions, runtime, state: () => state };
}

test("desktop answer crosses registered IPC once and clears the Host input after acknowledgement", async () => {
  const f = fixture();
  assert.equal((await f.snapshot()).pendingInputs.length, 1);
  assert.deepEqual(await f.submit(), { ok: true });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.accepted, [answer]);
  assert.deepEqual((await f.snapshot()).pendingInputs, []);
  assert.equal((await f.snapshot()).activeTurn.status, "running");
  assert.deepEqual(f.notifications, [{ sessionId: "s1", inputId: "ask_1" }]);
});

test("Host-originated answer uses the same registered IPC without re-entering respondInput", async () => {
  const f = fixture();
  const result = await f.bridge.agentHost.respondInput(DESKTOP_PRINCIPAL, {
    inputId: answer.requestId, answers: answer.answers, context: { requestId: "remote-answer" },
  });
  assert.deepEqual(result, { inputId: "ask_1", status: "resolved" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.accepted.length, 1);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual((await f.snapshot()).pendingInputs, []);
});

test("failure retains Host input and the same renderer card; retry submits its answers once", async (t) => {
  const f = fixture();
  const ui = renderer(f, t);
  const error = new Error("sidecar temporarily unavailable");
  f.setFailure(error);
  await assert.rejects(ui.actions.resolveAsk("s1", answer), /temporarily unavailable/);
  assert.strictEqual(ui.state().pendingAsks.s1[0], f.ask, "same request keeps the answer editor mounted");
  assert.equal(ui.runtime.askResolutionRequests.size, 0);
  assert.equal((await f.snapshot()).pendingInputs.length, 1);
  assert.equal(f.notifications.length, 0);
  f.setFailure(undefined);
  await ui.actions.resolveAsk("s1", answer);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.accepted, [answer]);
  assert.equal(ui.state().pendingAsks.s1, undefined);
  assert.equal(ui.runtime.askResolutionRequests.size, 0);
  assert.deepEqual((await f.snapshot()).pendingInputs, []);
});

test("rapid renderer clicks share an in-flight submission and keep the card until acknowledgement", async (t) => {
  const f = fixture();
  const ui = renderer(f, t);
  const gate = deferred(); f.setGate(gate);
  const first = ui.actions.resolveAsk("s1", answer);
  const second = ui.actions.resolveAsk("s1", answer);
  await assert.rejects(ui.actions.resolveAsk("s1", { ...answer, answers: [["b"]] }), /already being submitted/);
  assert.equal(f.calls.length, 1);
  assert.strictEqual(ui.state().pendingAsks.s1[0], f.ask);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.accepted.length, 1);
  assert.equal(ui.runtime.askResolutionRequests.size, 0);
});

test("duplicate IPC answers coalesce; conflicting answers cannot replace one already in flight", async () => {
  const f = fixture();
  const gate = deferred(); f.setGate(gate);
  const first = f.submit();
  const duplicate = f.submit({ ...answer, answers: [["a"]] });
  await assert.rejects(f.submit({ ...answer, answers: [["b"]] }), { errorCode: "CONFLICT" });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.snapshot()).pendingInputs.length, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, duplicate]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(f.accepted, [answer]);
  assert.equal(f.notifications.length, 1);
});

test("settled or stale requests fail without clearing a newer question", async () => {
  const f = fixture();
  await f.submit();
  f.addAsk("s1", "ask_2");
  await assert.rejects(f.submit(), { errorCode: "ASKTOOL_NOT_FOUND" });
  assert.deepEqual((await f.snapshot()).pendingInputs.map((input) => input.id), ["ask_2"]);
  assert.equal(f.accepted.length, 1);
  assert.equal(f.notifications.length, 1);
});

test("answer validation and negative acknowledgements preserve pending state", async () => {
  const f = fixture();
  await assert.rejects(f.submit({ ...answer, answers: [] }), { errorCode: "ASKTOOL_INVALID_ARGUMENT" });
  f.setAcknowledgement({ ok: false });
  await assert.rejects(f.submit(), /not acknowledged/);
  assert.equal((await f.snapshot()).pendingInputs.length, 1);
  assert.equal(f.notifications.length, 0);
  f.setAcknowledgement(undefined);
  await f.submit();
  assert.deepEqual(f.accepted, [answer]);
});

test("direct runtime answers work when Host has no mirror of the request", async () => {
  const f = fixture();
  f.addAsk("s2", "unmirrored", false);
  assert.deepEqual(await f.submit({ ...answer, sessionId: "s2", requestId: "unmirrored" }), { ok: true });
  assert.equal((await f.snapshot("s1")).pendingInputs.length, 1);
  assert.deepEqual((await f.snapshot("s2")).pendingInputs, []);
});

test("same request IDs in different sessions remain separate during concurrent answers", async () => {
  const f = fixture();
  f.addAsk("s2");
  const gate = deferred(); f.setGate(gate);
  const first = f.submit();
  const second = f.submit({ ...answer, sessionId: "s2", answers: [["b"]] });
  assert.equal(f.calls.length, 2);
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.accepted.length, 2);
  assert.deepEqual((await f.snapshot("s1")).pendingInputs, []);
  assert.deepEqual((await f.snapshot("s2")).pendingInputs, []);
});
