import assert from "node:assert/strict";
import { register } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await import("../electron/main/agent-host-bridge.ts");
const { createSessionConfigurationQueue } = await import("../electron/main/runtime/session-configuration.ts");
const { createHostSessionPort } = await import("../../../packages/host-runtime/src/host-ports.ts");
const { IPC } = await import("@pi-desktop/shared");

function fixture({ permissionMode = "ask", globalMode = "ask", active = true } = {}) {
  let session = { id: "s1", mode: "agent", permissionMode };
  let blocked = false;
  const records = new Map();
  const prompts = [];
  const host = { async call(method, params) {
    if (method === "session.get") return { session };
    if (method === "settings.get") return { defaultPermissionMode: globalMode };
    if (method === "session.configure") {
      if (active || blocked) throw Object.assign(new Error("PLAN_CONFIGURATION_BLOCKED"), { data: { errorCode: "PLAN_CONFIGURATION_BLOCKED" } });
      session = { ...session, ...params }; return { session };
    }
    if (method === "session.queueList") return { entries: [...records.values()] };
    if (method === "session.queuePush") { records.set(params.id, params); return {}; }
    if (method === "session.queueRemove") return { removed: records.delete(params.id) };
    throw new Error(`unexpected host call ${method}`);
  } };
  const config = createSessionConfigurationQueue({ getHost: () => host, isTurnActive: () => active, onChanged() {}, log() {} });
  const bridge = createAgentHostBridge({
    channels: IPC.invoke, getHost: () => host,
    isSessionBusy: () => active || config.hasPending("s1"),
    prepareSessionForTurn: async (id) => { if (!active) await config.flush(id); },
    log() {},
    invoke: async (channel, args) => {
      assert.equal(channel, IPC.invoke.agentPrompt);
      prompts.push(args); return { accepted: true, turnId: `runtime-${prompts.length}` };
    },
  });
  return { bridge, config, host, prompts, records,
    setActive: (value) => { active = value; }, setBlocked: (value) => { blocked = value; },
    setGlobal: (value) => { globalMode = value; },
  };
}

for (const [initial, next, globalMode] of [["ask", "auto", "ask"], ["auto", "ask", "ask"], ["ask", "inherit", "auto"], ["inherit", "ask", "auto"]]) {
  test(`an old ${initial} queued cap is never recomputed after changing to ${next} (global ${globalMode})`, async () => {
    const f = fixture({ permissionMode: initial, globalMode });
    const admission = await f.bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
      sessionId: "s1", admission: "queue", input: { text: "queued work" }, context: { requestId: "q" },
    });
    const oldCap = admission.turn.effectivePermissionMode;
    assert.equal(f.records.size, 1);
    await f.config.configure("s1", { permissionMode: next, deferUntilIdle: true });
    f.setActive(false); await f.config.flush("s1", true);
    f.bridge.agentHost.kick("s1");
    for (let n = 0; n < 20 && f.bridge.agentHost.getTurn(admission.turn.id).status === "queued"; n++) await setImmediate();
    const result = f.bridge.agentHost.getTurn(admission.turn.id);
    assert.equal(result.status, "failed");
    assert.equal(result.effectivePermissionMode, oldCap);
    assert.match(result.error.message, /resubmit/);
    assert.equal(f.prompts.length, 0);
  });
}

test("new inherited-global-auto submission uses current effective authority without changing policy", async () => {
  const f = fixture({ permissionMode: "inherit", globalMode: "auto", active: false });
  const result = await f.bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
    sessionId: "s1", input: { text: "new work" }, context: { requestId: "new" },
  });
  assert.equal(result.turn.effectivePermissionMode, "auto");
  assert.equal(f.prompts[0][2], "auto", "IPC receives the immutable authority to recheck under its lock");
});

test("a changed global default is reread and cannot upgrade an already queued inherited ask cap", async () => {
  const f = fixture({ permissionMode: "inherit" });
  const result = await f.bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
    sessionId: "s1", admission: "queue", input: { text: "old work" }, context: { requestId: "old" },
  });
  assert.equal(result.turn.effectivePermissionMode, "ask");
  f.setGlobal("auto"); f.setActive(false); f.bridge.agentHost.kick("s1");
  for (let n = 0; n < 20 && f.bridge.agentHost.getTurn(result.turn.id).status === "queued"; n++) await setImmediate();
  assert.equal(f.bridge.agentHost.getTurn(result.turn.id).status, "failed");
  assert.equal(f.prompts.length, 0);
  const port = createHostSessionPort(() => f.host);
  assert.equal((await port.get("s1")).permissionMode, "auto");
  f.setGlobal("accept-edits");
  assert.equal((await port.get("s1")).permissionMode, "accept-edits");
  f.setGlobal("ask");
  assert.equal((await port.get("s1")).permissionMode, "ask");
});

test("pending Plan configuration holds execution but still accepts new queued input", async () => {
  const f = fixture({ active: false });
  f.setBlocked(true);
  await f.config.configure("s1", { permissionMode: "auto", deferUntilIdle: true });
  const result = await f.bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
    sessionId: "s1", admission: "queue", input: { text: "after the plan" }, context: { requestId: "later" },
  });
  assert.equal(result.turn.status, "queued");
  assert.equal(f.prompts.length, 0);
  assert.equal(f.records.size, 1);
});
