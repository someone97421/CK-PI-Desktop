import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mergeSnapshot, assertQueueDraftAvailable } from "../web/recovery.js";
import { createMutationRecovery } from "../web/mutation-recovery.js";
const require = createRequire(import.meta.url);
const { createHostAdapter } = require("../host-adapter.cjs");
const { SubscriptionPool } = require("../server/subscriptions.cjs");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

// A held host read must not let a queued mutation or its own next call bypass revocation.
const gate = deferred(),
  entered = deferred();
let authorized = true;
const calls = [];
const adapter = createHostAdapter({
  desktop: {
    listOperations: async () => [{ id: "agent/stop" }],
    invoke: async ({ operation }) => {
      calls.push(operation);
      if (operation === "session/get") {
        entered.resolve();
        await gate.promise;
        return { session: { id: "s", messages: [] } };
      }
      return {};
    },
  },
});
const first = adapter.invoke(
  "chat.stop",
  { sessionId: "s" },
  { isAuthorized: () => authorized },
);
await entered.promise;
const second = adapter.invoke(
  "chat.stop",
  { sessionId: "s" },
  { isAuthorized: () => authorized },
);
const results = Promise.allSettled([first, second]);
authorized = false;
gate.resolve();
assert.deepEqual(
  (await results).map((x) => x.reason.code),
  ["UNAUTHORIZED", "UNAUTHORIZED"],
);
assert.deepEqual(calls, ["session/get"]);

const memory = new Map();
const storage = {
  getItem: (k) => memory.get(k),
  setItem: (k, v) => memory.set(k, v),
  removeItem: (k) => memory.delete(k),
};
let sends = 0,
  status = "pending";
const api = {
  mutate: async () => {
    sends++;
    throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
  },
  mutationStatus: async () => ({ status, result: { accepted: true } }),
};
let recovery = createMutationRecovery({ api, storage, uuid: () => "original" });
await assert.rejects(
  recovery.mutate("chat.send", { sessionId: "s", text: "hello" }),
);
assert.equal(recovery.pending.id, "original");
recovery = createMutationRecovery({ api, storage, uuid: () => "new" });
await assert.rejects(
  recovery.mutate("chat.send", { sessionId: "s", text: "hello" }),
);
assert.equal(sends, 1);
status = "done";
assert.equal((await recovery.resolve()).id, "original");
assert.equal(recovery.pending, null);
assert.throws(() => assertQueueDraftAvailable("draft-A"));
assert.doesNotThrow(() => assertQueueDraftAvailable(""));

const subscribeGate = deferred();
let attempts = 0,
  unsubscribed = 0;
const pool = new SubscriptionPool({
  onSubscribe: async () => {
    attempts++;
    return subscribeGate.promise;
  },
  onUnsubscribe: async () => {
    unsubscribed++;
  },
});
const a = pool.acquire("s"),
  b = pool.acquire("s");
const subscriptions = Promise.allSettled([a, b]);
subscribeGate.reject(new Error("failed"));
assert.deepEqual(
  (await subscriptions).map((x) => x.status),
  ["rejected", "rejected"],
);
assert.equal(attempts, 1);
pool.release("s");
await pool.release("s");
assert.equal(pool.entries.size, 0);
assert.equal(unsubscribed, 0);
pool.hooks.onSubscribe = async () => {
  attempts++;
  return { snapshot: {} };
};
await pool.acquire("s");
assert.equal(attempts, 2);
await pool.clear();
assert.equal(unsubscribed, 1);

const closingGate=deferred();let starts=0;
const racePool=new SubscriptionPool({onSubscribe:async()=>{starts++;return {};},onUnsubscribe:()=>closingGate.promise});
await racePool.acquire('s');const releasing=racePool.release('s');const acquiring=racePool.acquire('s');
await Promise.resolve();assert.equal(starts,1);closingGate.resolve();await releasing;await acquiring;assert.equal(starts,2);await racePool.clear();

const old = [
  { id: "old", content: "history" },
  { id: "latest", content: "before" },
];
const snapshot = {
  messages: { items: [{ id: "latest", content: "after" }] },
  snapshot: {
    activeItems: [
      {
        id: "tool",
        type: "tool",
        status: "streaming",
        content: {
          toolCallId: "tool",
          toolName: "Read",
          partialResult: "partial",
        },
      },
    ],
  },
};
let merged = mergeSnapshot(old, snapshot);
assert.deepEqual(
  merged.messages.map((x) => x.id),
  ["old", "latest"],
);
assert.equal(merged.messages[1].content, "after");
assert.equal(merged.tools.get("tool").running, true);
merged = mergeSnapshot(merged.messages, {
  messages: { items: [] },
  snapshot: { activeItems: [] },
});
assert.equal(merged.tools.size, 0);
assert.deepEqual(
  mergeSnapshot(old, snapshot, { reset: true }).messages.map((x) => x.id),
  ["latest"],
);
console.log(
  "Six review regressions passed: revocation, uncertain submission/reload, queue draft guard, concurrent subscription failure/retry, tool snapshot recovery, history merge/reset. No listener started.",
);
