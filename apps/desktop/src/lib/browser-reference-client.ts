import { useEffect, useState } from "react";
import {
  IPC,
  type BrowserReferenceClient,
  type BrowserReferenceInsertion,
  type BrowserReferenceTab,
} from "@pi-desktop/shared";

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge) throw new Error("浏览器引用连接不可用");
  const result = await (input === undefined ? bridge.invoke<T>(channel) : bridge.invoke<T>(channel, input));
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export const browserReferenceClient = {
  register: (client: BrowserReferenceClient) =>
    invoke<{ registered: boolean }>(IPC.invoke.browserReferencesClient, client),
  claim: (input: { requestId: string; clientId: string; draftKey: string }) =>
    invoke<{ accepted: boolean }>(IPC.invoke.browserReferencesClaim, input),
  acknowledge: (input: {
    requestId: string; clientId: string; draftKey: string; ok: boolean; error?: string;
  }) => invoke<{ accepted: boolean }>(IPC.invoke.browserReferencesAcknowledge, input),
  onInsertion: (listener: (insertion: BrowserReferenceInsertion) => void) =>
    window.piDesktop?.on(IPC.event.browserReferenceInsertRequested, payload => {
      if (payload && typeof payload === "object") listener(payload as BrowserReferenceInsertion);
    }) ?? (() => undefined),
};

export function useBrowserReferenceTabs(): BrowserReferenceTab[] {
  const [tabs, setTabs] = useState<BrowserReferenceTab[]>([]);
  useEffect(() => {
    let live = true;
    let changed = false;
    const unsubscribe = window.piDesktop?.on(IPC.event.browserReferencesChanged, payload => {
      const next = (payload as { tabs?: BrowserReferenceTab[] } | undefined)?.tabs;
      if (Array.isArray(next)) {
        changed = true;
        if (live) setTabs(next);
      }
    });
    void invoke<{ tabs: BrowserReferenceTab[] }>(IPC.invoke.browserReferencesGet).then(result => {
      if (live && !changed && Array.isArray(result.tabs)) setTabs(result.tabs);
    }).catch(() => undefined);
    return () => { live = false; unsubscribe?.(); };
  }, []);
  return tabs;
}
