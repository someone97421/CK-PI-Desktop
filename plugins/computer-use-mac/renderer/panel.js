"use strict";
const $ = id => document.getElementById(id);
let busy = false;
let dirty = false;
let polling = false;
async function invoke(channel, payload = {}) {
  if (!window.pluginBridge) throw new Error("请在助手的插件面板中操作。");
  const result = await window.pluginBridge.invoke(channel, payload);
  if (result?.isError) throw new Error(result.error || "操作失败。");
  return result;
}
function render(state) {
  const p = state.permissions;
  const ready = state.status === "running" && p?.accessibility && p?.screen_recording;
  $("status").textContent = ready ? "已就绪 · 常驻运行" : state.status === "running" ? "运行中 · 等待系统授权" : ({ starting: "正在启动…", stopped: "已停止", error: "运行异常" }[state.status] || "等待启动");
  $("dot").className = `dot ${ready ? "on" : state.status === "error" ? "error" : state.status !== "stopped" ? "wait" : ""}`;
  $("meta").textContent = `内置驱动 ${state.version || state.probe?.version || ""} · ${state.arch || "Mac"} · ${state.autoStart ? "随助手自动启动" : "手动启动"}`;
  $("accessibility").textContent = p ? p.accessibility ? "已授权" : "需要授权" : "等待检查";
  $("screen").textContent = p ? p.screen_recording ? "已授权" : "需要授权" : "等待检查";
  $("error").textContent = state.status === "error" ? state.lastError || state.probe?.error || "" : "";
  if (!dirty) $("allowlist").value = state.allowlist || "";
  if (state.doctor) {
    $("diagnostic-card").hidden = false;
    $("diagnostic").textContent = `${state.doctor.text || ""}\n\n权限：${JSON.stringify(p || {}, null, 2)}\n${state.stderrTail || ""}`;
  }
}
async function action(channel, payload) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  $("error").textContent = "";
  try {
    const state = await invoke(channel, payload);
    if (channel === "cu.setAllowlist") dirty = false;
    render(state);
  } catch (error) { $("error").textContent = error.message; }
  finally {
    busy = false;
    document.querySelectorAll("button").forEach(button => { button.disabled = false; });
  }
}
document.querySelectorAll("[data-channel]").forEach(button => button.addEventListener("click", () => action(button.dataset.channel)));
$("allowlist").addEventListener("input", () => { dirty = true; });
$("save").addEventListener("click", () => action("cu.setAllowlist", { allowlist: $("allowlist").value }));
for (const [id, section] of [["access-settings", "Privacy_Accessibility"], ["screen-settings", "Privacy_ScreenCapture"]]) {
  $(id).addEventListener("click", () => invoke("cu.openSettings", { section }).catch(error => { $("error").textContent = error.message; }));
}
async function refresh() {
  if (busy || polling || document.hidden) return;
  polling = true;
  try { render(await invoke("cu.state")); } catch (error) { $("error").textContent = error.message; }
  finally { polling = false; }
}
if (window.pluginBridge) { void refresh(); setInterval(refresh, 2000); }
else $("status").textContent = "在助手中导入插件后即可使用";
