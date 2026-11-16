const find = (id) => document.getElementById(id);
const port = find("port");
const password = find("password");
const feedback = find("feedback");
let busy = false;
let portEdited = false;
let latestState = null;
port.addEventListener("input", () => { portEdited = true; });

function render(state) {
  latestState = state;
  find("state").textContent = state.running ? "访问已开启" : state.autoStart?.enabled ? "等待自动恢复" : "访问已关闭";
  find("state").title = state.autoStart?.persisted ? "开启选择已保存" : "开启选择尚未保存";
  find("password-state").textContent = state.passwordConfigured ? "已设置" : "未设置";
  if (!portEdited) port.value = String(state.settings.port);
  find("disable").disabled = busy || (!state.running && !state.autoStart?.enabled);
  find("enable").disabled = busy || !state.passwordConfigured;
  find("links").replaceChildren(...(state.links || []).map((entry) => {
    const link = document.createElement("a");
    link.href = entry.url;
    link.textContent = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }));
  find("devices").replaceChildren(...(state.devices || []).map((device) => {
    const row = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = device.name || device.deviceName || "已登录设备";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "移除";
    revoke.disabled = busy;
    revoke.addEventListener("click", () => void operate(() => call("remote.revoke", { deviceId: device.deviceId })));
    row.append(name, revoke);
    return row;
  }));
  feedback.textContent = state.settingsError || state.error?.message || "";
}

async function call(channel, payload = {}) {
  const result = await window.pluginBridge.invoke(channel, payload);
  if (result.status) render(result.status);
  if (result.ok === false) throw new Error(result.error?.message || "操作失败");
  return result;
}

async function operate(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  let message = "";
  try { await action(); } catch (error) { message = error.message; }
  finally {
    busy = false;
    for (const button of document.querySelectorAll("button")) button.disabled = false;
    if (latestState) render(latestState);
    else { find("enable").disabled = true; find("disable").disabled = true; }
    try { await call("remote.status"); } catch (error) { message ||= error.message; }
    if (message) feedback.textContent = message;
  }
}

find("connection").addEventListener("submit", (event) => {
  event.preventDefault();
  void operate(async () => {
    await call("remote.start", { port: Number(port.value) });
    portEdited = false;
  });
});
find("disable").addEventListener("click", () => void operate(() => call("remote.stop")));
find("credentials").addEventListener("submit", (event) => {
  event.preventDefault();
  void operate(async () => {
    await call("remote.setPassword", { password: password.value });
    password.value = "";
  });
});

if (window.pluginBridge) {
  void operate(() => call("remote.status"));
  const polling = setInterval(() => {
    if (!busy && !document.hidden) void call("remote.status").catch((error) => { feedback.textContent = error.message; });
  }, 4000);
  window.addEventListener("pagehide", () => clearInterval(polling), { once: true });
} else {
  find("state").textContent = "设置预览";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  feedback.textContent = "请在应用的插件设置中打开。";
}
