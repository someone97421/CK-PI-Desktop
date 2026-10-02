import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const NOW = Date.parse("2026-01-02T12:00:00Z");

const TASK_A = {
  id: "task-a",
  title: "Nightly dependency check",
  prompt: "Summarize the dependency state and the open issues.",
  cadence: "daily",
  mode: "agent",
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:01:12Z",
  lastRunAt: "2026-01-02T00:01:12Z",
  schedule: { hour: 9, minute: 5, weekday: 0 },
  nextRunAt: "2026-01-03T09:05:00Z",
  workspacePath: "/Users/dev/project",
  permissionMode: "auto",
  providerId: "custom",
  modelId: "fixture",
};

const TASK_B = {
  id: "task-b",
  title: "PR sweep",
  prompt: "Review the open pull requests.",
  cadence: "manual",
  mode: "agent",
  enabled: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  schedule: null,
};

const RUN_FAILED = {
  id: "run-failed",
  taskId: "task-a",
  sessionId: "session-failed",
  status: "error",
  errorCode: "PROVIDER_ERROR",
  startedAt: "2026-01-02T00:00:00Z",
  endedAt: "2026-01-02T00:01:12Z",
};

const RUN_COMPLETED = {
  id: "run-completed",
  taskId: "task-a",
  sessionId: "session-completed",
  status: "completed",
  errorCode: null,
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: "2026-01-01T00:00:42Z",
};

async function withVite(work) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

/** Renders one component the way the route does, through the real catalog. */
async function render(server, modulePath, exportName, props, locale = "en") {
  const module = await server.ssrLoadModule(modulePath);
  const Component = module[exportName];
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(Component, props)),
  );
}

test("run helpers scope, order, and measure one task's history", async () => {
  await withVite(async (server) => {
    const runs = await server.ssrLoadModule("/src/features/scheduled/scheduled-runs.ts");
    const sample = [RUN_FAILED, RUN_COMPLETED, { ...RUN_COMPLETED, id: "run-other", taskId: "task-b" }];

    assert.deepEqual(
      runs.runsForTask(sample, "task-a").map((run) => run.id),
      ["run-failed", "run-completed"],
      "newest first, and only this task's runs",
    );
    assert.deepEqual(runs.runsForTask(sample, null), []);
    assert.equal(runs.latestRunByTask(sample).get("task-a").id, "run-failed");
    assert.equal(runs.latestRunForTask(sample, "task-a").id, "run-failed");

    assert.equal(runs.runDurationMs(RUN_FAILED), 72_000);
    assert.equal(
      runs.runDurationMs({ ...RUN_FAILED, endedAt: null, status: "running" }),
      null,
      "a run still in flight has no duration",
    );
    assert.equal(runs.runDurationMs({ ...RUN_FAILED, endedAt: "2026-01-01T00:00:00Z" }), null);

    assert.equal(runs.taskIsRunning(sample, "task-a"), false);
    assert.equal(runs.taskIsRunning([{ ...RUN_FAILED, status: "running" }], "task-a"), true);

    const history = runs.runsForTask(sample, "task-a");
    assert.equal(runs.resolveSelectedRun(history, "run-completed").id, "run-completed");
    assert.equal(
      runs.resolveSelectedRun(history, "run-deleted").id,
      "run-failed",
      "a selection that no longer exists falls back to the newest run",
    );
    assert.equal(runs.resolveSelectedRun([], "run-failed"), null);
    assert.equal(runs.selectedRunSessionId(history, "run-completed"), "session-completed");
  });
});

test("the workspace keeps exactly one task selected across a reload", async () => {
  await withVite(async (server) => {
    const runs = await server.ssrLoadModule("/src/features/scheduled/scheduled-runs.ts");

    assert.equal(
      runs.resolveSelectedTaskId([], "task-b", false),
      "task-b",
      "a task restored from a conversation outlives the first, empty read",
    );
    assert.equal(runs.resolveSelectedTaskId([TASK_A, TASK_B], "task-b", true), "task-b");
    assert.equal(
      runs.resolveSelectedTaskId([TASK_A, TASK_B], "task-deleted", true),
      "task-a",
      "a task that is gone falls back to the first one",
    );
    assert.equal(runs.resolveSelectedTaskId([TASK_A, TASK_B], null, true), "task-a");
    assert.equal(runs.resolveSelectedTaskId([], null, true), null);
    assert.equal(runs.resolveSelectedTaskId([], "task-b", true), null, "an empty list selects nothing");
  });
});

test("run formatting stays compact, localized, and bounded", async () => {
  await withVite(async (server) => {
    const format = await server.ssrLoadModule("/src/features/scheduled/scheduled-format.ts");

    assert.equal(format.formatDuration(0), "1s");
    assert.equal(format.formatDuration(42_400), "42s");
    assert.equal(format.formatDuration(72_000), "1m 12s");
    assert.equal(format.formatDuration(120_000), "2m");
    assert.equal(format.formatDuration(5_400_000), "1h 30m");
    assert.equal(format.formatDuration(7_200_000), "2h");
    assert.equal(format.formatDuration(null), "");
    assert.equal(format.formatDuration(Number.NaN), "");

    assert.match(format.formatRelativeMoment("2026-01-02T11:00:00Z", NOW, "en"), /hour/);
    assert.match(format.formatRelativeMoment("2026-01-04T12:00:00Z", NOW, "en"), /day/);
    const far = format.formatRelativeMoment("2026-02-11T12:00:00Z", NOW, "en");
    assert.doesNotMatch(far, /day|hour|minute/, "beyond a week the phrase becomes a date");
    assert.ok(far.length > 0);
    assert.equal(format.formatRelativeMoment(null, NOW, "en"), "");

    assert.equal(format.formatScheduleClock({ hour: 9, minute: 5, weekday: 0 }), "09:05");
    assert.equal(format.formatScheduleClock({ hour: 23, minute: 59, weekday: 0 }), "23:59");
    assert.equal(format.formatScheduleClock(null), null);
    assert.equal(format.formatScheduleClock({ hour: 24, minute: 0, weekday: 0 }), null);
  });
});

test("the task column reports each task's own last outcome", async () => {
  await withVite(async (server) => {
    const html = await render(server, "/src/features/scheduled/ScheduledTaskRail.tsx", "ScheduledTaskRail", {
      tasks: [TASK_A, TASK_B],
      latestRuns: new Map([["task-a", RUN_FAILED]]),
      selectedTaskId: "task-a",
      now: NOW,
      locale: "en",
      onSelect() {},
    });

    assert.match(html, /Nightly dependency check/);
    assert.match(html, /Daily · 09:05/, "cadence and its clock share one line");
    assert.match(html, /Failed/, "the failing task reports its own outcome");
    assert.match(html, /1m 12s/, "and how long it took");
    assert.match(html, /PR sweep/);
    assert.match(html, /Not run yet/, "a task that never ran says so");
    assert.match(html, /Disabled/, "a paused task is marked");
    assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1, "one selected task");
  });
});

test("the task page reads facts, history, and the selected run in place", async () => {
  await withVite(async (server) => {
    const format = await server.ssrLoadModule("/src/features/scheduled/scheduled-format.ts");
    const props = {
      task: TASK_A,
      runs: [RUN_FAILED, RUN_COMPLETED],
      selectedRunId: RUN_FAILED.id,
      running: false,
      busy: false,
      now: NOW,
      locale: "en",
      onSelectRun() {},
      onOpenSession() {},
      onRunNow() {},
      onEdit() {},
      onToggleEnabled() {},
      onDelete() {},
      providerName: "Fixture provider",
    };
    const html = await render(
      server,
      "/src/features/scheduled/ScheduledTaskDetail.tsx",
      "ScheduledTaskDetail",
      props,
    );

    assert.match(html, /Nightly dependency check/);
    assert.match(html, /Last run[\s\S]*?Failed/, "the facts lead with the last outcome");
    assert.match(html, /1m 12s/);
    assert.match(html, /~/u, "the project path is shortened");
    assert.match(html, /Auto/, "the task's own permission mode is shown");
    assert.match(html, /Fixture provider \/ fixture/, "the model fact names the provider, not its id");
    const unnamedProvider = await render(
      server,
      "/src/features/scheduled/ScheduledTaskDetail.tsx",
      "ScheduledTaskDetail",
      { ...props, providerName: null },
    );
    assert.doesNotMatch(
      unnamedProvider,
      /custom \/ fixture/,
      "an unresolved provider never leaks its UUID into the facts row",
    );
    assert.match(html, /aria-expanded="false"/, "the instruction starts collapsed");
    assert.match(html, /PROVIDER_ERROR/, "a failed run keeps its code in the history");
    assert.match(html, /Run history/);
    assert.match(html, /Run content/);

    const contentCard = html.slice(html.indexOf('id="scheduled-run-content"'));
    assert.ok(
      contentCard.includes(format.formatMoment(RUN_FAILED.startedAt, "en")),
      "the content card follows the selected run",
    );

    const other = await render(
      server,
      "/src/features/scheduled/ScheduledTaskDetail.tsx",
      "ScheduledTaskDetail",
      { ...props, selectedRunId: RUN_COMPLETED.id },
    );
    const otherCard = other.slice(other.indexOf('id="scheduled-run-content"'));
    assert.ok(
      otherCard.includes(format.formatMoment(RUN_COMPLETED.startedAt, "en")),
      "selecting another run moves the card with it",
    );
    assert.equal((other.match(/aria-current="true"/g) ?? []).length, 1);
  });
});

test("a run with no stored transcript says so instead of showing an empty pane", async () => {
  await withVite(async (server) => {
    const html = await render(
      server,
      "/src/features/scheduled/ScheduledRunTranscript.tsx",
      "ScheduledRunTranscript",
      { run: { ...RUN_COMPLETED, sessionId: null } },
    );
    assert.match(html, /This run stored no transcript\./);
  });
});

test("automation ownership keeps run transcripts out of the lists", async () => {
  await withVite(async (server) => {
    const { isAutomationSession } = await server.ssrLoadModule("/src/lib/session-origin.ts");
    assert.equal(isAutomationSession({ scheduledRun: true }), true);
    assert.equal(isAutomationSession({ scheduledRun: false }), false);
    assert.equal(isAutomationSession({}), false, "a host that omits the flag is ordinary");
    assert.equal(isAutomationSession(null), false);
    assert.equal(isAutomationSession(undefined), false);
  });
});

test("the session list and search both consume the ownership rule", async () => {
  const { readFile } = await import("node:fs/promises");
  const sidebar = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /import \{ listableSessions \} from "\.\.\/lib\/session-origin";/);
  assert.match(
    sidebar,
    /listableSessions\(sessions\)/,
    "the sidebar drops automation transcripts before grouping",
  );
  const search = await readFile(new URL("../src/hooks/use-session-search.ts", import.meta.url), "utf8");
  assert.match(
    search,
    /state\.hits\.filter\(\(hit\) => !isAutomationSession\(hit\.session\)\)/,
    "search never offers one as a conversation to open",
  );
  const palette = await readFile(
    new URL("../src/components/SearchDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    palette,
    /listableSessions\(q \? search\.hits\.map/,
    "and its empty-query recents list applies the same rule",
  );
});

test("a run's transcript follows the run, not just its session", async () => {
  // A real run wrote its answer only after the card opened; reading once on the
  // session id alone left the reader with the prompt and no reply.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/features/scheduled/ScheduledRunTranscript.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\}, \[read, run\.status, run\.endedAt\]\);/,
    "a run that finished re-reads its transcript",
  );
  assert.match(source, /run\.status !== "running"/, "an in-flight run keeps following it");
  assert.match(source, /revision\.current\+\+/, "and a late response cannot overwrite a newer read");
});

test("the task form owns the Scheduled page while it is open", async () => {
  const source = await readFile(new URL("../src/pages/ScheduledPage.tsx", import.meta.url), "utf8");
  assert.match(source, /loaded && tasks\.length > 0 && !editor \?/);
  assert.match(source, /className="scheduled-editor-slot"/);
});

test("the task column reads one newest run per task, not a global window", async () => {
  // A global window drops an idle task's rows once other tasks fill it, and the
  // column then reports that task as never run. The host answers per task.
  const source = await readFile(
    new URL("../src/features/scheduled/use-scheduled-workspace.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /api\.listScheduledRuns\(\{ latestPerTask: true \}\)/);
  assert.doesNotMatch(source, /RAIL_RUN_LIMIT/);
  assert.match(
    source,
    /const \[latestPerTaskRuns, setLatestPerTaskRuns\]/,
    "the column's state is named for what it holds",
  );

  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /latestPerTask\?: boolean/);
});

test("desktop session lists drop a run's transcript", async () => {
  await withVite(async (server) => {
    const origin = await server.ssrLoadModule("/src/lib/session-origin.ts");
    const listed = [
      { id: "plain" },
      { id: "automation", scheduledRun: true },
      { id: "legacy" },
      { id: "explicit-false", scheduledRun: false },
    ];
    assert.deepEqual(
      origin.listableSessions(listed).map((session) => session.id),
      ["plain", "legacy", "explicit-false"],
      "only a run's transcript leaves the list",
    );
    assert.deepEqual(origin.listableSessions([]), []);

    // The tray applies the same rule in the main process, where the renderer's
    // helper cannot be imported; its own test exercises that filter.
    const tray = await readFile(
      new URL("../electron/main/tray-sessions.ts", import.meta.url),
      "utf8",
    );
    assert.match(tray, /trayVisibleSessions\(listed\.sessions\)/);
  });
});

test("New Task never reuses an empty scheduled transcript, while full session access stays available", async () => {
  await withVite(async (server) => {
    const { createSessionRuntime } = await server.ssrLoadModule("/src/stores/runtime/session-runtime.ts");
    const runtime = createSessionRuntime({ get: () => ({}), set() {} });
    const ordinary = { id: "ordinary", projectPath: "/project", updatedAt: "2026-10-02T09:00:00Z", messageCount: 0 };
    const automation = { ...ordinary, id: "failed-run", updatedAt: "2026-10-02T10:00:00Z", scheduledRun: true };
    assert.equal(runtime.latestSessionInScope([ordinary, automation], "/project", {}).id, "ordinary");
    assert.equal(runtime.latestSessionInScope([automation], "/project", {}), undefined);
    assert.equal(runtime.latestSessionInScope([{ ...automation, scheduledRun: false }], "/project", {}).id, "failed-run", "deleting the task releases the transcript into ordinary candidates");
    assert.equal(runtime.latestSessionInScope([ordinary], "/other", {}), undefined);
    assert.equal(typeof runtime.loadSessionDetail, "function", "explicit transcript reads stay available");
  });
});
