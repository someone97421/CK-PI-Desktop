import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerScheduledIpc } = await import("../electron/main/ipc/scheduled-ipc.ts");

function fixture() {
  const handlers = new Map(); const calls = []; const changes = [];
  let host = { async call(method, params) { calls.push({ method, params }); return { runs: [] }; } };
  registerScheduledIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, scheduledRunsBySession: new Map(), invoke: async () => {}, isQuitting: () => false, onSessionsChanged: () => changes.push("sessionsChanged"),
  });
  return { calls, changes, remove: handlers.get(IPC.invoke.scheduledDelete), list: handlers.get(IPC.invoke.scheduledListRuns), disconnect: () => { host = null; } };
}

test("scheduled run reads forward scoped and latest-per-task options without changing legacy calls", async () => {
  const { list, calls } = fixture();
  await list(); await list({ taskId: "  task-a  ", limit: 30.9 }); await list({ latestPerTask: true });
  assert.deepEqual(calls, [
    { method: "scheduled.listRuns", params: {} },
    { method: "scheduled.listRuns", params: { taskId: "task-a", limit: 30 } },
    { method: "scheduled.listRuns", params: { latestPerTask: true } },
  ]);
});

test("invalid run limits are rejected before reaching the host", async () => {
  const { list, calls } = fixture();
  for (const limit of [NaN, Infinity, -Infinity, "30", null, {}]) {
    await assert.rejects(list({ limit }), /invalid scheduled run limit/);
  }
  assert.deepEqual(calls, []);
  await list({ taskId: " ", latestPerTask: "true" });
  assert.deepEqual(calls[0].params, {}, "unrecognized option shapes cannot request a scoped query");
});

test("scheduled run history remains unavailable when the host disconnects", async () => {
  const { list, disconnect } = fixture(); disconnect();
  await assert.rejects(list({ latestPerTask: true }), /host unavailable/);
});


test("successful task deletion invalidates released transcripts, but a failed delete does not", async () => {
  const { remove, changes, calls, disconnect } = fixture();
  await remove("task-a");
  assert.deepEqual(calls, [{ method: "scheduled.delete", params: { id: "task-a" } }]);
  assert.deepEqual(changes, ["sessionsChanged"]);
  disconnect(); await assert.rejects(remove("task-a"), /host unavailable/);
  assert.deepEqual(changes, ["sessionsChanged"]);
});
