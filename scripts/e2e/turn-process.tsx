import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { AppSettings, UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ShowThinkingRow } from "../../apps/desktop/src/components/settings/ShowThinkingRow";
import { TranscriptDisplayModeRow } from "../../apps/desktop/src/components/settings/TranscriptDisplayModeRow";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { TranscriptSearchContext } from "../../apps/desktop/src/lib/transcript-search-context";
import type { TranscriptSearchTarget } from "../../apps/desktop/src/lib/transcript-reading";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({
  id,
  role,
  content,
  createdAt: "2026-09-17T00:00:00.000Z",
  ...extra,
});

/** Real mounted React components: disclosure ownership, preferences and search. */
export async function turnProcessProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const container = document.createElement("div");
  // Keep the collapse rail's gutter inside the viewport, like the real
  // .thread-content padding does, so hit testing can address it.
  container.style.cssText =
    "width: 800px; max-width: 100%; padding-left: 32px; box-sizing: border-box;";
  document.body.append(container);
  const initialSettings = useAppStore.getState().settings;
  const settings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
    transcriptDisplayMode: "command-first",
  };
  flushSync(() => useAppStore.setState({ settings }));
  const setSettings = (patch: Partial<AppSettings> = {}) =>
    flushSync(() => useAppStore.setState({ settings: { ...settings, ...patch } }));
  const errors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
  });
  const notes: string[] = [];
  const metrics: Record<string, unknown> = {};
  const check = (value: unknown, name: string) => {
    assert(value, name);
    notes.push(name);
  };
  const render = (
    messages: UiMessage[],
    active = false,
    search: TranscriptSearchTarget | null = null,
    key = "turn",
  ) => {
    const entry = buildTranscriptEntries(messages).entries.find(
      (item) => item.kind === "assistant-turn",
    );
    assert(entry?.kind === "assistant-turn", "missing turn");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptSearchContext.Provider value={search}>
            <AssistantTurn key={key} entry={entry} isActive={active} />
          </TranscriptSearchContext.Provider>
        </I18nextProvider>,
      ),
    );
    assert(!errors.length, `React error: ${errors.map(String).join("; ")}`);
  };
  const header = () =>
    container.querySelector<HTMLButtonElement>(".turn-process > button");
  const process = () => container.querySelector<HTMLElement>(".turn-process-body");
  const processHeaders = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".turn-process > button"));
  const firstProcess = process;
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const visible = (element: Element | null) =>
    Boolean(element?.getBoundingClientRect().height);
  const leftOf = (element: Element | null) =>
    element?.getBoundingClientRect().left;
  const nearLeft = (left: number | undefined, right: number | undefined) =>
    typeof left === "number" && typeof right === "number" &&
    Math.abs(left - right) < 0.75;
  const pointIn = (element: Element | null) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return document.elementFromPoint(
      rect.left + Math.min(6, rect.width / 2),
      rect.top + rect.height / 2,
    );
  };
  const owns = (header: Element | null, target: Element | null) =>
    Boolean(header && target && header.contains(target));
  const railHit = (rail: Element | null) => {
    if (!rail) return null;
    const rect = rail.getBoundingClientRect();
    return document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
  };
  const rectOf = (element: Element | null) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      top: rect.top,
      bottom: rect.bottom,
    };
  };
  const fontSize = (element: Element | null) =>
    element ? Number.parseFloat(getComputedStyle(element).fontSize) : NaN;
  const color = (element: Element | null) =>
    element ? getComputedStyle(element).color : "";
  const click = (element: HTMLElement | null) => {
    assert(element, "missing click target");
    flushSync(() => element.click());
  };
  const intro = message("intro", "assistant", "Inspecting the files", {
    thinking: "reasoning detail",
    status: "complete",
  });
  const read = message("read", "tool", "read output", {
    toolName: "Read",
    toolCallId: "read-call",
    toolStatus: "success",
    toolArgs: { path: "src/example.ts" },
  });
  const progress = message("progress", "assistant", "Found the problem");
  const edit = message("edit", "tool", "edit output", {
    toolName: "Edit",
    toolCallId: "edit-call",
    toolStatus: "success",
    toolArgs: { path: "src/example.ts" },
  });
  const answer = message("answer", "assistant", "The fix is ready.", {
    status: "complete",
    createdAt: "2026-09-17T00:00:03.000Z",
    responseDurationMs: 1000,
  });
  const messages = [intro, read, progress, edit, answer];
  const tool = (id: string, toolName: string, extra: Partial<UiMessage> = {}) =>
    message(id, "tool", "", { toolName, toolStatus: "success", ...extra });
  const run = (id: string, command: string) => tool(id, "Bash", { toolCallId: id, toolArgs: { command } });
  const grep = tool("grep", "Grep", { toolArgs: { pattern: "example" } });
  const bash1 = run("bash1", "pnpm test");
  const bash2 = run("bash2", "pnpm build");
  const mixed = [intro, read, grep, bash1, bash2, edit, answer];
  const contiguous = [read, grep, bash1, bash2, edit, answer];
  try {
    render(messages);
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "one process per ordinary turn",
    );
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "detailed completed process starts collapsed",
    );
    check(
      visible(container.querySelector('[data-message-id="answer"]')),
      "final answer stays visible",
    );
    check(
      !visible(container.querySelector('[data-message-id="progress"]')),
      "completed progress stays hidden until expanded",
    );
    render(messages.slice(0, -1), true, null, "active-process");
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "active detailed process starts open",
    );
    render(messages, false, null, "active-process");
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "untouched detailed process collapses on completion",
    );
    render(messages);
    click(header());
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "user can expand completed progress",
    );
    render(mixed, false, null, "geometry");
    const bash1Row = row("bash1");
    const bash2Row = row("bash2");
    click(header());
    check(
      visible(bash1Row) && visible(bash2Row),
      "opening the process reveals the Bash rows",
    );

    // Real geometry and hit testing: the turn title, a nested group title and a
    // Bash row share one left edge, and the collapse rail owns its gutter.
    const topHeader = processHeaders()[0] ?? null;
    const nestedHeader = container.querySelector<HTMLElement>(
      ".process-activity-group.grouped > .tool-activity-header",
    );
    const bashHeader = bash1Row?.querySelector<HTMLElement>(".tool-row-header") ?? null;
    const bashHead = bash1Row?.querySelector<HTMLElement>(".tool-row-head.is-run") ?? null;
    const topIcon = topHeader?.querySelector(".tool-activity-icon") ?? null;
    const nestedIcon = nestedHeader?.querySelector(".tool-activity-icon") ?? null;
    const bashIcon = bashHeader?.querySelector(".tool-row-icon") ?? null;
    const topLabel = topHeader?.querySelector(".tool-activity-label") ?? null;
    const nestedLabel = nestedHeader?.querySelector(".tool-activity-label") ?? null;
    const bashLabel = bashHeader?.querySelector(".tool-row-name") ?? null;
    check(
      nearLeft(leftOf(topIcon), leftOf(nestedIcon)) &&
        nearLeft(leftOf(nestedIcon), leftOf(bashIcon)),
      "turn, group and run icons share one left edge",
    );
    check(
      nearLeft(leftOf(topLabel), leftOf(nestedLabel)) &&
        nearLeft(leftOf(nestedLabel), leftOf(bashLabel)),
      "turn, group and run titles share one text line",
    );
    check(
      nearLeft(leftOf(topHeader), leftOf(nestedHeader)) &&
        nearLeft(leftOf(nestedHeader), leftOf(bashHead)),
      "turn, group and run header fills share one left edge",
    );
    check(
      owns(topHeader, pointIn(topIcon)) &&
        owns(nestedHeader, pointIn(nestedIcon)) &&
        owns(bashHeader, pointIn(bashIcon)),
      "each disclosure header owns its content hit target",
    );
    check(
      fontSize(topLabel) > fontSize(nestedLabel) &&
        fontSize(nestedLabel) === fontSize(bashLabel),
      "the nested group title is smaller than the turn title and matches run-row type",
    );
    check(
      color(topLabel) !== color(nestedLabel) &&
        color(nestedLabel) !== color(bashLabel),
      "the nested group title uses a quieter colour than the turn and run rows",
    );
    const topRail = firstProcess()?.querySelector<HTMLElement>(
      ":scope > .disclosure-collapse-rail",
    ) ?? null;
    check(
      topRail !== null && railHit(topRail) === topRail,
      "the turn collapse rail owns its gutter hit target",
    );
    click(nestedHeader);
    const nestedBody = nestedHeader?.parentElement?.querySelector<HTMLElement>(
      ":scope > .process-activity-body",
    ) ?? null;
    const nestedRail = nestedBody?.querySelector<HTMLElement>(
      ":scope > .disclosure-collapse-rail",
    ) ?? null;
    check(
      nestedRail !== null && railHit(nestedRail) === nestedRail,
      "the nested group collapse rail owns its gutter hit target",
    );
    metrics.desktop = {
      icons: [leftOf(topIcon), leftOf(nestedIcon), leftOf(bashIcon)],
      labels: [leftOf(topLabel), leftOf(nestedLabel), leftOf(bashLabel)],
      headers: [leftOf(topHeader), leftOf(nestedHeader), leftOf(bashHead)],
      turnRail: rectOf(topRail),
      groupRail: rectOf(nestedRail),
    };
    container.style.width = "420px";
    check(
      nearLeft(leftOf(topIcon), leftOf(nestedIcon)) &&
        nearLeft(leftOf(nestedIcon), leftOf(bashIcon)),
      "the shared left edge survives a narrow transcript",
    );
    check(
      topRail !== null && railHit(topRail) === topRail &&
        nestedRail !== null && railHit(nestedRail) === nestedRail,
      "both collapse rails stay usable in a narrow transcript",
    );
    metrics.narrow = {
      icons: [leftOf(topIcon), leftOf(nestedIcon), leftOf(bashIcon)],
      turnRail: rectOf(topRail),
      groupRail: rectOf(nestedRail),
    };
    container.style.width = "800px";
    render(messages, false, null, "last-tool");
    click(header());

    check(
      container.querySelector('[data-message-id="edit"]')?.classList.contains("open") === true,
      "detailed opens the last tool",
    );
    check(
      container.querySelector('[data-message-id="read"]')?.classList.contains("open") !== true,
      "detailed keeps earlier tools collapsed",
    );
    check(
      container.querySelectorAll(".tool-row").length === 3,
      "detailed shows thinking and both tools in place",
    );
    render(
      [intro, { ...read, toolStatus: "error", isError: true }, answer],
      false,
      null,
      "failed-last-tool",
    );
    check(
      container.querySelector('[data-message-id="read"]')?.classList.contains("open") !== true,
      "detailed keeps a last failed tool collapsed",
    );

    const streaming = message("stream", "assistant", "Live text", {
      status: "streaming",
    });
    render([streaming], true, null, "stream");
    check(
      !header() && visible(container.querySelector('[data-message-id="stream"]')),
      "streamed answer is never delayed behind disclosure",
    );
    render([streaming, read], true, null, "stream");
    check(
      header()?.getAttribute("aria-expanded") === "true" &&
        visible(container.querySelector('[data-message-id="stream"]')),
      "detailed keeps streamed text visible after later tools",
    );
    render([intro, read, { ...answer, status: "aborted" }], false, null, "aborted");
    check(
      visible(container.querySelector('[data-message-id="answer"]')),
      "stopped partial answer remains visible",
    );
    render(
      [
        intro,
        read,
        message("failure", "assistant", "", {
          error: { code: "INTERNAL", message: "Connection failed", retryable: true },
        }),
      ],
      false,
      null,
      "error",
    );
    check(
      visible(container.querySelector('[data-message-id="failure"]')),
      "failure remains visible",
    );

    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, showThinking: false },
      }),
    );
    render(messages, false, null, "compact-group");
    check(
      container.querySelectorAll(".turn-process").length === 1,
      "one process per turn",
    );
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "compact completed process starts collapsed",
    );
    check(
      container.querySelector('[data-message-id="edit"]')?.classList.contains("open") !== true,
      "compact keeps tool payloads collapsed",
    );
    check(
      header()?.textContent?.includes("2 tools"),
      "process counts tools and progress once",
    );
    click(header());
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "expanding reveals intermediate progress",
    );
    check(
      process()?.querySelectorAll(".tool-row").length === 2,
      "compact expanding retains both tools without thinking",
    );
    render(messages, true, null, "compact-group");
    render(messages, false, null, "compact-group");
    check(
      header()?.getAttribute("aria-expanded") === "true",
      "manual disclosure survives active-to-complete transition",
    );

    render([intro, read], true, null, "live");
    check(
      header()?.getAttribute("aria-expanded") === "true",
      "live process stays open independently of thinking visibility",
    );
    render(
      messages,
      false,
      { sessionId: "s", messageId: "progress", query: "problem", requestId: 1 },
      "search",
    );
    check(
      visible(container.querySelector('[data-message-id="progress"]')),
      "search reveals folded progress",
    );

    const liveThought = message("live-thought", "assistant", "", {
      thinking: "Reasoning before the answer",
      status: "streaming",
    });
    const processLabel = () =>
      container.querySelector(".tool-activity-label")?.textContent;
    render([liveThought], true, null, "thinking-transition");
    check(
      processLabel() === i18n.t("chat.thinking"),
      "active reasoning uses the thinking label",
    );
    render(
      [{ ...liveThought, content: "Answer has started" }],
      true,
      null,
      "thinking-transition",
    );
    check(
      !header() &&
        visible(container.querySelector('[data-message-id="live-thought"]')),
      "answer streaming ends the thinking label even when reasoning is retained",
    );
    render(
      [
        liveThought,
        message("separate-answer", "assistant", "Answer text", {
          status: "streaming",
        }),
      ],
      true,
      null,
      "thinking-transition",
    );
    check(
      !header(),
      "a later answer takes precedence over an earlier streaming thought",
    );

    render([streaming, read], true, null, "stream-compact");
    check(
      process()?.querySelector('[data-message-id="stream"]'),
      "later tool moves provisional text into process",
    );

    render(
      [intro, { ...read, toolStatus: "error", isError: true }, answer],
      true,
      null,
      "tool-error",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "an active tool failure opens an unclaimed process",
    );

    const task = {
      id: "settled-task", status: "completed" as const,
      startedAt: intro.createdAt, endedAt: answer.createdAt,
      usageIncomplete: true, finalMessageId: answer.id,
    };
    const taskMessages = messages.map((item) => ({ ...item, taskId: task.id, task }));
    render(taskMessages, false, null, task.id);
    const drawer = () => container.querySelector<HTMLDetailsElement>(".task-process-drawer");
    check(drawer() && !drawer()?.open, "settled task starts collapsed");
    const taskSearch = { sessionId: "s", messageId: "progress", query: "problem", requestId: 2 };
    render(taskMessages, false, taskSearch, task.id);
    check(drawer()?.open && visible(container.querySelector('[data-message-id="progress"]')),
      "search reveals progress inside the settled task drawer");
    click(container.querySelector(".task-process-summary"));
    render(taskMessages, false, taskSearch, task.id);
    check(!drawer()?.open, "a render preserves manual collapse after search");
    render(taskMessages, false, { ...taskSearch, requestId: 3 }, task.id);
    check(drawer()?.open, "a new search reveals the task drawer again");

    // Command folding is read at render time: toggling it on the mounted turn
    // must regroup the rows without remounting the transcript.
    setSettings();
    render(contiguous, false, null, "command-folding-toggle");
    click(processHeaders()[0] ?? null);
    check(
      visible(row("bash1")) &&
        container.querySelectorAll(".turn-run-row").length === 2,
      "the mounted turn starts with standalone command rows",
    );
    setSettings({ transcriptDisplayMode: "fully-folded" });
    check(
      container.querySelectorAll(".turn-process").length === 1 &&
        container.querySelectorAll(".turn-run-row").length === 0,
      "toggling command folding keeps one process and removes standalone rows",
    );
    const foldedBash1 = row("bash1");
    const foldedBash2 = row("bash2");
    const foldedGroup = foldedBash1?.closest(".process-activity-group.grouped");
    check(
      foldedGroup !== null &&
        foldedGroup === foldedBash2?.closest(".process-activity-group.grouped"),
      "folded commands share one grouped activity ancestor",
    );
    check(
      foldedGroup?.contains(row("read") ?? null) === true &&
        foldedGroup?.contains(row("edit") ?? null) === true,
      "the shared group contains the surrounding tools",
    );
    check(
      foldedGroup?.querySelector(".tool-activity-header") !== null,
      "the shared group keeps its group header",
    );
    check(
      processHeaders()[0]?.querySelector(".tool-activity-count")?.textContent ===
        i18n.t("chat.processTools", { count: 5 }),
      "folding commands does not change the header tool count",
    );
    setSettings();
    check(
      container.querySelectorAll(".turn-run-row").length === 2 &&
        row("bash1")?.closest(".process-activity-group") === null,
      "toggling command folding back restores standalone rows without a remount",
    );

    // Flat keeps the outer process but suppresses nested activity groups and
    // standalone run wrappers.
    setSettings({ transcriptDisplayMode: "flat" });
    render(contiguous, false, null, "flat-mode");
    check(
      container.querySelector(".turn-process") !== null &&
        container.querySelectorAll(".process-activity-group").length === 0 &&
        container.querySelectorAll(".turn-run-row").length === 0,
      "flat mode renders one outer process with no nested activity groups",
    );
    setSettings();

    // The active tail may be wrapped in a merged off-mode part; the merged group
    // must still receive the live disclosure defaults.
    setSettings({ transcriptDisplayMode: "fully-folded" });
    render(
      [read, grep, run("live-folded-bash", "pnpm test")],
      true,
      null,
      "live-folded",
    );
    check(
      visible(row("live-folded-bash")) &&
        container.querySelector(".process-activity-group.grouped.open") !== null,
      "the merged group keeps its live disclosure default",
    );
    setSettings();

    // The header reports the turn's outcome, never the item it is working on.
    render(mixed, false, null, "completed-header");
    const completedLabel = i18n.t("chat.processCompleted");
    const completedText = processHeaders()[0]
      ?.querySelector(".tool-activity-label")
      ?.textContent ?? "";
    check(
      completedText.startsWith(completedLabel) &&
        !completedText.includes("pnpm test") &&
        !completedText.includes("pnpm build"),
      "a settled turn header reports completion without echoing a command",
    );
    render([intro, read, grep], true, null, "live-header");
    check(
      processHeaders()[0]
        ?.querySelector(".tool-activity-label")
        ?.textContent === i18n.t("chat.processRunning"),
      "a live turn header reports running",
    );

    // The store settles a Stop on the tool row itself: an aborted assistant row
    // is not written. The header must read the aborted activity row rather than
    // falling back to the tool's running/error state.
    const stoppedBash = [
      message("stopped-user", "user", "Run"),
      tool("stopped-bash", "Bash", {
        toolArgs: { command: "pnpm test" },
        status: "aborted",
        toolStatus: "error",
      }),
    ];
    render(stoppedBash, false, null, "stopped-bash");
    check(
      processHeaders()[0]
        ?.querySelector(".tool-activity-label")
        ?.textContent === i18n.t("chat.processStopped"),
      "an aborted running Bash row reports the turn stopped",
    );

    // The Settings row is a three-way transcript display mode control.
    let modeSaved: Partial<AppSettings> | undefined;
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptDisplayModeRow
            settings={{ ...settings }}
            saveSettings={async (patch) => {
              modeSaved = patch;
            }}
          />
        </I18nextProvider>,
      ),
    );
    const modeButtons = Array.from(
      container.querySelectorAll<HTMLElement>('[role="radiogroup"] button'),
    );
    check(
      modeButtons.length === 3 &&
        modeButtons[1]?.getAttribute("aria-checked") === "true",
      "the transcript-display row exposes flat, command-first and fully-folded with command-first selected",
    );
    click(modeButtons[2] ?? null);
    check(
      modeSaved?.transcriptDisplayMode === "fully-folded",
      "the transcript-display row saves the selected mode",
    );


    // The Settings row is a boolean Show thinking toggle.
    let saved: Partial<AppSettings> | undefined;
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ShowThinkingRow
            settings={settings}
            saveSettings={async (patch) => {
              saved = patch;
              useAppStore.setState({ settings: { ...settings, ...patch } });
            }}
          />
        </I18nextProvider>,
      ),
    );
    click(container.querySelector<HTMLElement>('[role="switch"]'));
    check(
      saved?.showThinking === false,
      "settings control hides thinking independently of process folding",
    );

    render(
      [intro, { ...read, toolStatus: "error", isError: true }],
      true,
      null,
      "compact-error",
    );
    check(
      header()?.getAttribute("aria-expanded") === "true" && visible(process()),
      "compact mode reveals an active tool failure",
    );

    const thought = message("thought", "assistant", "", {
      thinking: "hidden thinking words",
      status: "streaming",
    });
    render([thought], true, null, "compact");
    check(
      Boolean(header()) && !container.textContent?.includes("hidden thinking words"),
      "compact live thinking has status without reasoning text",
    );
    check(
      visible(container.querySelector(".thinking-compact")),
      "compact live thinking remains indicator-only when expanded",
    );
    render([{ ...thought, status: "complete" }], false, null, "compact");
    check(
      !header() && !container.querySelector(".thinking"),
      "completed compact thinking leaves no empty process or thought block",
    );
    render([{ ...thought, content: "Started answer" }], true, null, "compact");
    check(
      !container.querySelector(".thinking") &&
        visible(container.querySelector('[data-message-id="thought"]')),
      "compact thinking ends as soon as answer text starts",
    );
    render(messages, false, null, "compact-tools");
    check(
      header()?.getAttribute("aria-expanded") === "false" && !visible(process()),
      "compact completed process starts collapsed",
    );
    click(header());
    check(
      !container.querySelector(".thinking") &&
        process()?.querySelectorAll(".tool-row").length === 2,
      "compact keeps tools and progress accessible",
    );
    flushSync(() =>
      useAppStore.setState({
        settings: { ...settings, showThinking: true },
      }),
    );
    check(
      Boolean(container.querySelector(".thinking")),
      "mode changes update mounted history",
    );
    check(
      messages[0].thinking === "reasoning detail",
      "presentation never deletes reasoning data",
    );
    return { ok: true, checks: notes, metrics };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState({ settings: initialSettings });
    container.remove();
  }
}
