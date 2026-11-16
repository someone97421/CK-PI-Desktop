import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { refreshRemoteSessionState } = await import("../src/lib/remote-session-refresh.ts");
const { createRefreshCoordinator } = await import("../src/lib/refresh-coordinator.ts");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const subscribers = new Set(), events = new Set(), queries = [], selected = [], queuedReads = [];
  const noOp = async () => {};
  let state = {
    activeSessionId: "active", page: "chat", runningSessions: { active: false, stale: true }, isRunning: false,
    agentStatuses: {}, pendingPermissions: {}, pendingAsks: {}, askDrafts: {}, queuedPrompts: {},
    refreshQueuedPrompts: async id => { queuedReads.push(id); },
    refreshSessions: noOp, refreshProviders: noOp, refreshPlugins: noOp,
    refreshNotifications: noOp, refreshPlanCheckpoints: noOp,
    selectSession: async (id, options) => selected.push({ id, options }),
  };
  const store = {
    getState: () => state,
    setState: update => {
      const previous = state;
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
      for (const listener of subscribers) listener(state, previous);
    },
    subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
  };
  const api = {
    getSettings: async () => ({ language: "zh-CN" }),
    listSessions: () => { const query = deferred(); queries.push(query); return query.promise; },
    onAgentEvent: listener => { events.add(listener); return () => events.delete(listener); },
  };
  const emit = (sessionId, type) => {
    store.setState({ runningSessions: { ...state.runningSessions, [sessionId]: type === "agent_start" } });
    for (const listener of events) listener({ sessionId, event: { type } });
  };
  return { store, api, queries, selected, emit, subscribers, events, queuedReads };
}

test("重连快照修正断线残留，并保留请求期间实时开始、结束和本地发送状态", async () => {
  const f = fixture();
  const pending = refreshRemoteSessionState(f.store, f.api);
  f.emit("active", "agent_end");
  f.emit("new", "agent_start");
  f.emit("flipped", "agent_start");
  f.emit("flipped", "agent_end");
  f.store.setState({ runningSessions: { ...f.store.getState().runningSessions, local: true } });
  f.queries[0].resolve({ runningSessionIds: ["active", "flipped", "host"] });
  await pending;
  assert.deepEqual(f.store.getState().runningSessions, { active: false, flipped: false, host: true, new: true, local: true });
  assert.equal(f.store.getState().isRunning, false);
  assert.deepEqual(f.selected, [{ id: "active", options: { record: false } }]);
  assert.equal(f.events.size, 0);
  assert.equal(f.subscribers.size, 0);
});

test("刷新期间再次重连会合并成新的补刷，最终采用最新快照", async () => {
  const f = fixture();
  const refresh = createRefreshCoordinator(() => refreshRemoteSessionState(f.store, f.api));
  const first = refresh(), second = refresh(), third = refresh();
  assert.equal(f.queries.length, 1);
  f.queries[0].resolve({ runningSessionIds: ["active"] });
  await first;
  assert.equal(f.queries.length, 2);
  f.queries[1].resolve({ runningSessionIds: [] });
  await Promise.all([second, third]);
  assert.deepEqual(f.store.getState().runningSessions, {});
  assert.equal(f.store.getState().isRunning, false);
  assert.equal(f.queries.length, 2);
});

test("旁路刷新失败不阻断运行状态与当前会话恢复", async () => {
  const f = fixture();
  f.store.setState({ refreshPlugins: async () => { throw new Error("插件读取失败"); } });
  const pending = refreshRemoteSessionState(f.store, f.api);
  f.queries[0].resolve({ runningSessionIds: ["active"] });
  await pending;
  assert.equal(f.store.getState().isRunning, true);
  assert.equal(f.selected.length, 1);
});

test("重连读取期间切换会话，以当前活动会话恢复，不跳回旧会话", async () => {
  const f = fixture();
  const pending = refreshRemoteSessionState(f.store, f.api);
  f.store.setState({ activeSessionId: "other" });
  f.queries[0].resolve({ runningSessionIds: ["other"] });
  await pending;
  assert.equal(f.store.getState().isRunning, true);
  assert.deepEqual(f.selected, [{ id: "other", options: { record: false } }]);
});

test("重连读取失败释放监听器，后续可以正常恢复", async () => {
  const f = fixture();
  const pending = refreshRemoteSessionState(f.store, f.api);
  const rejected = assert.rejects(pending, /连接中断/);
  f.queries[0].reject(new Error("连接中断"));
  await rejected;
  assert.equal(f.events.size, 0);
  assert.equal(f.subscribers.size, 0);
  assert.equal(f.selected.length, 0);
  const retry = refreshRemoteSessionState(f.store, f.api);
  f.queries[1].resolve({ runningSessionIds: [] });
  await retry;
  assert.deepEqual(f.store.getState().runningSessions, {});
});

test("断线期间结束的会话清理旧审批与状态，并重读已消费的队列", async () => {
  const f = fixture();
  const endedAsk = { sessionId: "stale", requestId: "ended-ask" };
  const liveAsk = { sessionId: "alive", requestId: "live-ask" };
  const livePermission = { sessionId: "alive", requestId: "live-permission" };
  f.store.setState({
    activeSessionId: "stale", runningSessions: { stale: true, alive: true },
    agentStatuses: { stale: { phase: "running" }, alive: { phase: "running" } },
    pendingPermissions: { stale: [{ sessionId: "stale", requestId: "ended-permission" }], alive: [livePermission] },
    pendingAsks: { stale: [endedAsk], alive: [liveAsk] },
    askDrafts: { "ended-ask": { index: 0, answers: [] }, "live-ask": { index: 0, answers: [] } },
    queuedPrompts: { stale: [{ id: "consumed" }], alive: [{ id: "waiting" }] },
    refreshQueuedPrompts: async id => {
      f.queuedReads.push(id);
      if (id === "stale") {
        const { stale, ...remaining } = f.store.getState().queuedPrompts;
        f.store.setState({ queuedPrompts: remaining });
      }
    },
  });
  const pending = refreshRemoteSessionState(f.store, f.api);
  f.queries[0].resolve({ runningSessionIds: ["alive"] });
  await pending;
  const state = f.store.getState();
  assert.deepEqual(Object.keys(state.agentStatuses), ["alive"]);
  assert.deepEqual(state.pendingPermissions, { alive: [livePermission] });
  assert.deepEqual(state.pendingAsks, { alive: [liveAsk] });
  assert.deepEqual(Object.keys(state.askDrafts), ["live-ask"]);
  assert.deepEqual(state.queuedPrompts, { alive: [{ id: "waiting" }] });
  assert.deepEqual(new Set(f.queuedReads), new Set(["stale", "alive"]));
});
