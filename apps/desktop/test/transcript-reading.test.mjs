import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptReadingRuntime } = await import(
  "../src/stores/runtime/transcript-reading-runtime.ts"
);
const { extendTranscriptView, transcriptViewMessages } = await import("../src/lib/transcript-reading.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { prepareTranscriptAction } = await import("../src/stores/runtime/transcript-action.ts");

const target = (messageId) => ({ sessionId: "s", messageId, query: "needle" });
const message = (id, content = id, extra = {}) => ({
  id,
  role: "user",
  content,
  createdAt: `2026-09-13T00:00:00Z`,
  ...extra,
});
const page = (messages, options = {}) => ({
  session: {
    id: "s",
    messages,
    messageStart: 20,
    messageEnd: 80,
    hasMoreBefore: true,
    hasMoreAfter: true,
    ...options,
  },
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function reader(read, overrides = {}) {
  const errors = [];
  let runtime;
  let state = {
    activeSessionId: "s",
    messages: [message("tail")],
    sessionHistory: { s: { messageStart: 120, hasMoreBefore: true } },
    transcriptViews: {},
    retainedSessionIds: ["s"],
    retainedTranscripts: {},
    runningSessions: {},
    subagentPanel: null,
    showToast: (error) => errors.push(error),
    ...overrides,
  };
  const access = {
    get: () => state,
    set: (patch) => {
      const previous = state;
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      runtime?.reconcile(state, previous);
    },
  };
  runtime = createTranscriptReadingRuntime(access, read);
  return {
    ...access,
    ...runtime.actions,
    errors,
    view: () => state.transcriptViews.s,
    visible: () => transcriptViewMessages(state.messages, state.transcriptViews.s),
  };
}

test("a search jump keeps complete focused text without changing live/model input", async () => {
  const calls = [];
  const content = `${"prefix ".repeat(15_000)}needle`;
  const r = reader(async (...args) => {
    calls.push(args);
    return page([message("old", content)]);
  });
  const live = r.get().messages;
  await r.navigateTranscript(target("old"));
  assert.deepEqual(calls, [["s", { messageAround: "old", messageLimit: 60, contentLimit: 65536 }]]);
  assert.equal(r.visible()[0].content, content);
  assert.equal(r.view().focus.messageId, "old");
  assert.equal(r.view().loading, null);
  assert.equal(r.get().messages, live);
});

test("the latest click owns completion and obsolete errors", async () => {
  const first = deferred();
  const second = deferred();
  let count = 0;
  const r = reader(() => (++count === 1 ? first : second).promise);
  const a = r.navigateTranscript(target("a"));
  const b = r.navigateTranscript(target("b"));
  second.resolve(page([message("b")]));
  await b;
  first.reject(new Error("obsolete request"));
  await a;
  assert.equal(r.view().focus.messageId, "b");
  assert.deepEqual(r.errors, []);
});

test("both directions use physical cursors, deduplicate overlap, and preserve focused text", async () => {
  const calls = [];
  const responses = [
    page([message("a"), message("b", "full needle"), message("c")]),
    page([message("b", "clipped"), message("c"), message("d")], {
      messageStart: 70,
      messageEnd: 130,
      hasMoreAfter: false,
    }),
    page([message("z"), message("a")], { messageStart: 0, messageEnd: 20, hasMoreBefore: false }),
  ];
  const r = reader(async (_id, options) => {
    calls.push(options);
    return responses.shift();
  });
  await r.navigateTranscript(target("b"));
  await r.loadTranscriptPage("s", "after");
  assert.equal(calls[1].messageBefore, 140);
  await r.loadTranscriptPage("s", "before");
  assert.equal(calls[2].messageBefore, 20);
  assert.deepEqual(
    r.visible().map((item) => item.id),
    ["z", "a", "b", "c", "d"],
  );
  assert.equal(r.visible()[2].content, "full needle");
  assert.equal(r.view().hasMoreBefore, false);
  assert.equal(r.view().hasMoreAfter, false);
  await r.loadTranscriptPage("s", "after");
  assert.equal(calls.length, 3);
});

test("ordinary history uses the same page ownership and keeps receiving live output", async () => {
  const calls = [];
  const first = deferred();
  const r = reader(async (_id, options) => {
    calls.push(options);
    return calls.length === 1
      ? first.promise
      : page([message("oldest")], {
          messageStart: 0,
          messageEnd: 20,
          hasMoreBefore: false,
          hasMoreAfter: true,
        });
  });
  const live = r.get().messages;
  const loading = r.loadTranscriptPage("s", "before");
  await r.loadTranscriptPage("s", "before");
  assert.equal(calls.length, 1, "coalesce repeated top-boundary events");
  first.resolve(page([message("older")], { messageStart: 20, messageEnd: 120 }));
  await loading;
  assert.equal(r.get().messages, live, "reading does not hydrate model input");
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["older", "tail"],
  );
  r.set({
    runningSessions: { s: true },
    messages: [...live, message("stream", "partial", { status: "streaming" })],
  });
  await r.loadTranscriptPage("s", "before");
  assert.equal(
    calls[1].messageBefore,
    20,
    "continue the reading cursor, not the live cache cursor",
  );
  assert.equal(calls[1].messageLimit, 100);
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["oldest", "older", "tail", "stream"],
  );
  assert.equal(r.visible().at(-1).content, "partial");
});

test("历史分页补齐旧提问与最新过程之间的缺口，任务仍位于提问之后", async () => {
  const task = { id: "turn", status: "running" };
  const prompt = message("prompt", "继续", {
    taskId: task.id, createdAt: "2026-09-28T09:00:00Z",
  });
  const process = (id, minute) => message(id, id, {
    role: "assistant", taskId: task.id, task,
    createdAt: `2026-09-28T09:${minute}:00Z`,
  });
  const earlier = process("earlier", "01");
  const latest = process("latest", "02");
  for (const fetched of [[earlier], [earlier, latest]]) {
    const r = reader(async () => page(fetched, { messageStart: 1 }), {
      messages: [prompt, latest], runningSessions: { s: true },
    });
    await r.loadTranscriptPage("s", "before");
    assert.deepEqual(r.visible().map((row) => row.id), ["prompt", "earlier", "latest"]);
    const { entries } = buildTranscriptEntries(r.visible());
    assert.equal(entries[0].message.id, "prompt");
    assert.equal(entries.at(-1).id, "task:turn");
    assert.deepEqual(entries.at(-1).sourceMessages.map((row) => row.id),
      ["prompt", "earlier", "latest"]);
    assert.deepEqual(r.get().messages, [prompt, latest], "补页不改写实时消息缓存");
  }
});

test("实时窗口补入共同消息之前的过程时，仍保留更早的历史提问", () => {
  const prompt = message("prompt", "继续", { createdAt: "2026-09-28T09:00:00Z" });
  const earlier = message("earlier", "过程", {
    role: "assistant", createdAt: "2026-09-28T09:01:00Z",
  });
  const latest = message("latest", "完成", {
    role: "assistant", status: "complete", createdAt: "2026-09-28T09:02:00Z",
  });
  const visible = transcriptViewMessages([earlier, latest], {
    messages: [prompt, { ...latest, content: "旧正文", status: "streaming" }], focus: null,
  });
  assert.deepEqual(visible.map((row) => row.id), ["prompt", "earlier", "latest"]);
  assert.equal(visible.at(-1), latest, "实时正文和完成状态覆盖旧快照");
});

test("向后补页保留分页内部顺序、同时间位置和搜索原文", () => {
  const focused = message("focus", "完整搜索原文", { createdAt: "2026-09-28T09:00:00Z" });
  const later = message("later", "稍后消息", { createdAt: "2026-09-28T09:03:00Z" });
  const middle = message("middle", "过程", { createdAt: "2026-09-28T09:01:00Z" });
  const sameTime = message("same-time", "同时间消息", { createdAt: focused.createdAt });
  const result = extendTranscriptView({
    messages: [focused, later], messageStart: 0, messageEnd: 4,
    hasMoreBefore: false, hasMoreAfter: true, loading: "after", focus: target("focus"),
  }, page([
    { ...focused, content: "截断原文" }, sameTime, middle, later,
    message("clock-backwards", "工具时间回退", { createdAt: middle.createdAt }),
  ], { messageStart: 0, messageEnd: 5, hasMoreAfter: false }).session, "after");
  assert.deepEqual(result.messages.map((row) => row.id),
    ["focus", "same-time", "middle", "later", "clock-backwards"]);
  assert.equal(result.messages[0], focused);
  assert.equal(result.hasMoreAfter, false);
  assert.equal(result.messageEnd, 5);
});

test("search supersedes an ordinary page and return-to-latest cancels historical paging", async () => {
  const older = deferred();
  const later = deferred();
  let count = 0;
  const r = reader(() => {
    count += 1;
    return count === 1
      ? older.promise
      : count === 2
        ? Promise.resolve(page([message("hit")]))
        : later.promise;
  });
  const normal = r.loadTranscriptPage("s", "before");
  await r.navigateTranscript(target("hit"));
  older.resolve(page([message("obsolete")]));
  await normal;
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["hit"],
  );
  const load = r.loadTranscriptPage("s", "after");
  r.returnToLatestTranscript("s");
  later.resolve(page([message("obsolete-later")]));
  await load;
  assert.equal(r.view(), undefined);
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["tail"],
  );
});

test("a nested result opens its real Task and exposes its answer even outside the page", async () => {
  const child = message("child", "needle", {
    role: "assistant",
    parentToolCallId: "task-call",
    agentName: "reviewer",
  });
  const parent = message("parent-row", "", {
    role: "tool",
    toolName: "Task",
    toolCallId: "task-call",
  });
  const r = reader(async () => page([child], { navigationParent: parent }));
  await r.navigateTranscript(target("child"));
  assert.equal(r.get().subagentPanel.delegationId, "task-call");
  assert.equal(r.get().subagentPanel.searchRequestId, r.view().focus.requestId);
  const { entries } = buildTranscriptEntries(r.visible());
  const task = entries[0].parts[0].items[0];
  assert.equal(task.message.id, parent.id);
  assert.equal(task.delegate.items[0].message.id, child.id);
  assert.equal(r.view().messageStart, 20, "parent context does not move physical cursors");
  r.returnToLatestTranscript("s");
  assert.equal(r.get().subagentPanel, null);
});

test("a failed search cannot restore a cancelled page's loading state or ownership", async () => {
  const older = deferred();
  const search = deferred();
  let calls = 0;
  const r = reader(() => (++calls === 1 ? older.promise : search.promise));
  const loading = r.loadTranscriptPage("s", "before");
  const navigation = r.navigateTranscript(target("missing"));
  older.resolve(page([message("discarded")]));
  await loading;
  search.resolve({ session: null });
  await navigation;
  assert.equal(r.view().loading, null);
  assert.equal(r.view().focus, null);
  assert.deepEqual(
    r.visible().map((m) => m.id),
    ["tail"],
  );
});

test("deleted targets and missing parent tasks report failure and preserve the previous view", async () => {
  for (const response of [
    page([message("different")]),
    page([message("deleted", "needle", { parentToolCallId: "missing" })]),
  ]) {
    const r = reader(async () => response);
    await r.navigateTranscript(target("deleted"));
    assert.deepEqual(
      r.visible().map((m) => m.id),
      ["tail"],
    );
    assert.equal(r.view().focus, null);
    assert.match(r.errors[0], /no longer exists/);
  }
});

test("new turns, pane eviction, and canonical edits invalidate pending reads", async () => {
  for (const change of [
    { runningSessions: { s: true } },
    { retainedSessionIds: [] },
    { messages: [message("tail", "edited with the same id")] },
    { messages: [] },
  ]) {
    const pending = deferred();
    const r = reader(() => pending.promise);
    const navigation = r.navigateTranscript(target("old"));
    r.set(change);
    pending.resolve(page([message("old")]));
    await navigation;
    assert.equal(r.view(), undefined);
    assert.deepEqual(r.errors, []);
  }
});

test("a session switch cannot let an old nested search open the new session's panel", async () => {
  const pending = deferred();
  const r = reader(() => pending.promise);
  const navigation = r.navigateTranscript(target("child"));
  r.set({ activeSessionId: "other", retainedSessionIds: ["other", "s"] });
  pending.resolve(
    page([message("child", "needle", { parentToolCallId: "task" })], {
      navigationParent: message("task", "", { role: "tool", toolName: "Task", toolCallId: "task" }),
    }),
  );
  await navigation;
  assert.equal(r.get().subagentPanel, null);
  assert.equal(r.view(), undefined);
});

test("an explicit old-message action loads canonical input only when required", async () => {
  let state = {
    activeSessionId: "s",
    messages: [message("tail")],
    sessionHistory: { s: { hasMoreBefore: false } },
  };
  const access = {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
  };
  const full = [message("old"), message("tail")];
  let reads = 0;
  let cached;
  const runtime = {
    loadFullSessionMessages: async (_id, cache) => {
      assert.equal(cache, false);
      reads += 1;
      return full;
    },
    cacheSessionTranscript: (_id, messages) => {
      cached = messages;
    },
  };
  assert.equal(await prepareTranscriptAction(access, runtime, "tail"), state);
  assert.equal(reads, 0);
  await prepareTranscriptAction(access, runtime, "old");
  assert.equal(reads, 1);
  assert.equal(state.messages, full);
  assert.equal(cached, full);
  assert.deepEqual(state.sessionHistory.s, { messageStart: 0, hasMoreBefore: false });
});

test("action preparation cannot overwrite a later navigation or newly started turn", async () => {
  for (const change of [
    { activeSessionId: "other" },
    { isRunning: true },
    { messages: [message("tail", "edited")] },
  ]) {
    let state = { activeSessionId: "s", messages: [message("tail")], sessionHistory: {} };
    const pending = deferred();
    const read = prepareTranscriptAction(
      { get: () => state, set: () => assert.fail("stale action must not write") },
      {
        loadFullSessionMessages: () => pending.promise,
        cacheSessionTranscript: () => assert.fail("stale action must not replace the live cache"),
      },
      "old",
    );
    state = { ...state, ...change };
    pending.resolve([message("old")]);
    assert.equal(await read, null);
  }
});

test("a visible message still hydrates canonical input when the tail is bounded or clipped", async () => {
  for (const history of [{ hasMoreBefore: true }, { hasMoreBefore: false, contentLimited: true }]) {
    let state = {
      activeSessionId: "s",
      messages: [message("visible", "clipped")],
      sessionHistory: { s: history },
    };
    const full = [message("earlier"), message("visible", "complete original content")];
    const access = {
      get: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
      },
    };
    await prepareTranscriptAction(
      access,
      {
        loadFullSessionMessages: async () => full,
        cacheSessionTranscript: (_id, messages) => assert.equal(messages, full),
      },
      "visible",
    );
    assert.equal(state.messages, full);
    assert.equal(state.sessionHistory.s.hasMoreBefore, false);
    assert.notEqual(state.sessionHistory.s.contentLimited, true);
  }
});

test("paging during an existing stream never freezes its snapshot over newer tokens or completion", async () => {
  const delayed = deferred();
  const initial = message("reply", "first token", { role: "assistant", status: "streaming" });
  const r = reader(() => delayed.promise, { messages: [initial], runningSessions: { s: true } });
  const loading = r.loadTranscriptPage("s", "before");
  const streaming = { ...initial, content: "more tokens" };
  r.set({ messages: [streaming] });
  assert.equal(r.visible().at(-1), streaming);
  delayed.resolve(page([message("older"), initial], { messageStart: 0, hasMoreBefore: false }));
  await loading;
  assert.equal(r.visible().at(-1), streaming);
  const complete = { ...streaming, content: "complete answer", status: "complete" };
  r.set({ messages: [complete], runningSessions: {} });
  assert.deepEqual(
    r.visible().map((item) => item.id),
    ["older", "reply"],
  );
  assert.equal(r.visible().at(-1), complete);
});
