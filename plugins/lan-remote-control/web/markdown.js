/**
 * Markdown 渲染（安全第一）。
 *
 * 两条渲染路径：
 *  1) 打包版：`marked` + `dompurify`（构建时以 ESM 包名内联）。先 sanitize 再插入，
 *     插入后再接管代码块（复制按钮、语言标签）。
 *  2) 未打包 / 依赖缺失：本文件内置的渲染器，全程 `createTextNode`，不碰 innerHTML。
 *
 * 两条路径产出相同的类名，样式只写一份。远端文本永远不会以未清洗的 HTML 进入 DOM：
 * 路径 1 只有 DOMPurify 的输出进 innerHTML，路径 2 根本不使用 innerHTML。
 * Markdown 里的图片渲染成链接（不自动发起远端请求，避免追踪像素）。
 */

import { splitAnnotationMarkers } from "./composition.js";
import { copyText, el, iconButton, setText } from "./dom.js";

const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "em", "del", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "code", "pre", "span",
  "table", "thead", "tbody", "tr", "th", "td",
  "a", "input",
];
const ALLOWED_ATTR = ["href", "title", "class", "start", "type", "checked", "disabled", "data-task"];

let libraryPromise = null;

/** 惰性加载外部渲染库；打包后命中，未打包时返回 null（走内置渲染器）。 */
function loadLibraries() {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      try {
        const [markedModule, purifyModule] = await Promise.all([
          import("marked"),
          import("dompurify"),
        ]);
        const marked = markedModule.marked || markedModule.default || markedModule;
        const DOMPurify = purifyModule.default || purifyModule;
        if (!marked || typeof marked.parse !== "function") return null;
        if (!DOMPurify || typeof DOMPurify.sanitize !== "function") return null;
        return { marked, DOMPurify };
      } catch {
        return null;
      }
    })();
  }
  return libraryPromise;
}

/** 供 UI 显示「当前用的是哪条渲染路径」。 */
export async function markdownRendererKind() {
  const libraries = await loadLibraries();
  return libraries ? "marked+dompurify" : "builtin";
}

export function isSafeHref(href) {
  const value = String(href || "").trim();
  if (!value) return false;
  if (/^(https?:|mailto:)/i.test(value)) return true;
  // 站内相对路径（附件、锚点）允许；协议相对与伪协议拒绝。
  return /^[/#?]/.test(value) && !/^\/\//.test(value);
}

function hardenAnchor(anchor) {
  const href = anchor.getAttribute("href") || "";
  if (!isSafeHref(href)) {
    const text = anchor.textContent || href;
    anchor.removeAttribute("href");
    anchor.classList.add("md-link-blocked");
    anchor.setAttribute("title", "已阻止的链接");
    setText(anchor, text);
    return;
  }
  anchor.setAttribute("target", "_blank");
  anchor.setAttribute("rel", "noopener noreferrer");
}

/** 给代码块加语言标签、复制按钮与自动换行开关。 */
function decorateCodeBlocks(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.closest(".md-code")) continue;
    const code = pre.querySelector("code");
    const language = code && code.className ? (/(?:language|lang)-([\w+#.-]+)/.exec(code.className) || [])[1] : "";
    const wrap = el("div", { className: "md-code" });
    const head = el("div", { className: "md-code-head" });
    head.append(el("span", { className: "md-code-lang", text: language || "text" }));
    const actions = el("div", { className: "md-code-actions" });
    const wrapToggle = el("button", {
      className: "md-code-btn",
      attrs: { type: "button", "aria-pressed": "false", title: "自动换行" },
      text: "换行",
    });
    wrapToggle.addEventListener("click", () => {
      const on = wrapToggle.getAttribute("aria-pressed") === "true";
      wrapToggle.setAttribute("aria-pressed", on ? "false" : "true");
      wrap.classList.toggle("md-code-wrapped", !on);
    });
    const copyBtn = el("button", {
      className: "md-code-btn",
      attrs: { type: "button", title: "复制代码" },
      text: "复制",
    });
    copyBtn.addEventListener("click", async () => {
      const text = code ? code.textContent || "" : pre.textContent || "";
      const ok = await copyText(text);
      setText(copyBtn, ok ? "已复制" : "复制失败");
      setTimeout(() => setText(copyBtn, "复制"), 1400);
    });
    actions.append(wrapToggle, copyBtn);
    head.append(actions);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
  for (const anchor of root.querySelectorAll("a")) hardenAnchor(anchor);
}

/** 用 marked + DOMPurify 渲染；失败返回 null，由调用方退回内置渲染器。 */
async function renderWithLibraries(text) {
  const libraries = await loadLibraries();
  if (!libraries) return null;
  const { marked, DOMPurify } = libraries;
  let raw;
  try {
    raw = marked.parse(text, { gfm: true, breaks: true });
  } catch {
    try {
      raw = marked.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "string") return null;
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["style", "script", "iframe", "form", "img", "svg", "math", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["style", "src", "srcset", "onerror", "onload", "formaction", "xlink:href"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  const container = document.createElement("div");
  container.innerHTML = clean; // 仅 DOMPurify 的输出
  // 任务列表项：disabled checkbox 在手机上不可点，换成静态符号。
  for (const input of container.querySelectorAll('input[type="checkbox"]')) {
    const checked = input.hasAttribute("checked");
    input.replaceWith(el("span", { className: `md-task ${checked ? "md-task-on" : ""}`, text: checked ? "☑" : "☐" }));
  }
  decorateCodeBlocks(container);
  return container;
}

// ---------------------------------------------------------------------------
// 内置渲染器（无依赖、无 innerHTML）
// ---------------------------------------------------------------------------

const BLOCK_STARTERS = [/^\s{0,3}#{1,6}\s/, /^\s{0,3}(`{3,}|~{3,})/, /^\s{0,3}>/, /^\s{0,3}([-*+]|\d+[.)])\s+/, /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/];

function isBlockStart(line) {
  return BLOCK_STARTERS.some((pattern) => pattern.test(line));
}

function inlineNodes(text) {
  const frag = document.createDocumentFragment();
  // 图片语法先匹配：会话内容里的远端图片不自动加载（避免泄漏/追踪），只渲染成链接。
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > index) frag.append(document.createTextNode(text.slice(index, match.index)));
    const token = match[0];
    const imageMatch = imagePattern.exec(token);
    imagePattern.lastIndex = 0;
    if (imageMatch && imageMatch.index === 0) {
      const label = imageMatch[1] || imageMatch[2];
      const anchor = el("a", { text: `图片：${label}`, attrs: { href: imageMatch[2] } });
      hardenAnchor(anchor);
      frag.append(anchor);
    } else if (token.startsWith("`")) {
      frag.append(el("code", { className: "md-inline-code", text: token.slice(1, -1) }));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      frag.append(el("strong", { text: token.slice(2, -2) }));
    } else if (token.startsWith("~~")) {
      frag.append(el("del", { text: token.slice(2, -2) }));
    } else if (token.startsWith("*") || token.startsWith("_")) {
      frag.append(el("em", { text: token.slice(1, -1) }));
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      const label = linkMatch ? linkMatch[1] || linkMatch[2] : token;
      const href = linkMatch ? linkMatch[2] : "";
      const anchor = el("a", { text: label, attrs: { href } });
      hardenAnchor(anchor);
      frag.append(anchor);
    } else {
      const anchor = el("a", { text: token, attrs: { href: token } });
      hardenAnchor(anchor);
      frag.append(anchor);
    }
    index = pattern.lastIndex;
  }
  if (index < text.length) frag.append(document.createTextNode(text.slice(index)));
  return frag;
}

function codeBlock(value, language) {
  const code = el("code", { className: language ? `language-${language}` : "", text: value });
  const pre = el("pre", {}, code);
  const wrap = el("div", { className: "md-code" });
  wrap.append(pre);
  const head = el("div", { className: "md-code-head" });
  head.append(el("span", { className: "md-code-lang", text: language || "text" }));
  const actions = el("div", { className: "md-code-actions" });
  const wrapToggle = el("button", { className: "md-code-btn", attrs: { type: "button", title: "自动换行" }, text: "换行" });
  wrapToggle.addEventListener("click", () => {
    const on = wrapToggle.getAttribute("aria-pressed") === "true";
    wrapToggle.setAttribute("aria-pressed", on ? "false" : "true");
    wrap.classList.toggle("md-code-wrapped", !on);
  });
  const copyBtn = el("button", { className: "md-code-btn", attrs: { type: "button", title: "复制代码" }, text: "复制" });
  copyBtn.addEventListener("click", async () => {
    const ok = await copyText(value);
    setText(copyBtn, ok ? "已复制" : "复制失败");
    setTimeout(() => setText(copyBtn, "复制"), 1400);
  });
  actions.append(wrapToggle, copyBtn);
  head.append(actions);
  wrap.prepend(head);
  return wrap;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function renderList(lines, startIndex) {
  const first = LIST_ITEM.exec(lines[startIndex]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const listNode = el(ordered ? "ol" : "ul", { className: "md-list" });
  if (ordered) listNode.setAttribute("start", String(parseInt(first[2], 10) || 1));
  let index = startIndex;
  const stack = [{ indent: baseIndent, node: listNode }];
  while (index < lines.length) {
    const line = lines[index];
    const match = LIST_ITEM.exec(line);
    if (!match) {
      // 列表项内的续行：缩进至少与当前层对齐才并入上一项。
      if (/^\s+\S/.test(line) && listNode.lastElementChild) {
        const last = listNode.lastElementChild;
        last.append(document.createTextNode(" "));
        last.append(inlineNodes(line.trim()));
        index += 1;
        continue;
      }
      break;
    }
    const indent = match[1].length;
    const item = el("li", { className: "md-li" });
    const task = /^\[( |x|X)\]\s+/.exec(match[3]);
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      item.classList.add("md-task-item");
      item.append(el("span", { className: `md-task ${checked ? "md-task-on" : ""}`, text: checked ? "☑" : "☐" }));
      item.append(inlineNodes(match[3].slice(task[0].length)));
    } else {
      item.append(inlineNodes(match[3]));
    }
    while (indent < stack[stack.length - 1].indent && stack.length > 1) stack.pop();
    if (indent > stack[stack.length - 1].indent) {
      const parent = stack[stack.length - 1].node.lastElementChild;
      if (parent) {
        const sublist = el(/\d/.test(match[2]) ? "ol" : "ul", { className: "md-list" });
        parent.append(sublist);
        stack.push({ indent, node: sublist });
      }
    }
    stack[stack.length - 1].node.append(item);
    index += 1;
  }
  return { node: listNode, next: index };
}

function renderTable(lines, startIndex) {
  const header = lines[startIndex];
  const cells = (line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim());
  const table = el("table", { className: "md-table" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const cell of cells(header)) headRow.append(el("th", {}, inlineNodes(cell)));
  thead.append(headRow);
  table.append(thead);
  const tbody = el("tbody");
  let index = startIndex + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    const row = el("tr");
    for (const cell of cells(lines[index])) row.append(el("td", {}, inlineNodes(cell)));
    tbody.append(row);
    index += 1;
  }
  table.append(tbody);
  return { node: table, next: index };
}

function renderBlocks(text) {
  const root = el("div", { className: "md" });
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const closer = new RegExp(`^\\s{0,3}\\${marker}{3,}\\s*$`);
      const body = [];
      index += 1;
      while (index < lines.length && !closer.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      root.append(codeBlock(body.join("\n"), fence[2]));
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      root.append(el(`h${heading[1].length}`, {}, inlineNodes(heading[2].replace(/\s+#+\s*$/, ""))));
      index += 1;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      root.append(el("hr"));
      index += 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      const quote = el("blockquote", { className: "md-quote" });
      quote.append(renderBlocks(body.join("\n")));
      root.append(quote);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[index + 1])) {
      const table = renderTable(lines, index);
      root.append(table.node);
      index = table.next;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, index);
      root.append(list.node);
      index = list.next;
      continue;
    }
    // 段落：连续非空、且不是块起始的行。
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraphNode = el("p", { className: "md-p" });
    paragraphLines.forEach((value, position) => {
      if (position > 0) paragraphNode.append(el("br"));
      paragraphNode.append(inlineNodes(value));
    });
    root.append(paragraphNode);
  }
  return root;
}

/**
 * 渲染 Markdown 文本，返回可插入的节点。
 * 助手回答里的 `:codex-annotation{index="N"}` 会渲染成编号标记（与桌面端一致），
 * 而不是把原始指令留在正文里。
 * @param {string} text
 * @returns {Promise<HTMLElement>}
 */
export async function renderMarkdown(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  if (!value.trim()) return el("div", { className: "md" });
  const fromLibraries = await renderWithLibraries(value);
  const node = fromLibraries || renderBlocks(value);
  node.classList.add("md");
  replaceAnnotationMarkers(node);
  return node;
}

/** 同步版本：先给内置渲染结果，流式过程中使用（库就绪后由调用方决定是否替换）。 */
export function renderMarkdownSync(text) {
  const node = renderBlocks(typeof text === "string" ? text : String(text ?? ""));
  replaceAnnotationMarkers(node);
  return node;
}

function replaceAnnotationMarkers(root) {
  if (!root || !root.textContent || !root.textContent.includes(":codex-annotation{")) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeValue && node.nodeValue.includes(":codex-annotation{")) targets.push(node);
  }
  for (const node of targets) {
    const segments = splitAnnotationMarkers(node.nodeValue);
    if (segments.length <= 1 && (!segments[0] || segments[0].kind === "text")) continue;
    const frag = document.createDocumentFragment();
    for (const segment of segments) {
      if (segment.kind === "text") frag.append(document.createTextNode(segment.value));
      else frag.append(el("span", { className: "annotation-marker", text: String(segment.index) }));
    }
    node.replaceWith(frag);
  }
}

export { iconButton };
