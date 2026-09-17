/**
 * 引用与批注的文本组合（与桌面端同一格式）。
 *
 * 桌面端把引用和批注都实现成「写进输入框的 Markdown 文本」，宿主没有对应 op；
 * 手机端沿用同一格式，组合后走 `chat.send`。格式来源：
 *   apps/desktop/src/lib/chat-quotes.ts
 *   apps/desktop/src/lib/response-annotations.ts
 */

export const MAX_QUOTE_CHARS = 2000;
export const MAX_ANNOTATION_CHARS = 2000;

export const ANNOTATION_BLOCK_HEADING = "# Response annotations:";
export const ANNOTATION_BLOCK_OPEN = "<response-annotations>";
export const ANNOTATION_BLOCK_CLOSE = "</response-annotations>";
export const ANNOTATION_REQUEST_HEADING = "## My request:";
export const ANNOTATION_INSTRUCTION =
  'Each item contains text selected from an earlier assistant response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.';

const MARKER_TOKEN = /:codex-annotation\{index="(\d+)"\}/g;

/** 截断到上限，且不切开代理对。 */
export function excerpt(text, limit) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (normalized.length <= limit) return normalized;
  const cut = normalized.slice(0, limit);
  const whole = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return `${whole.trimEnd()}…`;
}

export function quoteExcerpt(text, selection = "", limit = MAX_QUOTE_CHARS) {
  const source = String(selection || "").trim() ? selection : text;
  return excerpt(source, limit);
}

/** `> ` 前缀的 Markdown 引用块 + 出处行。 */
export function buildQuoteText(excerptText, attribution) {
  const body = excerpt(excerptText, MAX_QUOTE_CHARS)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return `${body}\n\n${attribution}`;
}

export function quoteAttribution(sessionTitle, messageCreatedAt) {
  const title = String(sessionTitle || "").trim() || "会话";
  return `引用自 ${title}`;
}

/** 引用追加到草稿，绝不覆盖用户已经输入的内容。 */
export function appendQuoteToDraft(draftText, quote) {
  const existing = String(draftText || "").replace(/\s+$/, "");
  return existing ? `${existing}\n\n${quote}` : quote;
}

/** 批注条目 → 线上载荷（与桌面端 annotationPayload 一致）。 */
function annotationPayload(annotation) {
  return {
    text: annotation.text,
    annotation: annotation.annotation || "",
    source: { messageId: annotation.messageId },
  };
}

/** 批注集合 → 提交给模型的 prompt（块 + 请求）。 */
export function responseAnnotationPrompt(content, annotations) {
  if (!annotations || !annotations.length) return content;
  return [
    ANNOTATION_BLOCK_HEADING,
    ANNOTATION_INSTRUCTION,
    ANNOTATION_BLOCK_OPEN,
    JSON.stringify(annotations.map(annotationPayload)),
    ANNOTATION_BLOCK_CLOSE,
    "",
    ANNOTATION_REQUEST_HEADING,
    content,
  ].join("\n");
}

/** 从回显的 prompt 里还原用户请求（转录只展示请求本身）。 */
export function requestTextWithoutAnnotations(prompt) {
  const text = String(prompt ?? "");
  if (!text.startsWith(`${ANNOTATION_BLOCK_HEADING}\n`)) return text;
  const heading = `\n${ANNOTATION_REQUEST_HEADING}\n`;
  const index = text.lastIndexOf(heading);
  if (index === -1) {
    return text.endsWith(`\n${ANNOTATION_REQUEST_HEADING}`) ? "" : text;
  }
  return text.slice(index + heading.length);
}

/**
 * 把 `:codex-annotation{index="N"}` 拆成片段，渲染成编号标记而不是原始指令。
 * @returns {Array<{kind:"text"|"marker", value?:string, index?:number}>}
 */
export function splitAnnotationMarkers(text) {
  const value = String(text ?? "");
  const segments = [];
  let cursor = 0;
  for (const match of value.matchAll(MARKER_TOKEN)) {
    const at = match.index ?? 0;
    if (at > cursor) segments.push({ kind: "text", value: value.slice(cursor, at) });
    segments.push({ kind: "marker", index: Number(match[1]) });
    cursor = at + match[0].length;
  }
  if (cursor < value.length) segments.push({ kind: "text", value: value.slice(cursor) });
  return segments;
}

export function hasAnnotationMarkers(text) {
  MARKER_TOKEN.lastIndex = 0;
  return MARKER_TOKEN.test(String(text ?? ""));
}

/** 已经带标记的文本里，把标记换成一个可见的编号占位（纯文本场景）。 */
export function annotationMarkerLabel(index) {
  return `[${index}]`;
}
