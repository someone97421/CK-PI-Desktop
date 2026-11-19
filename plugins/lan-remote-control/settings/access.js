const find = (id) => document.getElementById(id);
const port = find("port");
const username = find("username");
const password = find("password");
const feedback = find("feedback");
const bridge = window.pluginBridge;
let busy = false;
let portEdited = false;
let usernameEdited = false;
let latestState = null;
let activeRead = null;
let disposed = false;
let listSignature = "";
let notice = null;
let readError = "";

const errorMessage = (error) => error instanceof Error ? error.message : String(error);
function showFeedback() {
  const stateError = latestState?.settingsError || latestState?.error?.message;
  const currentNotice = notice?.message ? notice : null;
  const operationError = currentNotice?.tone === "error" ? currentNotice.message : "";
  feedback.textContent = operationError || readError || currentNotice?.message || stateError || "";
  feedback.dataset.tone = operationError || readError ? "error" : currentNotice?.tone || (stateError ? "error" : "neutral");
}
function notify(message, tone = "success") {
  notice = { message, tone };
  showFeedback();
}
function syncControls() {
  const unavailable = !bridge || busy;
  for (const button of document.querySelectorAll("button")) button.disabled = unavailable;
  port.disabled = unavailable || !latestState;
  username.disabled = unavailable || !latestState;
  password.disabled = unavailable;
  find("enable").disabled = unavailable || !latestState?.passwordConfigured;
  find("disable").disabled = unavailable || (!latestState?.running && !latestState?.autoStart?.enabled);
  find("enable").textContent = latestState?.running ? "应用并保持开启" : "开启并记住";
  find("connection").setAttribute("aria-busy", String(busy));
  find("credentials").setAttribute("aria-busy", String(busy));
}
function empty(container, message) {
  const hint = document.createElement("p");
  hint.className = "empty hint";
  hint.textContent = message;
  container.replaceChildren(hint);
}
function renderLists(state) {
  const links = state.links || [];
  const devices = state.devices || [];
  const signature = JSON.stringify([links, devices.map((device) => [device.deviceId, device.name, device.deviceName])]);
  if (signature === listSignature) return;
  listSignature = signature;
  find("device-count").textContent = String(devices.length);
  find("links").replaceChildren(...links.map((entry) => {
    const row = document.createElement("div");
    row.className = "list-row";
    const content = document.createElement("div");
    content.className = "row-content";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = entry.label || "主机地址";
    const link = document.createElement("a");
    link.href = entry.url;
    link.textContent = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const arrow = document.createElement("span");
    arrow.className = "address-arrow";
    arrow.textContent = "↗";
    arrow.setAttribute("aria-hidden", "true");
    link.title = "在浏览器中打开；也可选中地址复制";
    content.append(label, link);
    row.append(content, arrow);
    return row;
  }));
  if (!links.length) empty(find("links"), "开启远程访问后显示地址。");
  find("devices").replaceChildren(...devices.map((device) => {
    const row = document.createElement("div");
    row.className = "list-row";
    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = device.name || device.deviceName || "已登录设备";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "row-action revoke";
    revoke.textContent = "移除";
    revoke.title = "撤销登录，此设备需要重新登录";
    revoke.setAttribute("aria-label", `移除 ${name.textContent}`);
    revoke.addEventListener("click", () => void operate(() => call("remote.revoke", { deviceId: device.deviceId }), "设备已移除。"));
    row.append(name, revoke);
    return row;
  }));
  if (!devices.length) empty(find("devices"), "暂无已登录设备。");
}
function render(state) {
  if (disposed) return;
  latestState = state;
  const status = find("state");
  status.textContent = state.running ? "访问已开启" : state.autoStart?.enabled ? "等待自动恢复" : "访问已关闭";
  status.dataset.tone = state.running ? "online" : "neutral";
  status.title = state.autoStart?.persisted ? "开启选择已保存" : "开启选择尚未保存";
  find("password-state").textContent = state.passwordConfigured ? "已设置" : "未设置";
  const serviceHint = find("service-hint");
  const stateError = state.settingsError || state.error?.message;
  serviceHint.dataset.tone = stateError ? "error" : "neutral";
  serviceHint.textContent = stateError || (!state.passwordConfigured ? "请先设置访问账号和密码，再开启服务。"
    : state.running ? "正在监听所有 IPv4 网卡。外网访问可使用 HTTPS 反向代理。"
    : state.autoStart?.enabled ? "应用会自动恢复远程访问。" : "关闭时仅监听本机回环地址。");
  if (!portEdited) port.value = String(state.settings.port);
  if (!usernameEdited) username.value = state.username || "admin";
  renderLists(state);
  syncControls();
  showFeedback();
}
async function call(channel, payload = {}) {
  const result = await bridge.invoke(channel, payload);
  if (result.status) render(result.status);
  if (result.ok === false) throw new Error(result.error?.message || "操作失败");
  return result;
}
async function refresh() {
  if (activeRead) return activeRead;
  activeRead = (async () => {
    try { await call("remote.status"); readError = ""; }
    catch (error) {
      readError = `状态刷新失败：${errorMessage(error)}`;
      find("state").textContent = latestState ? "状态待确认" : "读取失败";
      find("state").dataset.tone = "error";
      if (!latestState) {
        find("service-hint").textContent = "读取失败，可点击刷新状态重试。";
        find("password-state").textContent = "待确认";
        empty(find("links"), "暂时无法读取访问地址。");
        empty(find("devices"), "暂时无法读取设备。");
      }
    } finally { activeRead = null; showFeedback(); }
  })();
  return activeRead;
}
async function operate(action = null, success = "") {
  if (busy || !bridge || disposed) return;
  busy = true;
  notice = { message: "正在处理…", tone: "neutral" };
  syncControls();
  showFeedback();
  try {
    if (activeRead) await activeRead;
    if (disposed) return;
    if (action) await action();
    notice = { message: success, tone: "success" };
  } catch (error) { notice = { message: errorMessage(error), tone: "error" }; }
  finally {
    if (!disposed) await refresh();
    busy = false;
    if (!disposed) { syncControls(); showFeedback(); }
  }
}
port.addEventListener("input", () => { portEdited = true; });
username.addEventListener("input", () => { usernameEdited = true; });
find("show-password").addEventListener("click", () => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  find("show-password").textContent = visible ? "隐藏" : "显示";
  find("show-password").setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
  find("show-password").setAttribute("aria-pressed", String(visible));
});
find("connection").addEventListener("submit", (event) => {
  event.preventDefault();
  void operate(async () => {
    await call("remote.start", { port: Number(port.value) });
    portEdited = false;
  }, "开启设置已应用。");
});
find("disable").addEventListener("click", () => void operate(() => call("remote.stop"), "远程访问已关闭。"));
find("credentials").addEventListener("submit", (event) => {
  event.preventDefault();
  void operate(async () => {
    await call("remote.setPassword", { username: username.value, password: password.value });
    usernameEdited = false;
    password.value = "";
    password.type = "password";
    find("show-password").textContent = "显示";
    find("show-password").setAttribute("aria-label", "显示密码");
    find("show-password").setAttribute("aria-pressed", "false");
  }, "访问账号和密码已保存。");
});
find("refresh").addEventListener("click", () => void operate(null, "状态已刷新。"));

let polling;
let unsubscribeAppearance;
function applyAppearance(appearance) {
  if (disposed) return;
  const base = appearance?.base;
  if (base === "light" || base === "dark") document.documentElement.dataset.base = base;
  else delete document.documentElement.dataset.base;
}
if (bridge) {
  unsubscribeAppearance = bridge.on?.("appearance:changed", applyAppearance);
  void bridge.invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
  void operate();
  polling = setInterval(() => {
    if (!busy && !document.hidden && !disposed) void refresh();
  }, 4000);
} else {
  find("state").textContent = "设置预览";
  find("password-state").textContent = "未连接主机";
  find("service-hint").textContent = "请在应用的插件设置中管理远程访问。";
  empty(find("links"), "连接主机后显示真实地址。");
  empty(find("devices"), "连接主机后显示已登录设备。");
  notify("预览模式 · 未连接插件服务", "neutral");
  syncControls();
}
window.addEventListener("pagehide", () => {
  disposed = true;
  clearInterval(polling);
  unsubscribeAppearance?.();
  password.value = "";
}, { once: true });
