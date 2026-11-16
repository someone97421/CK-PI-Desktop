import { randomUUID } from "node:crypto";
import {
  IPC, browserReferenceMark, parseBrowserReference,
  type BrowserReferenceClient, type BrowserReferenceInsertion, type BrowserReferenceTab,
} from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";

type Client = BrowserReferenceClient & { connectionId?: string; revision?: number; seenAt: number; focusedAt: number };
type Source = { tabs: BrowserReferenceTab[]; browserId: string; seenAt: number };
type Pending = {
  clientId: string; draftKey: string; expiresAt: number;
  resolve: (value: { inserted: true; clientId: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrowserReferenceBroker {
  private readonly sources = new Map<string, Source>();
  private readonly closedConnections = new Set<string>();
  private readonly clients = new Map<string, Client>();
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private focusSequence = 0;
  private snapshotKey = "";

  constructor(
    private readonly publish: (channel: string, payload: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  private currentSnapshot() {
    const tabs = new Map<string, BrowserReferenceTab>();
    const browsers = new Set<string>();
    for (const source of [...this.sources.values()].reverse().sort((a, b) => b.seenAt - a.seenAt)) {
      if (browsers.has(source.browserId)) continue;
      browsers.add(source.browserId);
      for (const tab of source.tabs) {
        const key = `${source.browserId}\0${tab.tabId}`;
        if (!tabs.has(key)) tabs.set(key, tab);
      }
    }
    return { tabs: [...tabs.values()] };
  }

  snapshot() { this.sweep(); return this.currentSnapshot(); }

  private publishSnapshot() {
    const snapshot = this.currentSnapshot();
    const key = JSON.stringify(snapshot);
    if (key !== this.snapshotKey) {
      this.snapshotKey = key;
      this.publish(IPC.event.browserReferencesChanged, snapshot);
    }
    return snapshot;
  }

  update(input: { sourceId: string; active: boolean; tabs?: unknown[]; browserId?: string; closed?: boolean }) {
    if (typeof input?.sourceId !== "string" || !input.sourceId) throw new Error("浏览器连接标识无效");
    if (input.closed) {
      this.closedConnections.add(input.sourceId);
      this.removeConnectionClients(input.sourceId, "浏览器侧边栏连接已断开");
    }
    if (!input.active || input.closed) this.sources.delete(input.sourceId);
    else if (!this.closedConnections.has(input.sourceId)) {
      if (!Array.isArray(input.tabs)) throw new Error("浏览器标签页列表无效");
      const tabs = new Map<number, BrowserReferenceTab>();
      for (const value of input.tabs) {
        const reference = parseBrowserReference(value);
        if (reference?.kind === "page") tabs.set(reference.tabId, { ...reference, kind: "page", sourceId: input.sourceId });
      }
      this.sources.delete(input.sourceId);
      this.sources.set(input.sourceId, {
        tabs: [...tabs.values()], seenAt: this.now(), browserId: input.browserId || input.sourceId,
      });
    }
    return this.publishSnapshot();
  }

  client(input: BrowserReferenceClient & { connectionId?: string; revision?: number }) {
    if (!input || typeof input.clientId !== "string" || typeof input.draftKey !== "string") throw new Error("Agent 输入框标识无效");
    this.sweep();
    if (input.connectionId && this.closedConnections.has(input.connectionId)) throw new Error("浏览器连接已关闭");
    if (typeof input.revision === "number") {
      if (input.revision <= (this.revisions.get(input.clientId) ?? -1)) return { registered: this.clients.has(input.clientId) };
      this.revisions.set(input.clientId, input.revision);
    }
    const previous = this.clients.get(input.clientId);
    if (!input.available) {
      if (!previous || previous.draftKey === input.draftKey) this.removeClient(input.clientId, "Agent 输入框已关闭或暂不可编辑");
      return { registered: this.clients.has(input.clientId) };
    }
    if (previous && previous.draftKey !== input.draftKey) this.removeClient(input.clientId, "Agent 已切换会话，请重新发送引用");
    const sameDraft = previous?.draftKey === input.draftKey;
    this.clients.set(input.clientId, {
      clientId: input.clientId, draftKey: input.draftKey, available: true,
      ...(typeof input.connectionId === "string" ? { connectionId: input.connectionId } : {}),
      seenAt: this.now(), focusedAt: input.focused ? ++this.focusSequence : sameDraft ? previous?.focusedAt ?? 0 : 0,
    });
    return { registered: true };
  }

  insert(input: { reference: unknown; connectionId?: string }): Promise<{ inserted: true; clientId: string }> {
    const reference = parseBrowserReference(input?.reference);
    if (!reference) return Promise.reject(new Error("浏览器引用无效"));
    try { browserReferenceMark(reference); } catch (error) { return Promise.reject(error); }
    this.sweep();
    if (!this.sources.size) return Promise.reject(new Error("请先打开并登录浏览器侧边栏"));
    const client = [...this.clients.values()]
      .filter(item => input.connectionId ? item.connectionId === input.connectionId : item.focusedAt > 0)
      .sort((a, b) => b.focusedAt - a.focusedAt || b.seenAt - a.seenAt)[0];
    if (!client) return Promise.reject(new Error("请先在 Agent 输入框中放置光标，再发送浏览器引用"));
    const requestId = randomUUID();
    const expiresAt = this.now() + 8_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Agent 未确认插入，请检查目标输入框后重试"));
      }, 8_000);
      timer.unref?.();
      this.pending.set(requestId, { clientId: client.clientId, draftKey: client.draftKey, expiresAt, resolve, reject, timer });
      const request: BrowserReferenceInsertion & { connectionId?: string; expiresAt: number } = {
        requestId, clientId: client.clientId, draftKey: client.draftKey, reference, expiresAt,
        ...(client.connectionId ? { connectionId: client.connectionId } : {}),
      };
      try { this.publish(IPC.event.browserReferenceInsertRequested, request); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  claim(input: { requestId: string; clientId: string; draftKey: string }) {
    const pending = input && this.pending.get(input.requestId);
    return { accepted: !!pending && pending.clientId === input.clientId
      && pending.draftKey === input.draftKey && this.now() < pending.expiresAt };
  }

  acknowledge(input: { requestId: string; clientId: string; draftKey: string; ok: boolean; error?: string }) {
    const pending = input && this.pending.get(input.requestId);
    if (!pending || pending.clientId !== input.clientId || pending.draftKey !== input.draftKey) return { accepted: false };
    clearTimeout(pending.timer);
    this.pending.delete(input.requestId);
    if (this.now() > pending.expiresAt) pending.reject(new Error("引用插入确认已超时，请检查目标草稿"));
    else if (input.ok) pending.resolve({ inserted: true, clientId: pending.clientId });
    else pending.reject(new Error(input.error || "Agent 无法插入当前引用"));
    return { accepted: true };
  }

  private removeClient(id: string, message: string) {
    this.clients.delete(id);
    for (const [requestId, pending] of this.pending) {
      if (pending.clientId !== id) continue;
      clearTimeout(pending.timer); this.pending.delete(requestId); pending.reject(new Error(message));
    }
  }

  private removeConnectionClients(connectionId: string, message: string) {
    for (const [id, client] of this.clients) if (client.connectionId === connectionId) this.removeClient(id, message);
  }

  sweep() {
    for (const [id, client] of this.clients) if (this.now() - client.seenAt > 20_000) this.removeClient(id, "Agent 输入框连接已失效");
    let changed = false;
    for (const [id, source] of this.sources) {
      if (this.now() - source.seenAt <= 45_000) continue;
      this.sources.delete(id); changed = true;
      this.removeConnectionClients(id, "浏览器侧边栏状态已过期");
    }
    if (changed) this.publishSnapshot();
  }
}

export function registerBrowserReferenceIpc({ registrar, sendToRenderer }: {
  registrar: IpcRegistrar;
  sendToRenderer: (channel: string, payload: unknown) => void;
}) {
  const broker = new BrowserReferenceBroker(sendToRenderer);
  registrar.handle(IPC.invoke.browserReferencesGet, async () => broker.snapshot());
  registrar.handle(IPC.invoke.browserReferencesUpdate, async input => broker.update(input));
  registrar.handle(IPC.invoke.browserReferencesClient, async input => broker.client(input));
  registrar.handle(IPC.invoke.browserReferencesInsert, async input => broker.insert(input));
  registrar.handle(IPC.invoke.browserReferencesClaim, async input => broker.claim(input));
  registrar.handle(IPC.invoke.browserReferencesAcknowledge, async input => broker.acknowledge(input));
  const cleanup = setInterval(() => broker.sweep(), 5000);
  cleanup.unref?.();
  return broker;
}
