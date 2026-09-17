/**
 * 连接 / 配对界面。
 *
 * 状态机：未配对 → 开始配对（POST /api/pair）→ 等待电脑确认（轮询 status）
 * → approved（拿到设备 token，存 sessionStorage）→ 进入主界面。
 * 拒绝 / 过期 / 授权失效分别给出不同提示；服务重启后 token 全部失效，需要重新配对。
 */

import { button, el, icon, inlineSpinner, stateBlock } from "../dom.js";
import { formatCountdown, suggestDeviceName } from "../protocol.js";

export function createConnectView(ctx) {
  const root = el("div", { className: "connect-view" });
  const card = el("section", { className: "connect-card" });
  root.append(card);

  function serviceLine(state) {
    const health = state.health;
    const ready = state.ready;
    const adapter = state.capabilities && state.capabilities.adapter ? state.capabilities.adapter : {};
    const host = state.capabilities && state.capabilities.host ? state.capabilities.host : {};
    const row = el("div", { className: "kv" });
    row.append(el("span", { className: "kv-key", text: "电脑端" }));
    const parts = [];
    if (host.name) parts.push(host.name);
    if (host.version) parts.push(`宿主 ${host.version}`);
    if (adapter.version) parts.push(`适配器 ${adapter.version}`);
    if (!parts.length && health && health.version) parts.push(`服务 ${health.version}`);
    if (ready && ready.device && ready.device.name) parts.push(`已连接 ${ready.device.name}`);
    row.append(el("span", { className: "kv-value", text: parts.join(" · ") || "局域网远程控制插件" }));
    return row;
  }

  function renderUnpaired(state) {
    const token = state.pairing.token;
    card.append(
      el("h1", { className: "connect-title", text: token ? "完成配对" : "这台设备尚未配对" }),
    );
    card.append(
      el("p", {
        className: "connect-text",
        text: token
          ? "链接里的一次性配对信息已读取。确认设备名后在电脑端的面板里批准访问。"
          : "请在电脑上打开「局域网远程控制」面板，点「生成配对链接」，用手机相机扫码打开。也可以在下面粘贴配对链接或配对码。",
      }),
    );
    card.append(serviceLine(state));

    const nameField = el("div", { className: "field" });
    nameField.append(el("label", { className: "field-label", text: "设备名（电脑上显示的这台设备）" }));
    const nameInput = el("input", {
      attrs: { type: "text", maxlength: "64", autocomplete: "off", enterkeyhint: "done" },
      value: state.pairing.deviceName || suggestDeviceName(navigator.userAgent),
    });
    nameInput.addEventListener("input", () => ctx.setDeviceName(nameInput.value));
    nameField.append(nameInput);
    card.append(nameField);

    if (!token) {
      const tokenField = el("div", { className: "field" });
      tokenField.append(el("label", { className: "field-label", text: "配对链接或配对码" }));
      const tokenInput = el("input", {
        attrs: { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "http://192.168.x.x:7878/#token=…" },
      });
      tokenInput.addEventListener("change", () => ctx.setPairTokenFromInput(tokenInput.value));
      tokenField.append(tokenInput);
      card.append(tokenField);
    }

    const row = el("div", { className: "row-actions" });
    row.append(
      button("重新检测服务", {
        variant: "secondary",
        onClick: () => ctx.reloadHealth(),
      }),
    );
    row.append(
      button(token ? "开始配对" : "使用粘贴的配对码", {
        variant: "primary",
        disabled: !token && true,
        onClick: () => ctx.startPairing(),
      }),
    );
    if (!token) {
      // 没有 fragment token 时，按钮改为读取输入框：由 ctx 在提交前解析。
      row.lastElementChild.replaceWith(
        button("使用粘贴的配对码", {
          variant: "primary",
          onClick: () => ctx.startPairingFromInput(),
        }),
      );
    }
    card.append(row);
    card.append(
      el("p", {
        className: "connect-text",
        text: "配对只在这次电脑端服务运行期间有效；关闭服务、停用插件或退出应用都会让授权失效。",
      }),
    );
  }

  function renderPairing(state) {
    const pairing = state.pairing;
    card.append(el("h1", { className: "connect-title", text: "等待电脑确认" }));
    const progress = el("div", { className: "connect-progress" });
    progress.append(el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }));
    progress.append(
      el("span", {
        text: pairing.expiresAt ? `请在电脑端批准这台设备（剩余 ${formatCountdown(pairing.expiresAt)}）` : "请在电脑端批准这台设备",
      }),
    );
    card.append(progress);
    card.append(serviceLine(state));
    const kv = el("div", { className: "kv" });
    kv.append(el("span", { className: "kv-key", text: "设备名" }));
    kv.append(el("span", { className: "kv-value", text: state.pairing.deviceName }));
    card.append(kv);
    card.append(
      el("p", {
        className: "connect-text",
        text: "在电脑面板的「待批准设备」里点批准。批准后手机会自动进入项目列表。",
      }),
    );
    const row = el("div", { className: "row-actions" });
    row.append(button("取消", { variant: "secondary", onClick: () => ctx.cancelPairing() }));
    card.append(row);
  }

  function renderFailure(state, { title, detail, actions }) {
    card.append(el("h1", { className: "connect-title", text: title }));
    card.append(el("p", { className: "connect-text", text: detail }));
    card.append(serviceLine(state));
    const row = el("div", { className: "row-actions" });
    for (const action of actions) {
      row.append(button(action.label, { variant: action.variant || "secondary", onClick: action.onClick }));
    }
    card.append(row);
  }

  function update(state) {
    card.replaceChildren();
    const body = el("div", { className: "connect-body" });
    card.append(body);
    const phase = state.phase;
    const pairing = state.pairing;
    const online = phase === "online" || phase === "reconnecting";

    if (online) {
      // 已连上但界面还在连接层（例如刚配对完成）：显示一句过渡。
      card.append(
        stateBlock("loading", "连接已建立", phase === "reconnecting" ? "正在恢复连接…" : "正在载入项目…"),
      );
      return;
    }

    if (phase === "unauthorized") {
      renderFailure(state, {
        title: "连接已失效",
        detail:
          state.connectionError && state.connectionError.message
            ? state.connectionError.message
            : "电脑端已停止服务、撤销了这台设备，或插件被重载。请在电脑上重新生成配对链接。",
        actions: [
          { label: "清除并重新配对", variant: "primary", onClick: () => ctx.resetPairing() },
          { label: "重新检测服务", onClick: () => ctx.reloadHealth() },
        ],
      });
      return;
    }

    if (pairing.status === "rejected") {
      renderFailure(state, {
        title: "电脑端拒绝了这次配对",
        detail: "请在电脑上确认是本人操作，然后重新生成配对链接再扫一次。",
        actions: [
          { label: "重新配对", variant: "primary", onClick: () => ctx.resetPairing() },
        ],
      });
      return;
    }

    if (pairing.status === "expired") {
      renderFailure(state, {
        title: "配对已过期",
        detail: "一次性配对信息已失效（默认 2 分钟）。请在电脑面板重新生成链接。",
        actions: [{ label: "重新配对", variant: "primary", onClick: () => ctx.resetPairing() }],
      });
      return;
    }

    if (pairing.status === "error") {
      renderFailure(state, {
        title: "配对失败",
        detail:
          pairing.message ||
          "配对信息无效或已使用过。请在电脑面板重新生成配对链接后再扫。",
        actions: [{ label: "重新配对", variant: "primary", onClick: () => ctx.resetPairing() }],
      });
      return;
    }

    if (pairing.status === "creating" || pairing.status === "pending") {
      renderPairing(state);
      return;
    }

    if (phase === "connecting") {
      card.append(stateBlock("loading", "正在连接电脑端", "已配对，正在建立事件通道…"));
      return;
    }

    if (phase === "error") {
      renderFailure(state, {
        title: "无法连接电脑端",
        detail: state.connectionError ? state.connectionError.message : "请确认手机与电脑在同一局域网。",
        actions: [
          { label: "重试", variant: "primary", onClick: () => ctx.reloadHealth() },
          { label: "重新配对", onClick: () => ctx.resetPairing() },
        ],
      });
      return;
    }

    renderUnpaired(state);
    if (state.health === null && !state.healthLoading) {
      void ctx.reloadHealth();
    }
  }

  void icon;
  void inlineSpinner;
  return { root, update };
}
