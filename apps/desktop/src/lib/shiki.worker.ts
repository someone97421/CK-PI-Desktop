import { ensureLang, tokenizeIncremental, type LineCache } from "./shiki-engine.ts";
import type { HighlightCommand, HighlightReply } from "./shiki-protocol.ts";

// 语法状态含引擎对象，始终留在 Worker 内，只传回可克隆的 token。
const caches = new Map<string, LineCache>();
const released = new Set<string>();
let activeOwner: string | null = null;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<HighlightCommand>) => void;
  postMessage: (reply: HighlightReply) => void;
};

scope.onmessage = async ({ data }) => {
  if (data.type === "release") {
    caches.delete(data.owner);
    if (activeOwner === data.owner) released.add(data.owner);
    return;
  }
  activeOwner = data.owner;
  try {
    await ensureLang(data.lang);
    scope.postMessage({ type: "loaded", id: data.id });
    const cache = tokenizeIncremental(caches.get(data.owner) ?? null, data.code, data.lang, data.theme);
    caches.delete(data.owner);
    if (cache && !released.has(data.owner)) caches.set(data.owner, cache);
    // 限制已卸载或大量代码块的语法状态占用，淘汰后可从原文重建。
    let size = 0;
    for (const entry of caches.values()) {
      for (const line of entry.lines) size += line.length + 1;
    }
    while (caches.size > 32 || size > 512 * 1024) {
      const oldest = caches.keys().next().value!;
      for (const line of caches.get(oldest)!.lines) size -= line.length + 1;
      caches.delete(oldest);
    }
    scope.postMessage({ type: "result", id: data.id, tokens: cache?.tokens ?? null });
  } catch {
    caches.delete(data.owner);
    scope.postMessage({ type: "result", id: data.id, tokens: null });
  } finally {
    released.delete(data.owner);
    activeOwner = null;
  }
};
