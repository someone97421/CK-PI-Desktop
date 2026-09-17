/**
 * DOM 工具：只用 DOM API 构造界面。
 *
 * 硬性约束（安全边界）：远端来的字符串一律走 textContent；本模块不提供任何
 * 「把字符串当 HTML 插入」的入口。唯一插入 HTML 的地方是 markdown.js 里经过
 * DOMPurify 清洗（或本地构造的节点）的结果。
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
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
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

export function button(label, { variant = "ghost", iconName, onClick, className = "", title, disabled = false, type = "button", size = "" } = {}) {
  const node = el("button", {
    className: `btn btn-${variant}${size ? ` btn-${size}` : ""}${className ? ` ${className}` : ""}`,
    attrs: { type, title: title || label || "", disabled: disabled || undefined, "aria-label": title || label || "" },
  });
  if (iconName) node.append(icon(iconName, { size: 16 }));
  if (label) node.append(el("span", { text: label }));
  if (onClick) node.addEventListener("click", onClick);
  return node;
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

/** 自动增高输入框，并同步键盘安全区高度变量。 */
export function autoGrow(textarea, { maxHeight = 200 } = {}) {
  const resize = () => {
    textarea.style.height = "auto";
    const next = Math.min(maxHeight, textarea.scrollHeight);
    textarea.style.height = `${next}px`;
  };
  textarea.addEventListener("input", resize);
  resize();
  return resize;
}

/**
 * 底部面板 / 抽屉容器。手机上是底部面板，宽屏上是右侧浮层。
 * focusable: 打开时把焦点移进面板，关闭后归还。
 */
export function createSheet({ id, title, subtitle, onClose } = {}) {
  const backdrop = el("div", { className: "sheet-backdrop", attrs: { hidden: true } });
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
  panel.append(header, body);
  backdrop.append(panel);
  let lastFocus = null;
  let open = false;

  const onKeydown = (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") trapFocus(event, panel);
  };

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  function setTitle(next, nextSubtitle) {
    setText(titleNode, next || "");
    setText(subtitleNode, nextSubtitle || "");
  }

  function openSheet() {
    if (open) return;
    open = true;
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    document.body.classList.add("sheet-open");
    document.addEventListener("keydown", onKeydown, true);
    const focusTarget = panel.querySelector("[data-autofocus], button, input, textarea, select");
    if (focusTarget && typeof focusTarget.focus === "function") {
      setTimeout(() => focusTarget.focus({ preventScroll: true }), 30);
    }
  }

  function close() {
    if (!open) return;
    open = false;
    backdrop.hidden = true;
    document.body.classList.remove("sheet-open");
    document.removeEventListener("keydown", onKeydown, true);
    if (onClose) onClose();
    if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus({ preventScroll: true });
    }
    lastFocus = null;
  }

  /** 用标题栏做「返回」样式（用于侧会话这类二级页面）。 */
  function setBackAction(handler) {
    closeBtn.replaceChildren(icon("back", { size: 18 }));
    closeBtn.setAttribute("aria-label", "返回");
    closeBtn.replaceWith(closeBtn.cloneNode(true));
  }
  void setBackAction;

  return { root: backdrop, panel, body, header, titleNode, subtitleNode, open: openSheet, close, setTitle, isOpen: () => open };
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
    const sheet = createSheet({ title, subtitle: detail || "" });
    const row = el("div", { className: "row-actions" });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      sheet.close();
      resolve(value);
    };
    row.append(
      button(cancelLabel, { variant: "secondary", onClick: () => finish(false) }),
      button(confirmLabel, { variant: danger ? "danger" : "primary", onClick: () => finish(true) }),
    );
    sheet.body.append(row);
    sheet.root.addEventListener("click", (event) => {
      if (event.target === sheet.root) finish(false);
    });
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
