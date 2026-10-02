import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createAgentHostBridge } = await import("../electron/main/agent-host-bridge.ts");
const { IPC } = await import("@pi-desktop/shared");
const require = createRequire(import.meta.url);
const { createHostAdapter } = require("../../../plugins/lan-remote-control/host-adapter.cjs");

for (const decision of ["allow-once", "deny"]) {
  test(`LAN tool approval survives refresh/reopen beyond 120 seconds and resolves ${decision} once`, async (t) => {
    let now = Date.parse("2026-09-10T00:00:00.000Z");
    t.mock.method(Date, "now", () => now);
    const request = {
      requestId: "req-lan", sessionId: "s1", toolCallId: "c1", toolName: "Bash",
      reason: "high risk", risk: "high", argsPreview: { command: "ls" },
      createdAt: new Date(now).toISOString(),
    };
    let pending = [request];
    const decisions = [];
    const notifications = [];
    const host = {
      async call(method) {
        if (method === "session.get") return { session: {
          id: "s1", title: "S1", mode: "agent", permissionMode: "ask",
          createdAt: request.createdAt, updatedAt: request.createdAt, messages: [],
        } };
        if (method === "permissions.pending") return { requests: pending };
        throw new Error(`unexpected Host call: ${method}`);
      },
    };
    let bridge;
    async function resolvePermission(resolution) {
      assert.ok(pending.some((item) => item.requestId === resolution.requestId));
      pending = pending.filter((item) => item.requestId !== resolution.requestId);
      decisions.push(resolution);
      // Same notification path as the registered tool/resolvePermission IPC.
      bridge.settleApproval(resolution.requestId, { decision: resolution.decision });
      return { ok: true };
    }
    bridge = createAgentHostBridge({
      getHost: () => host, channels: IPC.invoke, log() {},
      onApprovalResolved: (event) => notifications.push(event),
      async invoke(channel, [resolution]) {
        assert.equal(channel, IPC.invoke.toolResolvePermission);
        return resolvePermission(resolution);
      },
    });
    bridge.ingest({ sessionId: "s1", turnId: "t1", ts: now, event: { type: "agent_start" } });
    bridge.ingest({ sessionId: "s1", turnId: "t1", ts: now, event: { type: "tool_permission_request", request } });
    const pi = {
      models: { async list() { return []; } },
      desktop: {
        async listOperations() {
          return ["plans/pending", "tool/resolvePermission"].map((id) => ({ id }));
        },
        getSessionSnapshot: ({ sessionId }) => bridge.agentHost.snapshotForDesktop(sessionId),
        async invoke({ operation, args }) {
          if (operation === "plans/pending") return { plans: [] };
          if (operation === "tool/resolvePermission") return resolvePermission(args[0]);
          throw new Error(`unexpected desktop call: ${operation}`);
        },
      },
    };
    let adapter = createHostAdapter(pi);
    now += 121_000;
    assert.equal((await adapter.invoke("sessions.pending", { sessionId: "s1" })).approvals.length, 1);
    adapter = createHostAdapter(pi);
    now += 121_000;
    const reopened = await adapter.invoke("sessions.pending", { sessionId: "s1" });
    assert.equal(reopened.approvals.length, 1);
    assert.equal(reopened.approvals[0].expiresAt, undefined);
    await assert.rejects(adapter.invoke("approval.resolve", {
      sessionId: "s1", approvalId: request.requestId, decision: "allow-session",
    }), { code: "INVALID_PARAMS" });
    assert.equal(decisions.length, 0);
    assert.deepEqual(await adapter.invoke("approval.resolve", {
      sessionId: "s1", approvalId: request.requestId, decision,
    }), { resolved: true });
    assert.deepEqual(decisions, [{ requestId: request.requestId, decision }]);
    assert.deepEqual(notifications, [{ sessionId: "s1", approvalId: request.requestId }]);
    assert.equal((await adapter.invoke("sessions.pending", { sessionId: "s1" })).approvals.length, 0);
    await assert.rejects(adapter.invoke("approval.resolve", {
      sessionId: "s1", approvalId: request.requestId, decision,
    }), { code: "NOT_FOUND" });
    assert.equal(decisions.length, 1);
  });
}

for (const replacement of ["disconnected", "replaced"]) {
  test(`a Host ${replacement} during a pending read cannot restore its old approval cards`, async () => {
    let finish;
    let notifyRead;
    const reading = new Promise((resolve) => { notifyRead = resolve; });
    const original = {
      async call(method) {
        if (method === "session.get") return { session: {
          id: "s1", title: "S1", mode: "agent", permissionMode: "ask", messages: [],
          createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
        } };
        if (method === "permissions.pending") {
          notifyRead();
          return new Promise((resolve) => { finish = resolve; });
        }
        throw new Error(`unexpected Host call: ${method}`);
      },
    };
    let current = original;
    const bridge = createAgentHostBridge({
      getHost: () => current, channels: IPC.invoke, log() {},
      async invoke() { assert.fail("reading approvals must not resolve them"); },
    });
    const snapshot = bridge.agentHost.snapshotForDesktop("s1");
    await reading;
    current = replacement === "disconnected" ? null : { ...original };
    finish({ requests: [{
      requestId: "stale", sessionId: "s1", toolCallId: "c1", toolName: "Bash",
      reason: "high risk", risk: "high", argsPreview: {}, createdAt: "2026-09-10T00:00:00.000Z",
    }] });
    assert.deepEqual((await snapshot).pendingApprovals, []);
  });
}
