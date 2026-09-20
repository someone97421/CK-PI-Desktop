/**
 * DOM 工具：只用 DOM API 构造界面。
 *
 * 文本通过 textContent 展示；富文本由 markdown.js 解析与清洗。
 * 本模块负责表单、弹层与按钮的通用交互。
 */

import { formatBytes, formatRelative, formatTime } from "./protocol.js";

export { formatBytes, formatRelative, formatTime };

/**
 * 创建元素。
 * @param {string} tag
 * @param {object} [props] className / text / attrs / dataset / on / value / type ...
 * @param {Array<Node|string|null|undefined>} [children]
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (tag === "dialog") enableDialogDismiss(node);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "attrs") {
        for (const [attr, attrValue] of Object.entries(value)) {
          if (attrValue === undefined || attrValue === null) continue;
          if (attrValue === false) continue;
          node.setAttribute(attr, attrValue === true ? "" : String(attrValue));
        }
      } else if (key === "dataset") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue === undefined || dataValue === null) continue;
          node.dataset[dataKey] = String(dataValue);
        }
      } else if (key === "on") {
        for (const [eventName, handler] of Object.entries(value)) {
          if (typeof handler === "function") node.addEventListener(eventName, handler);
        }
      } else if (key === "value") {
        node.value = value;
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setText(node, value) {
  node.textContent = value === undefined || value === null ? "" : String(value);
  return node;
}

/** 变体包装：避免在调用处到处写 node.className += " x"。 */
export function withClass(tag, className, ...children) {
  return el(tag, { className }, ...children);
}

/** 只允许静态图标表；path 数据是本文件内的常量，不含远端内容。 */
const ICON_PATHS = {
  folder: "M3 7V5h6l2 2h10v13H3zM3 10h18",
  filter: "M4 7h6M14 7h6M4 17h10M18 17h2M10 4v6M14 14v6",
  theme: "M20 13a8 8 0 01-9-9 8 8 0 109 9z",
  model: "M8 3v3M16 3v3M8 18v3M16 18v3M3 8h3M3 16h3M18 8h3M18 16h3M6 6h12v12H6zM10 10h4v4h-4z",
  commands: "M4 6l6 6-6 6M13 18h7",
  library: "M3 5h18v14H3zM9 5v14",
  shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6",
  login: "M14 4h6v16h-6M3 12h12M10 7l5 5-5 5",
  logout: "M10 4H4v16h6M10 12h11M16 7l5 5-5 5",
  back: "M15 18l-6-6 6-6",
  forward: "M9 6l6 6-6 6",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "M6 6l12 12M18 6L6 18",
  search: "M10.5 3a7.5 7.5 0 015.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1110.5 3zm0 2a5.5 5.5 0 100 11 5.5 5.5 0 000-11z",
  send: "M4 12l16-8-6 8 6 8-16-8z",
  stop: "M7 7h10v10H7z",
  attach: "M16.5 6.5l-7.1 7.1a2.5 2.5 0 003.5 3.5l7.8-7.8a4.5 4.5 0 10-6.4-6.4L6 10.4a6.5 6.5 0 009.2 9.2l1.4-1.4",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  copy: "M9 9h9v11H9zM6 4h9v3M6 4v11h3",
  edit: "M4 20h4l10-10-4-4L4 16v4zM14 6l4 4",
  retry: "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6",
  quote: "M7 7h4v6H7zM13 7h4v6h-4zM7 13c0 3-1 4-3 4M13 13c0 3-1 4-3 4",
  annotation: "M4 5h16v11H12l-4 4v-4H4z",
  sidechat: "M4 5h16v10H9l-5 4V5zM9 9h6",
  queue: "M4 7h16M4 12h16M4 17h10",
  check: "M5 13l4 4L19 7",
  chevron: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  down: "M6 9l6 6 6-6",
  up: "M6 15l6-6 6 6",
  device: "M8 3h8v18H8zM11 19h2",
  link: "M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1",
  power: "M12 3v8M6.3 6.3a8 8 0 1011.4 0",
  warning: "M12 4l9 16H3zM12 10v4M12 17h.01",
  info: "M12 4a8 8 0 100 16 8 8 0 000-16zM12 11v5M12 8h.01",
  spinner: "M12 4a8 8 0 108 8",
  unlink: "M9 15l6-6M8 8L6 10a5 5 0 007 7l2-2M16 16l2-2a5 5 0 00-7-7l-2 2",
};

export function icon(name, { size = 18, className = "" } = {}) {
  const path = ICON_PATHS[name] || ICON_PATHS.info;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
  node.setAttribute("d", path);
  svg.append(node);
  return svg;
}

const ACTION_ICONS = {
  "主题": "theme", "退出登录": "logout", "登录": "login", "发送": "send", "停止": "stop",
  "附件": "attach", "命令/技能": "commands", "模型": "model", "队列": "queue",
  "项目列表": "library", "刷新": "refresh", "＋ 新对话": "plus",
  "返回主对话": "back", "打开侧边对话": "sidechat", "侧边对话": "sidechat",
  "加载更多会话": "down", "加载更早消息": "up", "复制": "copy", "引用": "quote",
  "批注": "annotation", "编辑重发": "edit", "重试": "retry", "编辑": "edit",
  "关闭": "close", "取消": "close", "移除": "close", "预览": "search", "应用": "check",
  "批准": "check", "拒绝": "close", "提交回答": "send", "立即发送": "send",
  "上移": "up", "下移": "down", "查询原提交": "search", "已核对，解除未决状态": "check",
};

export function button(label, { variant = "ghost", iconName, preserveLabel = false, onClick, className = "", title, disabled = false, type = "button", size = "" } = {}) {
  if (!preserveLabel) iconName ||= ACTION_ICONS[label] || (/^批注 \d/.test(label) ? "annotation" : undefined);
  const node = el("button", {
    className: `btn btn-${variant}${iconName && !preserveLabel ? " btn-icon-action" : ""}${size ? ` btn-${size}` : ""}${className ? ` ${className}` : ""}`,
    attrs: { type, title: title || label || "", disabled: disabled || undefined, "aria-label": title || label || "" },
  });
  if (iconName) node.append(icon(iconName, { size: 16 }));
  if (label) node.append(el("span", { className: "btn-label", text: label }));
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** 所有弹窗仅由明确的关闭操作退出；原生选择器、文件选择和切后台不代表取消。 */
function enableDialogDismiss(dialog) {
  dialog.tabIndex = -1;
  const remove = dialog.remove.bind(dialog);
  let removing = false;
  dialog.remove = () => {
    if (removing) return;
    removing = true;
    if (dialog.open) dialog.close();
    remove();
    removing = false;
  };
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); dialog.remove(); });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("pointerdown", (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      event.preventDefault();
      dialog.remove();
    }
  });
}


export function iconButton(name, { title, onClick, className = "", disabled = false } = {}) {
  const node = el("button", {
    className: `icon-btn${className ? ` ${className}` : ""}`,
    attrs: { type: "button", title: title || "", "aria-label": title || "", disabled: disabled || undefined },
  });
  node.append(icon(name, { size: 18 }));
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

/** 统一的空状态 / 错误状态 / 加载状态块。 */
export function stateBlock(kind, title, detail, action) {
  const wrap = el("div", { className: `state-block state-${kind}` });
  if (kind === "loading") {
    wrap.append(el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }));
  } else {
    wrap.append(icon(kind === "error" ? "warning" : "info", { size: 20 }));
  }
  wrap.append(el("p", { className: "state-title", text: title }));
  if (detail) wrap.append(el("p", { className: "state-detail", text: detail }));
  if (action) wrap.append(action);
  return wrap;
}

export function inlineSpinner(label) {
  return el(
    "span",
    { className: "inline-spinner" },
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    label ? el("span", { text: label }) : null,
  );
}

export function paragraph(text, className) {
  return el("p", { className, text });
}

/** 复制到剪贴板：优先 Clipboard API，失败时退回隐藏 textarea。 */
export async function copyText(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
  try {
    const area = el("textarea", { className: "sr-only", value });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 自动增高输入框；高度上限随当前可见视口计算。 */
export function autoGrow(textarea, { maxHeight = 200 } = {}) {
  const resize = () => {
    textarea.style.height = "auto";
    const limit = typeof maxHeight === "function" ? maxHeight() : maxHeight;
    textarea.style.height = `${Math.min(limit, textarea.scrollHeight)}px`;
  };
  textarea.addEventListener("input", resize);
  resize();
  return resize;
}

const sheetStack = [];
let appWasInert = false;
export function closeAllSheets() {
  for (const sheet of [...sheetStack].reverse()) sheet.close({ force: true });
}

/** 手机底部面板；只有最上层接收键盘操作，关闭后归还非编辑焦点。 */
export function createSheet({ id, title, subtitle, onClose } = {}) {
  const backdrop = el("div", { className: "sheet-backdrop", hidden: true });
  const body = el("div", { className: "sheet-body" });
  const header = el("header", { className: "sheet-header" });
  const titleNode = el("h2", { className: "sheet-title", text: title || "" });
  const subtitleNode = el("p", { className: "sheet-subtitle", text: subtitle || "" });
  const closeBtn = iconButton("close", { title: "关闭", onClick: () => close() });
  header.append(el("div", { className: "sheet-heading" }, titleNode, subtitleNode), closeBtn);
  const panel = el("section", {
    className: "sheet",
    attrs: { role: "dialog", "aria-modal": "true", "aria-label": title || "面板", id: id || undefined },
  });
  const feedback = el("p", { className: "sheet-feedback", hidden: true, attrs: { role: "status", "aria-live": "polite" } });
  panel.append(header, body, feedback);
  backdrop.append(panel);
  let lastFocus = null, open = false, busy = false, focusTimer;
  const disabledStates = new Map();
  const onKeydown = (event) => {
    if (!open || sheetStack[sheetStack.length - 1] !== controller) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === "Tab") trapFocus(event, panel);
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  function setTitle(next, nextSubtitle) {
    setText(titleNode, next || "");
    setText(subtitleNode, nextSubtitle || "");
    panel.setAttribute("aria-label", next || "面板");
  }
  function setBusy(value) {
    busy = value;
    panel.setAttribute("aria-busy", String(value));
    if (value) {
      for (const node of panel.querySelectorAll("button, input, textarea, select")) {
        if (!disabledStates.has(node)) disabledStates.set(node, node.disabled);
        node.disabled = true;
      }
      feedback.classList.remove("sheet-feedback-error");
      feedback.textContent = "正在提交…";
      feedback.hidden = false;
    } else {
      for (const [node, disabled] of disabledStates) node.disabled = disabled;
      disabledStates.clear();
      feedback.hidden = true;
    }
  }
  function showError(error) {
    feedback.textContent = String(error?.message || error || "操作失败，请重试。");
    feedback.classList.add("sheet-feedback-error");
    feedback.hidden = false;
  }
  function openSheet() {
    if (open) return;
    open = true;
    lastFocus = document.activeElement;
    const app = document.getElementById("app");
    if (!sheetStack.length && app) { appWasInert = app.inert; app.inert = true; }
    if (sheetStack.length) sheetStack[sheetStack.length - 1].root.inert = true;
    sheetStack.push(controller);
    backdrop.style.zIndex = String(40 + sheetStack.length);
    backdrop.hidden = false;
    document.body.classList.add("sheet-open");
    document.addEventListener("keydown", onKeydown, true);
    focusTimer = setTimeout(() => {
      if (open && sheetStack[sheetStack.length - 1] === controller) closeBtn.focus({ preventScroll: true });
    }, 30);
  }
  function close({ force = false } = {}) {
    if (!open || (busy && !force)) return;
    open = false;
    clearTimeout(focusTimer);
    backdrop.hidden = true;
    const wasTop = sheetStack[sheetStack.length - 1] === controller;
    sheetStack.splice(sheetStack.indexOf(controller), 1);
    if (sheetStack.length) sheetStack[sheetStack.length - 1].root.inert = false;
    else {
      document.body.classList.remove("sheet-open");
      const app = document.getElementById("app");
      if (app) app.inert = appWasInert;
    }
    document.removeEventListener("keydown", onKeydown, true);
    if (onClose) onClose();
    const editable = lastFocus?.matches("input, textarea, select, [contenteditable]");
    if (!force && wasTop && !editable && lastFocus?.isConnected && !lastFocus.closest("[inert]")) {
      lastFocus.focus({ preventScroll: true });
    }
    lastFocus = null;
  }
  const controller = { root: backdrop, panel, body, header, titleNode, subtitleNode, open: openSheet, close, setTitle, setBusy, showError, isOpen: () => open };
  return controller;
}

function trapFocus(event, container) {
  const focusables = [
    ...container.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((node) => node.offsetParent !== null || node === document.activeElement);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** 顶部一次性提示条（连接错误、操作失败等）。 */
export function createToaster(host) {
  const list = el("div", { className: "toasts", attrs: { role: "status", "aria-live": "polite" } });
  host.append(list);
  return {
    root: list,
    show(message, { level = "info", timeout = 4000, action } = {}) {
      const node = el("div", { className: `toast toast-${level}` });
      node.append(icon(level === "error" ? "warning" : level === "success" ? "check" : "info", { size: 16 }));
      node.append(el("span", { className: "toast-text", text: message }));
      if (action) {
        node.append(
          button(action.label, {
            variant: "ghost",
            className: "toast-action",
            onClick: () => {
              action.onClick();
              node.remove();
            },
          }),
        );
      }
      list.append(node);
      if (timeout > 0) {
        setTimeout(() => {
          node.classList.add("toast-out");
          setTimeout(() => node.remove(), 220);
        }, timeout);
      }
      return () => node.remove();
    },
  };
}

/** 简单的确认对话框（用于删除、断开等破坏性动作），Promise<boolean>。 */
export function confirmAction({ title, detail, confirmLabel = "确认", cancelLabel = "取消", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      sheet.close();
      resolve(value);
    };
    const sheet = createSheet({
      title,
      subtitle: detail || "",
      // 任何关闭路径（按钮、Esc、遮罩）都按取消处理，Promise 不悬挂。
      onClose: () => { sheet.root.remove(); finish(false); },
    });
    const row = el("div", { className: "sheet-foot" });
    row.append(
      button(cancelLabel, { variant: "secondary", preserveLabel: true, onClick: () => finish(false) }),
      button(confirmLabel, { variant: danger ? "danger" : "primary", preserveLabel: true, onClick: () => finish(true) }),
    );
    sheet.panel.append(row);
    document.body.append(sheet.root);
    sheet.open();
  });
}
/** 长按（触摸屏上替代右键菜单）。 */
export function onLongPress(node, handler, { delay = 480 } = {}) {
  let timer = null;
  let moved = false;
  const start = (event) => {
    if (event.touches && event.touches.length > 1) return;
    moved = false;
    timer = setTimeout(() => {
      timer = null;
      if (!moved) handler(event);
    }, delay);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  node.addEventListener("touchstart", start, { passive: true });
  node.addEventListener("touchmove", () => {
    moved = true;
    cancel();
  }, { passive: true });
  node.addEventListener("touchend", cancel);
  node.addEventListener("touchcancel", cancel);
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    handler(event);
  });
  return cancel;
}
