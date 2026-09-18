const root = document.querySelector("#app");
function node(tag, text) { const n = document.createElement(tag); if (text) n.textContent = text; return n; }
const title = node("h1", "局域网远程控制"), status = node("p"), error = node("p"), hint = node("p");
error.role = "alert";
const controls = node("section"), credentials = node("section"), linkArea = node("section"), devices = node("section");
const address = node("select"), port = node("input"), password = node("input"), confirmation = node("input");
port.type = "number"; port.min = "1024"; port.max = "65535"; port.value = "7878";
const PORT_MIN = 1024, PORT_MAX = 65535, PORT_FALLBACK = 7878;
port.setAttribute("aria-label", "监听端口"); address.setAttribute("aria-label", "局域网地址");
for (const field of [password, confirmation]) { field.type = "password"; field.autocomplete = "new-password"; field.maxLength = 256; }
password.placeholder = "设置访问密码（至少 8 个字符）"; password.setAttribute("aria-label", "访问密码");
confirmation.placeholder = "再次输入密码"; confirmation.setAttribute("aria-label", "再次输入密码");
const passwordStatus = node("p");
root.append(title, node("p", "开启后，把访问链接发到手机，输入主机密码即可登录。开启意图会保存：主程序重开后自动恢复监听，直到你手动关闭。"), status, hint, error, credentials, controls, linkArea, devices,
  node("p", "仅用于可信局域网：HTTP 不加密。关闭访问会断开连接；设备登录保留 30 天，可随时移除。修改密码会退出全部设备。"));
async function call(channel, payload = {}) {
  const r = await window.pluginBridge.invoke(channel, payload);
  if (r?.ok === false) throw new Error(r.error?.message || "操作失败");
  return r;
}
function button(label, action) {
  const b = node("button", label);
  b.addEventListener("click", async () => {
    b.disabled = true; error.textContent = "";
    try { await action(); } catch (e) { error.textContent = e.message; } finally { b.disabled = false; }
  });
  return b;
}
credentials.append(node("h2", "访问密码"), passwordStatus, password, confirmation, button("保存密码", async () => {
  if (password.value !== confirmation.value) throw new Error("两次输入的密码不一致");
  await call("remote.setPassword", { password: password.value });
  password.value = ""; confirmation.value = "";
  await refresh();
}));
controls.append(node("h2", "远程访问"), address, port,
  button("开启", async () => {
    const requestedPort = Number(port.value);
    if (!Number.isInteger(requestedPort) || requestedPort < PORT_MIN || requestedPort > PORT_MAX) {
      throw new Error(`端口须为 ${PORT_MIN}..${PORT_MAX} 的整数`);
    }
    const result = await call("remote.start", { address: address.value, port: requestedPort });
    if (result?.warning) error.textContent = result.warning.message;
    await refresh();
  }),
  button("关闭", async () => {
    const result = await call("remote.stop");
    if (result?.warning) error.textContent = result.warning.message;
    linkArea.replaceChildren();
    await refresh();
  }),
  button("生成访问链接", async () => {
    const { url } = await call("remote.link");
    const link = node("input"); link.type = "url"; link.readOnly = true; link.value = url; link.setAttribute("aria-label", "访问链接");
    linkArea.replaceChildren(node("h2", "手机访问链接"), link,
      button("复制链接", () => call("clipboard.writeText", { text: url })), node("p", "手机打开链接后输入访问密码。链接中不包含密码。"));
  }),
  button("移除全部设备", async () => { await call("remote.revokeAll"); await refresh(); }));
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { status: s } = await call("remote.status");
    const auto = s.autoStart || {};
    status.className = `service-status ${s.running ? "is-running" : "is-stopped"}`;
    const remembered = auto.enabled && auto.persisted !== false;
    status.textContent = s.running
      ? `访问已开启 · ${s.url}${remembered ? " · 已记住：下次启动自动开启" : ""}`
      : auto.pending
        ? auto.slowCheck
          ? `访问已关闭 · 等待自动复查（第 ${auto.attempts} 次）`
          : `访问已关闭 · 正在自动重试开启（第 ${auto.attempts} 次）`
        : remembered
          ? "访问已关闭 · 已记住开启：下次启动会自动监听"
          : "访问已关闭";
    const notes = [];
    if (s.settingsWriteError) notes.push(`${s.settingsWriteError}（本期仍按你的选择运行）`);
    if (!s.running && auto.lastError) {
      notes.push(`上次开启失败：${auto.lastError.message}${auto.pending ? "" : "；可再次点击“开启”立即重试。"}`);
    }
    if (s.restartRequired) notes.push("地址或端口已更改，重新开启后生效。");
    hint.textContent = notes.join(" ");
    passwordStatus.textContent = s.passwordConfigured ? "已设置密码；重新保存会退出所有已登录设备。" : "请先设置访问密码，再开启远程访问。";
    if (document.activeElement !== address) {
      const chosen = s.address || s.settings?.bindAddress || "";
      const automatic = node("option", "自动选择本机私网地址");
      automatic.value = "";
      address.replaceChildren(automatic,
        ...(s.addresses || []).map((a) => { const o = node("option", `${a.label} · ${a.address}`); o.value = a.address; return o; }));
      if ([...address.options].some((o) => o.value === chosen)) address.value = chosen;
    }
    if (document.activeElement !== port) {
      const savedPort = Number(s.settings?.port);
      port.value = String(Number.isInteger(savedPort) && savedPort >= PORT_MIN && savedPort <= PORT_MAX ? savedPort : PORT_FALLBACK);
    }
    if (s.error) error.textContent = s.error.message;
    devices.replaceChildren(node("h2", "已登录设备"));
    if (!s.devices?.length) devices.append(node("p", "暂无已登录设备"));
    for (const d of s.devices || []) {
      const row = node("article");
      row.append(node("strong", d.name), node("p", `${d.connections ? "在线" : "离线"} · ${d.remoteAddress || ""} · 最近访问 ${new Date(d.lastSeenAt).toLocaleString()}`),
        button("移除设备", async () => { await call("remote.revoke", { deviceId: d.deviceId }); await refresh(); }));
      devices.append(row);
    }
    if (!s.running) linkArea.replaceChildren();
    if (!s.addresses?.length) error.textContent = "未发现局域网地址，请检查网络连接。";
    if (s.adapter?.error) error.textContent = s.adapter.error.message;
  } finally { refreshing = false; }
}
refresh().catch((e) => (error.textContent = e.message));
const timer = setInterval(() => refresh().catch((e) => (error.textContent = e.message)), 2000);
window.addEventListener("pagehide", () => clearInterval(timer));
