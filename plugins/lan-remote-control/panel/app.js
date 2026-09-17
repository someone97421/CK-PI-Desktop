import QRCode from "qrcode";
const root = document.querySelector("#app");
function node(tag, text) {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  return n;
}
const title = node("h1", "局域网远程控制"),
  description = node("p", "让同一局域网内的设备访问电脑上的项目与对话。"),
  status = node("p"),
  error = node("p");
error.role = "alert";
const controls = node("section"),
  address = node("select"),
  port = node("input");
port.type = "number";
port.min = "1024";
port.max = "65535";
port.value = "7878";
port.setAttribute("aria-label", "监听端口");
address.setAttribute("aria-label", "局域网地址");
const qrArea = node("section"),
  devices = node("section"),
  requests = node("section");
root.append(
  title,
  description,
  status,
  error,
  controls,
  qrArea,
  requests,
  devices,
  node(
    "p",
    "仅用于可信局域网：HTTP 不加密。关闭服务或禁用插件会撤销所有连接；已接收的智能体任务继续运行。",
  ),
);
async function call(channel, payload = {}) {
  const r = await window.pluginBridge.invoke(channel, payload);
  if (r?.ok === false) throw new Error(r.error?.message || "操作失败");
  return r;
}
function button(label, action) {
  const b = node("button", label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    error.textContent = "";
    try {
      await action();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
controls.append(
  address,
  port,
  button("开启", async () => {
    await call("remote.start", {
      address: address.value,
      port: Number(port.value),
    });
    await refresh();
  }),
  button("关闭", async () => {
    await call("remote.stop");
    qrArea.replaceChildren();
    await refresh();
  }),
  button("生成配对二维码", async () => {
    const r = await call("remote.pair");
    const pairing = r.pairing;
    const canvas = node("canvas");
    await QRCode.toCanvas(canvas, pairing.url, { width: 240, margin: 2 });
    const link = node("textarea");
    link.readOnly = true;
    link.value = pairing.url;
    qrArea.replaceChildren(
      node("h2", "扫码连接"),
      canvas,
      node("p", `有效期至 ${new Date(pairing.expiresAt).toLocaleTimeString()}`),
      link,
      button("复制配对链接", () =>
        window.pluginBridge.invoke("clipboard.writeText", {
          text: pairing.url,
        }),
      ),
    );
  }),
  button("撤销全部设备", async () => {
    await call("remote.revokeAll");
    await refresh();
  }),
);
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await call("remote.status");
    const s = r.status;
    status.textContent = s.running
      ? `运行中 · ${s.url || `http://${s.address}:${s.port}`}`
      : "服务已关闭";
    const chosen = address.value;
    address.replaceChildren(
      ...(s.addresses || []).map((a) => {
        const o = node("option", `${a.label} · ${a.address}`);
        o.value = a.address;
        return o;
      }),
    );
    if (chosen) address.value = chosen;
    if (s.error) error.textContent = s.error.message;
    requests.replaceChildren(node("h2", "待批准设备"));
    for (const p of s.pendingRequests || []) {
      const row = node("article");
      row.append(
        node("strong", p.name),
        node("p", p.remoteAddress || ""),
        button("批准", async () => {
          await call("remote.approve", { requestId: p.requestId });
          await refresh();
        }),
        button("拒绝", async () => {
          await call("remote.reject", { requestId: p.requestId });
          await refresh();
        }),
      );
      requests.append(row);
    }
    devices.replaceChildren(node("h2", "已授权设备"));
    for (const d of s.devices || []) {
      const row = node("article");
      row.append(
        node("strong", d.name),
        button("撤销", async () => {
          await call("remote.revoke", { deviceId: d.deviceId });
          await refresh();
        }),
      );
      devices.append(row);
    }
    if (!s.pairing) qrArea.replaceChildren();
    if (!s.addresses?.length)
      error.textContent = "未发现局域网地址，请检查网络连接。";
    if (s.adapter?.error) error.textContent = s.adapter.error.message;
  } finally {
    refreshing = false;
  }
}
refresh().catch((e) => (error.textContent = e.message));
const timer = setInterval(
  () => refresh().catch((e) => (error.textContent = e.message)),
  2000,
);
window.addEventListener("pagehide", () => clearInterval(timer));
