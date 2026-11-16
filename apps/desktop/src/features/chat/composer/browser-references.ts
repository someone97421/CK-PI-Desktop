import {
  BROWSER_REFERENCE_PLUGIN_ID,
  browserReferenceFromSend,
  browserReferenceMark,
  parseBrowserReference,
  type BrowserReference,
  type BrowserReferenceTab,
} from "@pi-desktop/shared";
import type { ComposerFileReference } from "./model";

export function checkedBrowserReferenceMark(value: unknown) {
  const reference = parseBrowserReference(value);
  if (!reference) throw new Error("浏览器引用内容无效");
  const mark = browserReferenceMark(reference);
  if (!mark.label || Array.from(mark.label).length > 64) throw new Error("浏览器引用标签超过 64 字符");
  if (new TextEncoder().encode(mark.send).byteLength > 32 * 1024) {
    throw new Error("浏览器引用超过 32 KiB，请缩小选文或元素范围后重试");
  }
  return { pluginId: BROWSER_REFERENCE_PLUGIN_ID, ...mark };
}

export function browserReferenceForChip(reference: ComposerFileReference): BrowserReference | null {
  return reference.plugin?.kind === "mark" && reference.plugin.pluginId === BROWSER_REFERENCE_PLUGIN_ID
    ? browserReferenceFromSend(reference.plugin.send) : null;
}

export function browserReferenceTooltip(reference: BrowserReference): string {
  const lines = [reference.title, reference.url];
  if (reference.kind === "selection") lines.push("选文", reference.selection ?? "");
  if (reference.element) {
    const element = reference.element;
    lines.push("DOM 元素", `${element.tag}${element.role ? ` · ${element.role}` : ""}`,
      element.name, element.locator, element.text, ...element.attributes,
      element.context, element.html, element.size, element.pageTitle, element.pageUrl);
  }
  if (reference.frameUrl && reference.frameUrl !== reference.url) lines.push(reference.frameUrl);
  return lines.filter(Boolean).join("\n");
}

export function filterBrowserReferenceTabs(tabs: readonly BrowserReferenceTab[], query: string): BrowserReferenceTab[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return tabs.filter(tab => {
    const haystack = `${tab.title}\n${tab.url}`.toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

export function clampBrowserInsertionRange(range: { start: number; end: number } | null, length: number) {
  const start = Math.max(0, Math.min(range?.start ?? length, length));
  return { start, end: Math.max(start, Math.min(range?.end ?? length, length)) };
}

export function browserInsertionReferences(references: readonly ComposerFileReference[], text: string, sessionId: string) {
  return references.filter(reference => reference.sessionId !== sessionId || !reference.token || text.includes(reference.token));
}
