export interface BrowserElementInfo {
  tag: string;
  role: string;
  name: string;
  locator: string;
  text: string;
  attributes: string[];
  context: string;
  html: string;
  pageTitle: string;
  pageUrl: string;
  size: string;
}

export interface BrowserReference {
  kind: "page" | "selection" | "element";
  tabId: number;
  windowId?: number;
  title: string;
  url: string;
  selection?: string;
  frameId?: number;
  frameUrl?: string;
  element?: BrowserElementInfo;
}

export type BrowserReferenceTab = BrowserReference & { kind: "page"; sourceId: string };
export type BrowserReferenceClient = { clientId: string; draftKey: string; available: boolean; focused?: boolean; revision?: number };
export type BrowserReferenceInsertion = { requestId: string; clientId: string; draftKey: string; reference: BrowserReference; expiresAt: number };
export const BROWSER_REFERENCE_PLUGIN_ID = "local.lan-remote-control";
const PREFIX = "[浏览器引用:";

export function parseBrowserReference(value: unknown): BrowserReference | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!["page", "selection", "element"].includes(String(item.kind)) || !Number.isInteger(item.tabId)
    || typeof item.title !== "string" || typeof item.url !== "string") return null;
  if (item.kind === "selection" && (typeof item.selection !== "string" || !item.selection.trim())) return null;
  let element: BrowserElementInfo | undefined;
  if (item.kind === "element") {
    if (!item.element || typeof item.element !== "object") return null;
    const source = item.element as Record<string, unknown>;
    const keys = ["tag", "role", "name", "locator", "text", "context", "html", "pageTitle", "pageUrl", "size"] as const;
    if (keys.some(key => typeof source[key] !== "string") || !Array.isArray(source.attributes)
      || source.attributes.some(attribute => typeof attribute !== "string")) return null;
    element = Object.fromEntries(keys.map(key => [key, source[key]])) as Omit<BrowserElementInfo, "attributes"> as BrowserElementInfo;
    element.attributes = [...source.attributes] as string[];
  }
  return {
    kind: item.kind as BrowserReference["kind"], tabId: item.tabId as number, title: item.title, url: item.url,
    ...(Number.isInteger(item.windowId) ? { windowId: item.windowId as number } : {}),
    ...(Number.isInteger(item.frameId) ? { frameId: item.frameId as number } : {}),
    ...(typeof item.frameUrl === "string" ? { frameUrl: item.frameUrl } : {}),
    ...(item.kind === "selection" ? { selection: item.selection as string } : {}),
    ...(element ? { element } : {}),
  };
}

export function browserReferenceMark(reference: BrowserReference): { label: string; send: string } {
  const title = reference.title.trim() || reference.url || "未命名页面";
  const description = reference.kind === "page" ? title
    : reference.kind === "selection" ? reference.selection || title
    : reference.element?.name || reference.element?.locator || title;
  const kind = { page: "页面", selection: "选文", element: "DOM" }[reference.kind];
  const text = description.replace(/[\uE000-\uF8FF\uFFFC]/g, "").replace(/\s+/g, " ");
  const label = `${kind} · ${Array.from(text).slice(0, 56).join("")}`;
  const data = JSON.stringify(reference, null, 2).replace(/[\uE000-\uF8FF\uFFFC]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const send = `${PREFIX}${reference.kind}]\n${data}`;
  if (new TextEncoder().encode(send).byteLength > 32 * 1024) {
    throw new Error("浏览器引用内容超过 32 KiB，请缩小选取范围后重试。");
  }
  return { label, send };
}

export function browserReferenceFromSend(send: string): BrowserReference | null {
  if (!send.startsWith(PREFIX)) return null;
  const newline = send.indexOf("\n");
  if (newline < 0) return null;
  try { return parseBrowserReference(JSON.parse(send.slice(newline + 1))); } catch { return null; }
}
