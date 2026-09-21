(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const parser = window.ObserverParser;
  const app = document.getElementById("app");
  const clientId = `observer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const state = {
    sessionId: "",
    messages: [],
    tasks: [],
    selectedKey: "",
    location: {},
    loadGeneration: 0,
    loading: false,
    error: "",
    notice: "",
    observedRevision: 0,
    appliedRevision: 0,
    observedTerminalRevision: 0,
    lastRefreshAt: 0,
    refreshTimer: null,
    pollTimer: null,
    tickTimer: null,
    recall: new Map(),
    actionPending: new Set(),
    locale: "en",
    disposed: false,
    locatedRequest: "",
    liveSnapshot: null,
    refreshDirty: false,
    refreshFull: false,
    taskUi: new Map(),
    sidebarScrollTop: 0,
    bridgeUnavailable: false,
    bound: false,
  };

  const COPY = {
    en: {
      title: "Subagents", task: "Task", process: "Process", empty: "No subagent tasks in this session.",
      noSession: "Open a conversation to observe its subagents.", loading: "Loading subagent history...", retry: "Retry",
      refresh: "Refresh", stop: "Stop", revoke: "Revoke snapshot", stopping: "Stopping...", revoking: "Revoking...",
      unnamed: "Unnamed subagent", execution: "Execution", model: "Model", thinking: "Thinking", duration: "Duration",
      tokens: "Tokens", calls: "Tool calls", reports: "Reports", progress: "Progress", latestReport: "Latest report",
      snapshot: "Snapshot", disk: "Disk", memory: "Memory", none: "Unavailable", status: "Status",
      input: "Input", output: "Output", response: "Response", reasoning: "Reasoning", error: "Error",
      running: "Running", completed: "Completed", timed_out: "Timed out", aborted: "Aborted", failed: "Failed",
      stopped: "Stopped", denied: "Denied", locating: "The requested message was not found in this task history.",
      taskEmpty: "No task description was recorded.", processEmpty: "No process messages were recorded.",
      reportStep: "steps", follow: "Following live output", historical: "Historical run", loadError: "Could not load subagent history.",
      noBridge: "Open this built-in view inside the desktop app to observe subagents.", off: "Off", omit: "Omit",
      progressSteps: "Steps", sinceReport: "Since report", interval: "Interval", segment: "Segment", phase: "Phase", source: "Source",
    },
    zh: {
      title: "子代理", task: "任务", process: "完整过程", empty: "当前会话暂无子代理任务。",
      noSession: "打开一个会话后可观测其子代理。", loading: "正在加载子代理历史...", retry: "重试",
      refresh: "刷新", stop: "停止", revoke: "撤销召回", stopping: "正在停止...", revoking: "正在撤销...",
      unnamed: "未命名子代理", execution: "执行", model: "模型", thinking: "思考", duration: "耗时",
      tokens: "Token", calls: "工具调用", reports: "汇报", progress: "进度", latestReport: "最新汇报",
      snapshot: "磁盘快照", disk: "磁盘", memory: "内存", none: "不可用", status: "状态",
      input: "输入", output: "输出", response: "回答", reasoning: "思考过程", error: "错误",
      running: "运行中", completed: "已完成", timed_out: "超时", aborted: "已中止", failed: "失败",
      stopped: "已停止", denied: "已拒绝", locating: "未在该任务历史中找到请求定位的消息。",
      taskEmpty: "未记录任务描述。", processEmpty: "未记录过程消息。", reportStep: "步",
      follow: "正在跟随实时输出", historical: "历史执行", loadError: "无法加载子代理历史。",
      noBridge: "请在桌面应用内打开此内置视图以观测子代理。", off: "关闭", omit: "省略",
      progressSteps: "步骤", sinceReport: "距上次汇报", interval: "汇报间隔", segment: "分段", phase: "阶段", source: "来源",
    },
  };

  function t(key) {
    const lang = state.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    return COPY[lang][key] || COPY.en[key] || key;
  }

  function invoke(channel, payload) {
    if (!bridge?.invoke) return Promise.reject(new Error("Plugin bridge unavailable"));
    return bridge.invoke(channel, payload || {});
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(className, label, title, action) {
    const node = element("button", className, label);
    node.type = "button";
    node.title = title;
    node.setAttribute("aria-label", title);
    node.addEventListener("click", action);
    return node;
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const seconds = Math.floor(ms / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [h ? `${h}h` : "", m ? `${m}m` : "", s || (!h && !m) ? `${s}s` : ""].filter(Boolean).join(" ");
  }

  function durationOf(task) {
    const start = task.timing?.startedAt;
    if (!Number.isFinite(start)) return Number(task.message.toolDurationMs) || 0;
    let end = task.timing.completedAt;
    if (!Number.isFinite(end) && isTaskLive(task)) end = Date.now();
    if (!Number.isFinite(end)) {
      const times = [task.message, ...task.children].map((item) => new Date(item.createdAt).getTime()).filter(Number.isFinite);
      end = times.length ? Math.max(start, ...times) : start;
    }
    return Math.max(0, end - start);
  }

  function formatValue(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  function compact(value, limit = 150) {
    const line = formatValue(value).replace(/\s+/g, " ").trim();
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }

  function toolSummary(message) {
    const args = message.toolArgs && typeof message.toolArgs === "object" ? message.toolArgs : {};
    for (const key of ["path", "file_path", "command", "query", "pattern", "url", "description", "task", "instruction"]) {
      if (typeof args[key] === "string" && args[key].trim()) return compact(args[key]);
    }
    return compact(message.content || message.thinking || args);
  }

  function parseLocation(path) {
    let source = String(path || "");
    if (!source) {
      const outer = new URLSearchParams(window.location.search);
      source = outer.get("piViewOpen") || window.location.search;
    }
    const queryIndex = source.indexOf("?");
    const params = new URLSearchParams(queryIndex >= 0 ? source.slice(queryIndex + 1) : source.replace(/^\?/, ""));
    return {
      sessionId: params.get("sessionId") || "",
      task: params.get("task") || "",
      message: params.get("message") || "",
      query: params.get("query") || "",
      request: params.get("request") || "",
      open: params.get("open") || "",
    };
  }

  function applyAppearance(data) {
    const appearance = data?.appearance || data;
    const base = appearance?.base;
    document.documentElement.dataset.base = base === "light" ? "light" : "dark";
    const locale = data?.locale || appearance?.locale;
    if (locale) {
      state.locale = locale;
      document.documentElement.lang = state.locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
    }
    const css = appearance?.pluginThemeCss;
    let style = document.getElementById("host-theme");
    if (css && typeof css === "string") {
      if (!style) { style = document.createElement("style"); style.id = "host-theme"; document.head.appendChild(style); }
      style.textContent = css;
    } else {
      style?.remove();
    }
  }

  function renderState(message, error) {
    app.replaceChildren();
    const box = element("div", error ? "empty-state error-box" : "empty-state");
    box.append(element("span", error ? "" : "spinner"), element("div", "", message));
    if (error) box.append(button("command-button", t("retry"), t("retry"), () => startSession(state.sessionId, true)));
    app.append(box);
  }

  function captureDetailScroll() {
    const scroll = document.querySelector(".detail-scroll");
    if (!scroll) return null;
    const rows = [...scroll.querySelectorAll("[data-message-id]")];
    const top = scroll.getBoundingClientRect().top;
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top + 54);
    return {
      follow: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 54,
      id: anchor?.dataset.messageId || "",
      offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      top: scroll.scrollTop,
    };
  }

  function captureUi() {
    const selected = state.selectedKey;
    const sidebar = document.querySelector(".task-list");
    if (sidebar) state.sidebarScrollTop = sidebar.scrollTop;
    if (!selected) return "";
    const previous = state.taskUi.get(selected) || {};
    const open = [...document.querySelectorAll("details[open][data-detail-key]")].map((node) => node.dataset.detailKey);
    state.taskUi.set(selected, { ...previous, scroll: captureDetailScroll(), open });
    const focused = document.activeElement?.closest?.("[data-focus-key]");
    return focused?.dataset.focusKey || "";
  }

  function restoreUi(focusKey) {
    const sidebar = document.querySelector(".task-list");
    if (sidebar) sidebar.scrollTop = state.sidebarScrollTop;
    const saved = state.taskUi.get(state.selectedKey);
    if (saved) {
      for (const detail of document.querySelectorAll("details[data-detail-key]")) {
        detail.open = saved.open?.includes(detail.dataset.detailKey) || detail.closest(".is-target") !== null;
      }
      const scroll = document.querySelector(".detail-scroll");
      if (scroll && saved.scroll) {
        const anchor = saved.scroll.id ? scroll.querySelector(`[data-message-id="${CSS.escape(saved.scroll.id)}"]`) : null;
        if (saved.scroll.follow) scroll.scrollTop = scroll.scrollHeight;
        else if (anchor) scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.scroll.offset;
        else scroll.scrollTop = saved.scroll.top;
      }
    }
    if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  function taskByKey(key) {
    return state.tasks.find((task) => task.key === key) || state.tasks.find((task) => task.aliases?.includes(key)) || null;
  }

  function snapshotSession() {
    return state.liveSnapshot?.session || state.liveSnapshot || null;
  }

  function isTaskLive(task) {
    const snapshot = state.liveSnapshot;
    const activeTurn = snapshot?.activeTurn;
    if (!snapshot || !activeTurn || task.outcome !== "running") return false;
    if (snapshot.sessionId && snapshot.sessionId !== state.sessionId) return false;
    const session = snapshotSession();
    if (session?.id && session.id !== state.sessionId) return false;
    const taskSession = task.payload?.sessionId;
    if (taskSession && taskSession !== state.sessionId) return false;
    const activeTurnId = activeTurn.id || activeTurn.turnId;
    const taskTurnId = task.payload?.turnId;
    return !taskTurnId || !activeTurnId || taskTurnId === activeTurnId;
  }

  function statusLabel(outcome) {
    return t(outcome) || outcome;
  }

  const ENUM_COPY = {
    en: {
      running: "Running", guiding: "Guiding", stopping: "Stopping", finished: "Finished",
      definition: "Definition", dispatch: "Dispatch", user: "User", parent: "Parent", session: "Session",
      accepted: "Accepted", applying: "Applying", applied: "Applied", cancelled: "Cancelled", rejected: "Rejected",
      success: "Succeeded", error: "Failed", interval: "Interval", guide: "Guide", memory: "Memory", disk: "Disk",
      "memory-only": "Memory only", saving: "Saving", "durable-ready": "Ready on disk", "pending-validation": "Pending validation",
      blocked: "Blocked", revoked: "Revoked", interrupted: "Interrupted", unavailable: "Unavailable",
      "persistence-error": "Persistence error", cleaned: "Cleaned",
    },
    zh: {
      running: "运行中", guiding: "正在指导", stopping: "正在停止", finished: "已结束",
      definition: "代理定义", dispatch: "任务下发", user: "用户", parent: "父代理", session: "会话",
      accepted: "已受理", applying: "正在应用", applied: "已应用", cancelled: "已取消", rejected: "已拒绝",
      success: "成功", error: "失败", interval: "定期汇报", guide: "指导触发", memory: "内存", disk: "磁盘",
      "memory-only": "仅内存", saving: "正在保存", "durable-ready": "磁盘就绪", "pending-validation": "待校验",
      blocked: "已阻止", revoked: "已撤销", interrupted: "已中断", unavailable: "不可用",
      "persistence-error": "持久化失败", cleaned: "已清理",
    },
  };

  function enumLabel(value) {
    if (!value) return "";
    const lang = state.locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    return ENUM_COPY[lang][value] || statusLabel(value);
  }

  function displayOutcome(task) {
    return task.outcome === "running" && !isTaskLive(task) ? t("historical") : statusLabel(task.outcome);
  }

  function renderSidebar(shell, selected) {
    const sidebar = element("aside", "sidebar");
    const head = element("header", "sidebar-head");
    const title = element("div", "sidebar-title");
    title.append(element("strong", "", t("title")), element("span", "", `${state.tasks.length}`));
    const refresh = button("icon-button", "↻", t("refresh"), () => refreshNewest(true));
    refresh.dataset.focusKey = "refresh";
    if (state.loading) refresh.classList.add("is-spinning");
    head.append(title, refresh);
    const list = element("ul", "task-list");
    list.setAttribute("aria-label", t("title"));
    for (const task of state.tasks) {
      const item = element("li");
      const control = element("button", "task-button");
      control.type = "button";
      control.dataset.key = task.key;
      control.dataset.focusKey = `task:${task.key}`;
      control.setAttribute("aria-current", String(task.key === selected?.key));
      control.title = `${task.name || t("unnamed")} · ${displayOutcome(task)}`;
      const dot = element("span", `status-dot ${task.outcome === "running" && !isTaskLive(task) ? "stopped" : task.outcome}`);
      dot.setAttribute("aria-hidden", "true");
      const copy = element("span", "task-copy");
      copy.append(element("span", "task-name", task.name || t("unnamed")));
      const meta = element("span", "task-meta");
      meta.append(element("span", "", `${t("execution")} ${task.execution}`), element("span", "", displayOutcome(task)));
      copy.append(meta);
      control.append(dot, copy);
      control.addEventListener("click", () => selectTask(task.key, true));
      item.append(control);
      list.append(item);
    }
    sidebar.append(head, list);
    shell.append(sidebar);
  }

  function metric(label, value, id) {
    const node = element("span", "metric");
    if (id) node.id = id;
    node.append(element("strong", "", label), document.createTextNode(String(value)));
    return node;
  }

  function normalizeRecall(value) {
    if (value?.data && typeof value.data === "object") return value.data;
    if (value?.recall && typeof value.recall === "object") return value.recall;
    return value && typeof value === "object" ? value : null;
  }

  function canRevoke(task, recall) {
    if (task.outcome === "running" || !recall || recall.source !== "disk") return false;
    if (recall.execution !== undefined && recall.execution !== task.execution) return false;
    return recall.persistenceState !== "revoked" && recall.status !== "aborted" && recall.status !== "stopped" &&
      (recall.status === "completed" || recall.persistenceState === "durable-ready" || recall.canResume === true);
  }

  function renderActions(hero, task) {
    const actions = element("div", "hero-actions");
    const pending = state.actionPending.has(task.key);
    const recall = state.recall.get(task.key);
    if (isTaskLive(task)) {
      const stop = button("command-button danger", pending ? "■ …" : `■ ${t("stop")}`, pending ? t("stopping") : t("stop"), () => controlTask(task, false));
      stop.dataset.focusKey = `stop:${task.key}`;
      stop.disabled = pending;
      actions.append(stop);
    } else if (canRevoke(task, recall)) {
      const revoke = button("command-button danger", pending ? "■ …" : `■ ${t("revoke")}`, pending ? t("revoking") : t("revoke"), () => controlTask(task, true));
      revoke.dataset.focusKey = `revoke:${task.key}`;
      revoke.disabled = pending;
      actions.append(revoke);
    }
    hero.append(actions);
  }

  function renderSupervision(container, task) {
    const data = task.collaboration;
    const recall = state.recall.get(task.key);
    if (!data && !recall && !task.usage) return;
    const section = element("section", "section");
    section.append(element("div", "section-label", t("progress")));
    const metrics = element("div", "metrics");
    if (data) {
      metrics.append(metric(t("calls"), data.completedSteps ?? "—"));
      metrics.append(metric(t("sinceReport"), `${data.stepsSinceReport ?? 0}/${data.reportIntervalSteps ?? 0}`));
      if (data.latestReport?.reportSeq !== undefined) metrics.append(metric(t("reports"), data.latestReport.reportSeq));
      if (data.segmentId !== undefined) metrics.append(metric(t("segment"), `${data.segmentId} · ${data.segmentCompletedSteps ?? 0}`));
      if (data.phase) metrics.append(metric(t("phase"), enumLabel(data.phase)));
      if (data.intervalSource) metrics.append(metric(t("source"), enumLabel(data.intervalSource)));
      if (data.stopSource) metrics.append(metric(t("status"), enumLabel(data.stopSource)));
    }
    if (task.usage) metrics.append(metric(t("tokens"), task.usage.total.toLocaleString()));
    if (recall) {
      const snapshot = [enumLabel(recall.persistenceState) || t("none"), enumLabel(recall.source), recall.snapshotVersion !== undefined ? `v${recall.snapshotVersion}` : ""].filter(Boolean).join(" · ");
      metrics.append(metric(t("snapshot"), snapshot));
    }
    section.append(metrics);
    if (recall?.reason) section.append(element("div", "report-meta", recall.reason));
    if (data?.latestGuide) section.append(element("div", "report-meta", `${enumLabel(data.latestGuide.status)} · ${data.latestGuide.instruction || ""}`));
    const report = data?.latestReport;
    if (report) {
      const box = element("div", "report");
      box.append(element("div", "section-label", t("latestReport")));
      box.append(element("div", "report-meta", `#${report.reportSeq} · ${report.fromStep}–${report.toStep} ${t("reportStep")} · ${enumLabel(report.reason)} · ${new Date(report.capturedAt).toLocaleString()}`));
      box.append(element("p", "", report.summary || ""));
      if (report.statement) box.append(element("p", "", report.statement));
      if (Array.isArray(report.steps) && report.steps.length) {
        const steps = element("details", "report-steps");
        steps.dataset.detailKey = `report:${task.key}:${report.reportSeq}`;
        steps.append(element("summary", "", `${report.steps.length} ${t("reportStep")}`));
        for (const step of report.steps) {
          const item = element("div", "report-step");
          item.append(element("strong", "", `#${step.seq} ${step.toolName || "Tool"}`));
          item.append(element("span", "", enumLabel(step.status)));
          if (step.args) item.append(element("pre", "", step.args));
          if (step.result) item.append(element("pre", "", step.result));
          steps.append(item);
        }
        box.append(steps);
      }
      section.append(box);
    }
    container.append(section);
  }

  function addBlock(body, label, value) {
    const text = formatValue(value);
    if (!text) return;
    const block = element("div", "block");
    block.append(element("div", "block-label", label));
    const pre = element("pre", "", text);
    block.append(pre);
    body.append(block);
  }

  function renderMessage(message, targetId) {
    const row = element("article", "message-row");
    row.dataset.messageId = message.id;
    if (message.id === targetId || message.toolCallId === targetId) row.classList.add("is-target");
    const details = element("details");
    details.dataset.detailKey = `message:${message.id}`;
    details.open = row.classList.contains("is-target") || message.toolStatus === "running";
    const summary = element("summary");
    summary.dataset.focusKey = `message:${message.id}`;
    const kind = message.toolName || (message.thinking ? t("reasoning") : t("response"));
    let summaryText = toolSummary(message);
    if (!summaryText && message.role === "assistant") summaryText = compact(message.content || message.thinking);
    summary.append(element("span", "row-kind", kind), element("span", "row-summary", summaryText), element("time", "row-time", formatTime(message.createdAt)));
    const body = element("div", "row-body");
    if (message.thinking) addBlock(body, t("reasoning"), message.thinking);
    if (message.content) addBlock(body, t("response"), message.content);
    if (message.toolArgs !== undefined) addBlock(body, t("input"), message.toolArgs);
    if (message.toolResult !== undefined) addBlock(body, message.isError || message.toolStatus === "error" ? t("error") : t("output"), message.toolResult);
    if (message.error) addBlock(body, t("error"), message.error);
    details.append(summary, body);
    row.append(details);
    return row;
  }

  function renderDetail(shell, task) {
    const panel = element("section", "detail");
    if (!task) {
      panel.append(element("div", "empty-state", t("empty")));
      shell.append(panel);
      return;
    }
    const scroll = element("div", "detail-scroll");
    const inner = element("div", "detail-inner");
    const hero = element("header", "hero");
    const copy = element("div", "hero-copy");
    copy.append(element("h1", "", task.name || t("unnamed")));
    const sub = element("div", "hero-sub");
    sub.append(element("span", `badge ${task.outcome === "running" && !isTaskLive(task) ? "stopped" : task.outcome}`, displayOutcome(task)));
    if (task.modelId) sub.append(element("span", "", task.modelId));
    if (task.thinkingLevel) sub.append(element("span", "", `${t("thinking")}: ${t(task.thinkingLevel)}`));
    sub.append(element("span", "", `${t("execution")} ${task.execution}`));
    copy.append(sub);
    hero.append(copy);
    renderActions(hero, task);
    inner.append(hero);
    if (state.notice) inner.append(element("div", state.error ? "notice error" : "notice", state.notice));
    const description = element("section", "section");
    description.append(element("div", "section-label", t("task")), element("div", "task-description", task.description || t("taskEmpty")));
    description.dataset.messageId = task.message.id;
    if (task.message.id === state.location.message || task.message.toolCallId === state.location.message) description.classList.add("is-target");
    const summary = element("div", "metrics");
    summary.append(metric(t("duration"), formatDuration(durationOf(task)), "live-duration"));
    if (task.usage) summary.append(metric(t("tokens"), task.usage.total.toLocaleString()));
    summary.append(metric(t("calls"), task.children.filter((message) => message.role === "tool" && message.toolName !== "TaskExecution").length));
    description.append(summary);
    inner.append(description);
    renderSupervision(inner, task);
    if (task.error) {
      const failure = element("div", "notice error");
      failure.append(element("strong", "", `${t("error")}: `), document.createTextNode(formatValue(task.error.message || task.error)));
      inner.append(failure);
    }
    const timeline = element("section", "timeline");
    timeline.append(element("div", "section-label", t("process")));
    const target = state.location.message || "";
    const rows = task.children.filter((message) => message.toolName !== "TaskExecution");
    if (!rows.length) timeline.append(element("div", "timeline-empty", t("processEmpty")));
    else rows.forEach((message) => timeline.append(renderMessage(message, target)));
    inner.append(timeline);
    scroll.append(inner);
    panel.append(scroll);
    shell.append(panel);
  }

  function render(options = {}) {
    const focusKey = options.capture === false ? "" : captureUi();
    app.replaceChildren();
    if (state.bridgeUnavailable) { app.append(element("div", "empty-state", t("noBridge"))); return; }
    if (!state.sessionId) { app.append(element("div", "empty-state", t("noSession"))); return; }
    if (state.loading && !state.tasks.length) { renderState(t("loading"), false); return; }
    if (state.error && !state.tasks.length) { renderState(t("loadError"), true); return; }
    const shell = element("div", "shell");
    let selected = taskByKey(state.selectedKey);
    if (!selected && state.tasks.length) {
      selected = state.tasks[0];
      state.selectedKey = selected.key;
    } else if (selected) {
      state.selectedKey = selected.key;
    }
    renderSidebar(shell, selected);
    renderDetail(shell, selected);
    app.append(shell);
    restoreUi(focusKey);
    requestAnimationFrame(() => locateRequested());
    void requestRecall(selected);
  }

  function selectTask(key, userInitiated) {
    captureUi();
    const task = taskByKey(key);
    state.selectedKey = task?.key || key;
    state.notice = "";
    if (userInitiated) state.location = { ...state.location, task: state.selectedKey, message: "", query: "", request: "" };
    render({ capture: false });
  }

  async function requestRecall(task) {
    if (!task || task.outcome === "running" || state.recall.has(task.key)) return;
    const generation = state.loadGeneration;
    const sessionId = state.sessionId;
    const taskKey = task.key;
    state.recall.set(taskKey, undefined);
    try {
      const result = await invoke("observer.recall", { sessionId, delegationId: task.delegationId });
      if (generation !== state.loadGeneration || state.sessionId !== sessionId || state.disposed) return;
      state.recall.set(taskKey, normalizeRecall(result));
      if (state.selectedKey === taskKey) render();
    } catch {
      if (generation === state.loadGeneration && state.sessionId === sessionId) state.recall.set(taskKey, null);
    }
  }

  async function controlTask(task, revoke) {
    if (state.actionPending.has(task.key)) return;
    const generation = state.loadGeneration;
    const sessionId = state.sessionId;
    const taskKey = task.key;
    state.actionPending.add(taskKey);
    state.notice = revoke ? t("revoking") : t("stopping");
    render();
    try {
      await invoke("observer.stop", { sessionId, delegationId: task.delegationId, expectedExecution: task.execution });
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      state.recall.delete(taskKey);
      state.notice = "";
      await refreshNewest(true);
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      if (revoke) await requestRecall(taskByKey(taskKey));
    } catch (error) {
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      state.error = String(error?.message || error);
      state.notice = state.error;
    } finally {
      if (generation === state.loadGeneration && state.sessionId === sessionId) {
        state.actionPending.delete(taskKey);
        render();
      }
    }
  }

  function locateRequested() {
    if (!state.location.message && !state.location.query) return;
    const signature = [state.sessionId, state.location.task, state.location.message, state.location.query, state.location.request, state.location.open].join("\u0000");
    if (state.locatedRequest === signature) return;
    if (state.loading) return;
    const found = parser.searchTask(state.tasks, state.location);
    if (!found) {
      state.notice = t("locating");
      state.locatedRequest = signature;
      if (!document.querySelector(".notice")) render();
      return;
    }
    if (state.selectedKey !== found.task.key) {
      captureUi();
      state.selectedKey = found.task.key;
      render({ capture: false });
      return;
    }
    const row = document.querySelector(`[data-message-id="${CSS.escape(found.message.id)}"]`);
    if (!row) return;
    state.locatedRequest = signature;
    row.classList.add("is-target");
    const details = row.querySelector("details");
    if (details) details.open = true;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function rebuildTasks(preferredKey) {
    const previousKey = state.selectedKey;
    state.tasks = parser.buildTasks(state.messages);
    const desired = preferredKey || state.location.task || previousKey;
    const selected = taskByKey(desired) || taskByKey(previousKey) || state.tasks[0] || null;
    state.selectedKey = selected?.key || "";
    if (selected && previousKey && previousKey !== selected.key && state.taskUi.has(previousKey) && !state.taskUi.has(selected.key)) {
      state.taskUi.set(selected.key, state.taskUi.get(previousKey));
    }
  }

  async function historyPage(sessionId, before) {
    const payload = { sessionId };
    if (before !== undefined) payload.messageBefore = before;
    const page = await invoke("observer.history", payload);
    const session = parser.sessionFrom(page);
    if (!session) throw new Error("Session unavailable");
    return { session, messages: parser.messagesFrom(page) };
  }

  async function loadAll(sessionId, generation) {
    let before;
    let combined = [];
    do {
      const page = await historyPage(sessionId, before);
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return null;
      combined = parser.mergeMessages(combined, page.messages);
      if (!page.session.hasMoreBefore) break;
      const next = page.session.messageStart;
      if (!Number.isSafeInteger(next) || next < 0 || (before !== undefined && next >= before)) throw new Error("History page did not advance");
      before = next;
    } while (before > 0);
    return combined;
  }

  async function loadIncremental(sessionId, generation) {
    if (!state.messages.length) return loadAll(sessionId, generation);
    const newestId = state.messages[state.messages.length - 1]?.id;
    let overlap = false;
    let before;
    let combined = [];
    do {
      const page = await historyPage(sessionId, before);
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return null;
      combined = parser.mergeMessages(combined, page.messages);
      overlap = page.messages.some((message) => message.id === newestId);
      if (overlap || !page.session.hasMoreBefore) break;
      const next = page.session.messageStart;
      if (!Number.isSafeInteger(next) || next < 0 || (before !== undefined && next >= before)) throw new Error("History page did not advance");
      before = next;
    } while (before > 0);
    return overlap ? parser.mergeMessages(state.messages, combined) : combined;
  }

  async function readSnapshot(sessionId, generation) {
    try {
      const snapshot = await invoke("observer.snapshot", { sessionId });
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return null;
      return snapshot && typeof snapshot === "object" ? snapshot : null;
    } catch {
      return null;
    }
  }

  async function startSession(sessionId, force) {
    if (!sessionId) {
      ++state.loadGeneration;
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
      state.refreshDirty = false;
      state.refreshFull = false;
      state.bound = false;
      state.selectedKey = "";
      state.locatedRequest = "";
      state.taskUi.clear();
      state.actionPending.clear();
      state.sessionId = "";
      state.messages = [];
      state.tasks = [];
      state.liveSnapshot = null;
      state.loading = false;
      state.recall.clear();
      void invoke("observer.unbind", { clientId }).catch(() => {});
      render();
      return;
    }
    if (!force && state.sessionId === sessionId && state.tasks.length) return;
    const generation = ++state.loadGeneration;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    state.sessionId = sessionId;
    state.bound = false;
    state.selectedKey = "";
    state.locatedRequest = "";
    state.messages = [];
    state.tasks = [];
    state.liveSnapshot = null;
    state.recall.clear();
    state.actionPending.clear();
    state.taskUi.clear();
    state.sidebarScrollTop = 0;
    state.error = "";
    state.notice = "";
    state.loading = true;
    state.refreshDirty = false;
    state.refreshFull = false;
    state.observedRevision = 0;
    state.appliedRevision = 0;
    state.observedTerminalRevision = 0;
    render();
    try {
      const bound = await invoke("observer.bind", { clientId, sessionId });
      if (generation !== state.loadGeneration || state.sessionId !== sessionId || state.disposed) return;
      state.bound = true;
      applyAppearance(bound);
      state.observedRevision = Number(bound.revision || 0);
      state.observedTerminalRevision = Number(bound.terminalRevision || 0);
      const boundRevision = state.observedRevision;
      const [messages, snapshot] = await Promise.all([loadAll(sessionId, generation), readSnapshot(sessionId, generation)]);
      if (!messages || generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      state.messages = messages;
      state.liveSnapshot = snapshot;
      state.appliedRevision = boundRevision;
      rebuildTasks(state.location.task);
      state.lastRefreshAt = Date.now();
    } catch (error) {
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      state.error = String(error?.message || error);
      state.refreshDirty = true;
    } finally {
      if (generation === state.loadGeneration && state.sessionId === sessionId) {
        state.lastRefreshAt = Date.now();
        state.loading = false;
        render();
        if (state.refreshDirty || state.observedRevision > state.appliedRevision) scheduleRefresh(false);
      }
    }
  }
  async function refreshNewest(force) {
    if (!state.sessionId || state.disposed) return;
    if (!state.loading && !state.bound) return startSession(state.sessionId, true);
    if (state.loading) {
      state.refreshDirty = true;
      state.refreshFull = state.refreshFull || Boolean(force);
      return;
    }
    const generation = state.loadGeneration;
    const sessionId = state.sessionId;
    const targetRevision = state.observedRevision;
    const full = Boolean(force || state.refreshFull);
    state.refreshFull = false;
    state.refreshDirty = false;
    state.loading = true;
    render();
    let succeeded = false;
    try {
      const [messages, snapshot] = await Promise.all([
        full ? loadAll(sessionId, generation) : loadIncremental(sessionId, generation),
        readSnapshot(sessionId, generation),
      ]);
      if (!messages || generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      state.messages = messages;
      state.liveSnapshot = snapshot;
      if (full) state.recall.clear();
      state.appliedRevision = Math.max(state.appliedRevision, targetRevision);
      rebuildTasks();
      state.error = "";
      state.notice = "";
      state.lastRefreshAt = Date.now();
      succeeded = true;
    } catch (error) {
      if (generation !== state.loadGeneration || state.sessionId !== sessionId) return;
      state.refreshDirty = true;
      state.refreshFull = state.refreshFull || full;
      if (full) {
        state.error = String(error?.message || error);
        state.notice = state.error;
      }
    } finally {
      if (generation === state.loadGeneration && state.sessionId === sessionId) {
        state.lastRefreshAt = Date.now();
        state.loading = false;
        render();
        if (state.refreshDirty || state.observedRevision > state.appliedRevision) scheduleRefresh(succeeded);
      }
    }
  }

  function scheduleRefresh(terminal) {
    if (state.refreshTimer) {
      if (!terminal) return;
      clearTimeout(state.refreshTimer);
    }
    const wait = terminal ? 80 : Math.max(100, 900 - (Date.now() - state.lastRefreshAt));
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void refreshNewest(false);
    }, wait);
  }

  async function poll() {
    if (!state.sessionId || state.disposed || state.bridgeUnavailable) return;
    const generation = state.loadGeneration;
    const sessionId = state.sessionId;
    try {
      const result = await invoke("observer.poll", { sessionId });
      if (generation !== state.loadGeneration || state.sessionId !== sessionId || state.disposed) return;
      const revision = Number(result?.revision || 0);
      const terminal = Number(result?.terminalRevision || 0);
      const isTerminal = terminal > state.observedTerminalRevision;
      state.observedRevision = Math.max(state.observedRevision, revision);
      state.observedTerminalRevision = Math.max(state.observedTerminalRevision, terminal);
      if (state.observedRevision > state.appliedRevision) {
        state.refreshDirty = true;
        scheduleRefresh(isTerminal);
      }
    } catch {
      if (generation === state.loadGeneration && state.sessionId === sessionId && state.observedRevision > state.appliedRevision) scheduleRefresh(false);
    }
  }

  async function handleLocation(path) {
    const next = parseLocation(path);
    const previousRequest = state.location.request;
    state.location = next;
    state.locatedRequest = next.request === previousRequest ? state.locatedRequest : "";
    if (next.sessionId !== state.sessionId) {
      await startSession(next.sessionId, true);
      return;
    }
    const selected = taskByKey(next.task);
    if (selected && selected.key !== state.selectedKey) {
      captureUi();
      state.selectedKey = selected.key;
      state.notice = "";
      render({ capture: false });
      return;
    }
    state.notice = "";
    render();
  }

  async function boot() {
    if (!parser) { renderState("Observer parser unavailable", true); return; }
    state.location = parseLocation("");
    if (!bridge?.invoke) {
      state.bridgeUnavailable = true;
      render();
      return;
    }
    try {
      const bootstrap = await invoke("observer.bootstrap", { sessionId: state.location.sessionId });
      applyAppearance(bootstrap);
      await startSession(state.location.sessionId || bootstrap.sessionId || "", true);
    } catch (error) {
      state.error = String(error?.message || error);
      renderState(t("loadError"), true);
    }
    state.pollTimer = setInterval(poll, 500);
    state.tickTimer = setInterval(() => {
      const task = taskByKey(state.selectedKey);
      const duration = document.getElementById("live-duration");
      if (task && isTaskLive(task) && duration) duration.lastChild.textContent = formatDuration(durationOf(task));
    }, 1000);
  }

  const removeViewListener = bridge?.on?.("view:open", (event) => handleLocation(event?.path || event));
  const removeAppearanceListener = bridge?.on?.("appearance:changed", (value) => { applyAppearance(value); render(); });
  window.addEventListener("pagehide", () => {
    state.disposed = true;
    state.loadGeneration += 1;
    clearInterval(state.pollTimer);
    clearInterval(state.tickTimer);
    clearTimeout(state.refreshTimer);
    removeViewListener?.();
    removeAppearanceListener?.();
    if (bridge?.invoke) invoke("observer.unbind", { clientId }).catch(() => {});
  }, { once: true });

  void boot();
})();
