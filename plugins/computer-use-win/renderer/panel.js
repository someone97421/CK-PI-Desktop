"use strict";

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
  error: "出错",
};

const applyAppearance = (appearance) => {
  const base = appearance?.base;
  document.documentElement.dataset.base =
    base === "light" || base === "dark"
      ? base
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
};

window.pluginBridge?.on?.("appearance:changed", applyAppearance);
window.pluginBridge?.invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));

function hostBridge() {
  const api = window.pluginBridge;
  return api && typeof api.invoke === "function" ? api : null;
}

async function invoke(channel, payload) {
  const api = hostBridge();
  if (!api) throw new Error("宿主桥不可用：面板没有运行在『这是一个助手』里。");
  return api.invoke(channel, payload || {});
}

/** Panel-local state. `current` is only ever a real host state, never a guess. */
let current = null;
let busy = false;
let requestSeq = 0;
let localError = "";
let doctorText = "";
let allowlistDirty = false;
let pollTimer = 0;
let fastPolls = 0;

const ACTION_IDS = ["start", "refresh", "repair", "doctor", "saveAllowlist"];

function shorten(text) {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

/** Bundled runtime present and usable: `probe.installed && !probe.error`. */
function runtimeOk(state) {
  const probe = state?.probe || {};
  return Boolean(probe.installed) && !probe.error;
}

function showAlert(tone, title, text, repair) {
  const alert = $("alert");
  alert.dataset.tone = tone;
  $("alertTitle").textContent = title;
  $("alertText").textContent = text || "";
  $("alertText").hidden = !text;
  $("alertActions").hidden = !repair;
  alert.hidden = false;
}

function hideAlert() {
  $("alert").hidden = true;
}

function setLog(caption, text) {
  const body = String(text ?? "").trim();
  $("logCaption").textContent = caption || "";
  $("logCaption").hidden = !caption;
  const log = $("log");
  log.hidden = !caption && !body;
  log.textContent = body || (caption ? "（无输出）" : "");
}

function renderDiagnostics(state) {
  const probe = state.probe || {};
  $("diagMeta").textContent =
    [
      state.platform === "win32" ? "Windows" : state.platform,
      state.arch,
      state.version ? `runtime ${state.version}` : null,
      probe.version ? `cua-driver ${probe.version}` : null,
      probe.path || state.exe,
      probe.error ? `probe: ${probe.error}` : null,
      state.bannerActive ? "提示条显示中" : null,
    ]
      .filter(Boolean)
      .join(" · ") || "—";
}

function syncButtons() {
  if (!hostBridge()) return;
  const status = current?.status || "stopped";
  const enabled = current?.enabled !== false;
  $("start").disabled = busy || !enabled || status === "running" || status === "starting";
  $("refresh").disabled = busy;
  $("repair").disabled = busy;
  $("doctor").disabled = busy;
  $("saveAllowlist").disabled = busy;
  // 急停 stays usable during other requests: a pending start must not block it.
  $("stop").disabled = false;
}

function render(state) {
  current = state && typeof state === "object" ? state : {};
  const status = current.status || "stopped";
  const enabled = current.enabled !== false;
  const ok = runtimeOk(current);

  $("status").dataset.state = status;
  $("statusText").textContent = STATUS_LABEL[status] || status;

  // Never overwrite text the user is still editing.
  if (!allowlistDirty) $("allowlist").value = String(current.allowlist ?? "");

  if (localError) {
    showAlert("error", "操作失败", shorten(localError), true);
  } else if (status === "error") {
    showAlert("error", "运行时出错", shorten(current.lastError) || "运行时已退出。", true);
  } else if (!ok) {
    const detail = current.probe?.error
      ? `内置运行时不可用：${shorten(current.probe.error)}`
      : "内置运行时缺失或已损坏。";
    showAlert(
      "error",
      "需要修复运行环境",
      `${detail} 点『修复并启动』会重新部署内置运行时并启动；若反复失败，请重新导入 Windows 版插件包。`,
      true,
    );
  } else if (!enabled) {
    showAlert("warn", "插件已停用", "插件在设置中被停用，启动会被拒绝。", false);
  } else {
    hideAlert();
  }

  if (!enabled) $("controlHint").textContent = "插件已在设置中停用。";
  else if (status === "running") {
    $("controlHint").textContent = current.bannerActive
      ? "运行中：正在操作桌面，主屏顶部有提示条，按 Esc 可打断。"
      : "运行中：Agent 可以操作桌面。";
  } else if (status === "starting") $("controlHint").textContent = "正在启动并与运行时握手…";
  else if (status === "error") $("controlHint").textContent = "运行时已退出，可点『修复并启动』重试。";
  else if (current.stoppedByUser) $("controlHint").textContent = "已急停：点『启动』后可继续操作桌面。";
  else $("controlHint").textContent = "已停止：点『启动』后 Agent 才能操作桌面。";

  const frame = current.lastFrame;
  const img = $("frame");
  if (frame?.imageDataUrl) {
    img.hidden = false;
    img.src = frame.imageDataUrl;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  const tree = $("tree");
  if (frame?.text) {
    tree.hidden = false;
    tree.textContent = frame.text;
  } else {
    tree.hidden = true;
    tree.textContent = "";
  }
  $("frameMeta").textContent = frame
    ? `${frame.app || "app"} · ${new Date(frame.at).toLocaleTimeString()}`
    : "还没有截图。Agent 调用 get_app_state 后会出现在这里。";

  if (current.doctor) doctorText = String(current.doctor.text || "");

  renderDiagnostics(current);
  if (doctorText) setLog("Doctor 输出", doctorText);
  else if (localError) setLog("最近一次操作错误", localError);
  else if (status === "error" && current.lastError) setLog("运行时错误", current.lastError);
  else setLog("运行时 stderr", current.stderrTail);

  syncButtons();
}

function applyFailure(error) {
  localError = error instanceof Error ? error.message : String(error);
  if (current) render(current);
  else {
    showAlert("error", "操作失败", shorten(localError), true);
    setLog("最近一次操作错误", localError);
  }
}

/** Every action is single-flight: a second click while one is pending is ignored. */
async function run(action) {
  if (!hostBridge() || busy) return;
  busy = true;
  const seq = ++requestSeq;
  syncButtons();
  try {
    const next = await action();
    if (seq !== requestSeq) return; // superseded (for example by 急停)
    localError = "";
    // cu.state and the derived replies carry the state; anything else is re-read.
    const state =
      next && typeof next === "object" && (next.status !== undefined || next.probe !== undefined)
        ? next
        : await invoke("cu.state");
    if (seq !== requestSeq) return;
    render(state);
  } catch (error) {
    if (seq === requestSeq) applyFailure(error);
  } finally {
    busy = false;
    syncButtons();
  }
}

async function loadState(quiet) {
  if (!hostBridge() || busy) return;
  const seq = ++requestSeq;
  try {
    const state = await invoke("cu.state");
    if (seq !== requestSeq) return;
    if (!quiet) localError = "";
    render(state);
  } catch (error) {
    if (seq !== requestSeq) return;
    applyFailure(error);
  }
}

/** 急停 bypasses the single-flight guard so it works while a start is pending. */
async function emergencyStop() {
  if (!hostBridge()) return;
  const seq = ++requestSeq;
  try {
    const state = await invoke("cu.stop");
    if (seq !== requestSeq) return;
    localError = "";
    render(state);
  } catch (error) {
    if (seq !== requestSeq) return;
    applyFailure(error);
  }
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  const starting = current?.status === "starting";
  if (starting) fastPolls += 1;
  else fastPolls = 0;
  const delay = starting && fastPolls <= 40 ? 1500 : 8000;
  pollTimer = window.setTimeout(poll, delay);
}

async function poll() {
  if (hostBridge() && document.visibilityState !== "hidden" && !busy) {
    await loadState(true);
  }
  if (hostBridge()) schedulePoll();
}

function bind(id, action) {
  $(id).addEventListener("click", () => {
    void run(action);
  });
}

bind("start", () => invoke("cu.start"));
bind("refresh", () => invoke("cu.state"));
bind("doctor", () => invoke("cu.doctor"));
bind("repair", async () => {
  doctorText = "";
  const repaired = await invoke("cu.repair");
  return repaired && typeof repaired === "object" ? repaired : invoke("cu.state");
});
bind("saveAllowlist", async () => {
  const saved = await invoke("cu.setAllowlist", { allowlist: $("allowlist").value });
  allowlistDirty = false;
  return saved;
});

$("stop").addEventListener("click", () => {
  void emergencyStop();
});
$("allowlist").addEventListener("input", () => {
  allowlistDirty = true;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadState(true);
});

function reportMissingBridge() {
  $("status").dataset.state = "error";
  $("statusText").textContent = "无宿主桥";
  $("controlHint").textContent = "";
  $("diagMeta").textContent = "未连接宿主";
  for (const id of [...ACTION_IDS, "stop"]) $(id).disabled = true;
  setLog("", "");
  showAlert(
    "error",
    "宿主桥不可用",
    "面板没有运行在『这是一个助手』里，读不到运行状态，也不能启停、截图或保存允许列表。请在应用内打开本面板。",
    false,
  );
}

if (hostBridge()) {
  void loadState();
  schedulePoll();
} else {
  reportMissingBridge();
}
