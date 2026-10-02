import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the real TS/TSX source with only the React/IPC boundaries replaced.
// This is a deterministic hook/handler harness, not a browser integration test.
function sourceModule(path, imports, globals = {}) {
  const filename = new URL(path, import.meta.url);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (name in imports) return imports[name];
    if (name.endsWith(".css")) return {};
    throw new Error(`Unexpected source import ${name} in ${path}`);
  };
  new Function("module", "exports", "require", ...Object.keys(globals), source)(
    module, module.exports, require, ...Object.values(globals),
  );
  return module.exports;
}

const jsx = (type, props, key) => ({ type, props, key });
const translate = (key) => key;
const elementBoundary = new Proxy({}, { get: (_, key) => String(key) });
const task = (cadence, schedule) => ({
  id: "task-a", title: "  Check project  ", prompt: "  Check the result  ", cadence, schedule,
  mode: "agent", enabled: true, workspacePath: "/project", permissionMode: "ask",
  providerId: "custom", modelId: "custom-model", thinkingLevel: "omit",
});

function hooks() {
  const slots = [];
  let index = 0;
  let dirty = false;
  let effects = [];
  let value;
  let component;
  const different = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const api = {
    useState(initial) {
      const i = index++;
      slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => {
        const result = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(result, slots[i].value)) { slots[i].value = result; dirty = true; }
      }];
    },
    useRef(initial) { const i = index++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(fn, deps) {
      const i = index++;
      if (!slots[i] || different(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useCallback(fn, deps) { return api.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || different(slots[i].deps, deps)) {
        const old = slots[i]; slots[i] = { deps };
        effects.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  function render(next = component) {
    component = next;
    let loops = 0;
    do {
      dirty = false; index = 0; value = component();
      const pending = effects; effects = []; for (const effect of pending) effect();
      assert.ok(++loops < 30, "hook harness must settle");
    } while (dirty);
    return value;
  }
  return {
    api, render,
    async flush() { await new Promise((resolve) => setImmediate(resolve)); return render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function walk(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = walk(child, predicate); if (found) return found;
  }
  return null;
}

for (const [cadence, schedule, expected] of [
  ["manual", null, null],
  ["hourly", { hour: 9, minute: 5, weekday: 2 }, { hour: 0, minute: 0, weekday: 0 }],
  ["daily", { hour: 9, minute: 5, weekday: 2 }, { hour: 9, minute: 5, weekday: 2 }],
  ["weekly", { hour: 9, minute: 5, weekday: 2, weekdays: [2, 4] }, { hour: 9, minute: 5, weekday: 2, weekdays: [2, 4] }],
]) {
  test(`the existing ${cadence} editor preserves its saved payload shape`, () => {
    const runtime = hooks(); let saved;
    const { ScheduledEditor } = sourceModule("../src/features/scheduled/ScheduledEditor.tsx", {
      react: runtime.api, "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-i18next": { useTranslation: () => ({ t: translate }) },
      "../../components/ui": elementBoundary,
      "../../components/settings/SettingsMenuSelect": elementBoundary,
      "./ScheduledWeekdaySelect": elementBoundary, "./ScheduledExecutionSettings": elementBoundary,
      "../../stores/app-store": { useAppStore: (selector) => selector({ settings: {} }) },
    });
    const tree = runtime.render(() => ScheduledEditor({
      task: task(cadence, schedule), projects: [], currentWorkspacePath: "", busy: false,
      save: async (draft) => { saved = draft; }, cancel() {},
    }));
    tree.props.onSubmit({ preventDefault() {} });
    assert.deepEqual(saved, {
      title: "Check project", prompt: "Check the result", cadence, schedule: expected,
      workspacePath: "/project", permissionMode: "ask", providerId: "custom",
      modelId: "custom-model", thinkingLevel: "omit",
    });
    assert.equal("sessionMode" in saved, false);
    assert.equal("intervalMinutes" in (saved.schedule ?? {}), false);
    const cadenceControl = walk(tree, (node) => node.props?.label === "scheduled.cadence" && node.props.options);
    assert.deepEqual(cadenceControl.props.options.map((option) => option.id), ["manual", "hourly", "daily", "weekly"]);
    runtime.unmount();
  });
}

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

function workspaceFixture(origin = null) {
  const runtime = hooks(); const requests = []; const taskReads = [];
  const calls = [];
  const api = {
    async listProjects() { return { projects: [] }; },
    listScheduled() { const pending = deferred(); taskReads.push(pending); return pending.promise; },
    listScheduledRuns(options) { const pending = deferred(); requests.push({ options, ...pending }); return pending.promise; },
    async executeScheduled(id) { calls.push(["execute", id]); },
    async createScheduled(draft) { calls.push(["create", draft]); },
    async updateScheduled(draft) { calls.push(["update", draft]); },
    async deleteScheduled(id) { calls.push(["delete", id]); },
  };
  const helpers = sourceModule("../src/features/scheduled/scheduled-runs.ts", {});
  const { useScheduledWorkspace } = sourceModule("../src/features/scheduled/use-scheduled-workspace.ts", {
    react: runtime.api, "../../lib/api": { api }, "./scheduled-runs": helpers,
    "./scheduled-return": { peekScheduledReturn: () => origin },
  }, { setInterval: () => 1, clearInterval() {} });
  const render = () => runtime.render(() => useScheduledWorkspace(() => {}));
  return { runtime, render, requests, taskReads, calls };
}

const TASKS = [task("manual", null), { ...task("manual", null), id: "task-b" }];
const run = (id, taskId = "task-a") => ({ id, taskId, sessionId: `session-${id}`, startedAt: "2026-10-02T09:00:00Z", status: "completed" });

test("the workspace scopes history, restores a run, and rejects late older reads", async () => {
  const fixture = workspaceFixture({ taskId: "task-a", runId: "old-picked" });
  const { runtime, requests, taskReads } = fixture;
  let view = fixture.render();
  assert.equal(view.selectedTaskId, "task-a");
  assert.equal(view.selectedRunId, "old-picked");
  assert.deepEqual(requests[0].options, { latestPerTask: true });
  taskReads[0].resolve({ tasks: TASKS }); requests[0].resolve({ runs: [run("new")] });
  for (const request of requests.filter((item) => item.options.taskId)) request.resolve({ runs: [run("old-picked")] });
  view = await runtime.flush();
  assert.equal(view.runs[0].id, "old-picked");
  assert.equal(view.latestRuns.get("task-a").id, "new");
  const first = view.refresh(); const firstHistory = requests.at(-1); const firstTasks = taskReads.at(-1); const firstRail = requests.at(-2);
  const second = view.refresh(); const secondHistory = requests.at(-1); const secondTasks = taskReads.at(-1); const secondRail = requests.at(-2);
  secondHistory.resolve({ runs: [run("newer")] }); secondTasks.resolve({ tasks: TASKS }); secondRail.resolve({ runs: [run("newer")] }); await second;
  firstHistory.resolve({ runs: [run("stale")] }); firstTasks.resolve({ tasks: [] }); firstRail.resolve({ runs: [] }); await first;
  view = await runtime.flush();
  assert.equal(view.runs[0].id, "newer"); assert.equal(view.tasks.length, 2);
  view.selectTask("task-b"); view = runtime.render();
  assert.deepEqual(view.runs, []); assert.equal(view.selectedRunId, null);
  assert.deepEqual(requests.at(-1).options, { taskId: "task-b", limit: 200 });
  requests.at(-1).resolve({ runs: [run("b", "task-b")] });
  view = await runtime.flush(); assert.equal(view.runs[0].id, "b");
  runtime.unmount();
});

test("a failed task-history read retains results and a retry actually rereads history", async () => {
  const fixture = workspaceFixture({ taskId: "task-a", runId: "saved" });
  const { runtime, requests, taskReads } = fixture;
  fixture.render(); taskReads[0].resolve({ tasks: TASKS }); requests[0].resolve({ runs: [run("saved")] });
  for (const request of requests.filter((item) => item.options.taskId)) request.resolve({ runs: [run("saved")] });
  let view = await runtime.flush();
  const failed = view.refresh(); taskReads.at(-1).resolve({ tasks: TASKS }); requests.at(-2).resolve({ runs: [run("saved")] }); requests.at(-1).reject(new Error("history unavailable")); await failed;
  view = await runtime.flush(); assert.equal(view.error, "history unavailable"); assert.equal(view.runs[0].id, "saved");
  const retry = view.refresh(); assert.equal(requests.at(-1).options.taskId, "task-a");
  taskReads.at(-1).resolve({ tasks: TASKS }); requests.at(-2).resolve({ runs: [run("retried")] }); requests.at(-1).resolve({ runs: [run("retried")] }); await retry;
  view = await runtime.flush(); assert.equal(view.error, ""); assert.equal(view.runs[0].id, "retried");
  runtime.unmount();
});

test("the selected run remounts its preview and session navigation is owned by the store", () => {
  const detail = readFileSync(new URL("../src/features/scheduled/ScheduledTaskDetail.tsx", import.meta.url), "utf8");
  assert.match(detail, /<ScheduledRunTranscript key=\{selectedRun\.id\} run=\{selectedRun\} \/>/);
  const page = readFileSync(new URL("../src/pages/ScheduledPage.tsx", import.meta.url), "utf8");
  assert.match(page, /await selectSession\(sessionId\)/);
  assert.doesNotMatch(page, /setPage\("chat"\)/, "a late selection cannot override newer navigation");
  assert.match(page, /key=\{selectedTask\.id\}/);
});

test("the preview bounds reads, follows completion, and rejects stale responses", async () => {
  const runtime = hooks(); const requests = []; const timers = new Map(); let timerId = 0;
  const { ScheduledRunTranscript } = sourceModule("../src/features/scheduled/ScheduledRunTranscript.tsx", {
    react: runtime.api, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: translate }) },
    "../../lib/api": { api: { getSession(id, options) { const pending = deferred(); requests.push({ id, options, ...pending }); return pending.promise; } } },
  }, { setInterval: (callback) => { timers.set(++timerId, callback); return timerId; }, clearInterval: (id) => timers.delete(id) });
  let selected = { ...run("preview"), status: "running", endedAt: null };
  let tree = runtime.render(() => ScheduledRunTranscript({ run: selected }));
  assert.deepEqual(requests[0].options, { messageLimit: 60, contentLimit: 20_000 });
  assert.equal(timers.size, 1);
  requests[0].resolve({ session: { messages: [{ id: "prompt", role: "user", content: "Check" }], hasMoreBefore: true } });
  tree = await runtime.flush();
  assert.ok(walk(tree, (node) => node.props?.className === "scheduled-hint scheduled-transcript-more"));
  [...timers.values()][0](); const late = requests.at(-1);
  selected = { ...selected, status: "completed", endedAt: "2026-10-02T09:01:00Z" };
  runtime.render(); assert.equal(timers.size, 0);
  requests.at(-1).resolve({ session: { messages: [{ id: "answer", role: "assistant", content: "Done" }] } });
  tree = await runtime.flush();
  assert.ok(walk(tree, (node) => node.props?.message?.id === "answer"));
  late.resolve({ session: { messages: [{ id: "stale", role: "assistant", content: "Earlier" }] } });
  tree = await runtime.flush(); assert.equal(walk(tree, (node) => node.props?.message?.id === "stale"), null);
  runtime.unmount(); assert.equal(timers.size, 0);
});

test("the return button reuses Scheduled history or opens its route directly", () => {
  const runtime = hooks(); const calls = [];
  const returns = sourceModule("../src/features/scheduled/scheduled-return.ts", {});
  returns.rememberScheduledReturn({ taskId: "task-a", taskTitle: "Check", runId: "run-a", sessionId: "scheduled" });
  let state = {
    activeSessionId: "scheduled", sessions: [{ id: "scheduled", title: "Check", scheduledRun: true }],
    navStack: [{ page: "scheduled" }, { page: "chat" }], navIndex: 1,
    navBack: () => calls.push("back"), setPage: (page) => calls.push(page),
  };
  const { ConversationTopbar } = sourceModule("../src/components/ConversationTopbar.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: translate }) },
    "@pi-desktop/shared": { KEYBOARD_SHORTCUTS: [], keybindingDisplayParts: () => [], resolveKeybinding: () => null },
    "../stores/app-store": { useAppStore: (select) => select(state) },
    "../features/scheduled/scheduled-return": returns, "./icons": elementBoundary, "./ui": elementBoundary,
  });
  const render = () => runtime.render(() => ConversationTopbar({ sidebarCollapsed: false, workPanelOpen: false }));
  walk(render(), (node) => node.props?.["data-nav"] === "back-to-scheduled").props.onClick();
  state = { ...state, navStack: [{ page: "chat" }, { page: "chat" }] };
  walk(render(), (node) => node.props?.["data-nav"] === "back-to-scheduled").props.onClick();
  assert.deepEqual(calls, ["back", "scheduled"]);
  state = { ...state, sessions: [] };
  assert.ok(walk(render(), (node) => node.props?.["data-nav"] === "back-to-scheduled"), "a new run can return before its summary reaches the session list");
  state = { ...state, activeSessionId: "ordinary", sessions: [{ id: "ordinary", title: "ordinary" }] };
  assert.equal(walk(render(), (node) => node.props?.["data-nav"] === "back-to-scheduled"), null);
  runtime.unmount();
});

test("opening a run reports session-load failures without an unhandled rejection", async () => {
  const runtime = hooks(); const toasts = [];
  const selectedTask = TASKS[0];
  const workspace = {
    tasks: TASKS, projects: [], selectedTask, selectedTaskId: selectedTask.id,
    runs: [run("failed-open")], latestRuns: new Map(), selectedRunId: "failed-open",
    busy: false, loaded: true, error: "", taskIsRunning: () => false,
  };
  const state = {
    providers: [], showToast: (...args) => toasts.push(args),
    selectSession: async () => { throw new Error("session read failed"); },
  };
  const { ScheduledPage } = sourceModule("../src/pages/ScheduledPage.tsx", {
    react: runtime.api, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: translate, i18n: { language: "en" } }) },
    "../stores/app-store": { useAppStore: (select) => select(state) },
    "../components/ui": elementBoundary, "../components/icons": elementBoundary,
    "../features/scheduled/ScheduledEditor": elementBoundary,
    "../features/scheduled/ScheduledTaskDetail": elementBoundary,
    "../features/scheduled/ScheduledTaskRail": elementBoundary,
    "../features/scheduled/use-scheduled-workspace": { useScheduledWorkspace: () => workspace },
    "../features/scheduled/scheduled-return": { rememberScheduledReturn() {} },
  });
  const tree = runtime.render(() => ScheduledPage());
  walk(tree, (node) => node.type === "ScheduledTaskDetail").props.onOpenSession("session-failed-open", "failed-open");
  await runtime.flush();
  assert.deepEqual(toasts, [["session read failed", { variant: "error" }]]);
  runtime.unmount();
});
