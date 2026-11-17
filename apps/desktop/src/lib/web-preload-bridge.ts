import { IPC, parseBrowserReference, type BrowserReference, type Result } from "@pi-desktop/shared";
import { createLanPasswordGate } from "./lan-password-gate";
import type { FileMenuContext } from "./file-menu-extension";

declare global {
  interface Window {
    __piDesktopInsertPromptText?: (text: string) => boolean;
    __piDesktopResourceUrl?: (url: string) => string;
    __piDesktopBrowseAction?: (method: BrowseMethod) => Promise<unknown>;
    __piDesktopBrowseStatus?: BrowseStatus;
  }
}

type BrowseMethod = "toggleAttach" | "insertCurrent" | "handoff";
type BrowseStatus = {
  authenticated: boolean;
  online: boolean;
  busy: boolean;
  borrowed: boolean;
  browserContext: string | null;
};
type Listener = (...args: unknown[]) => void;
type RemoteStatus = { authenticated: boolean; online: boolean; canCompose: boolean };
const TOKEN_KEY = "lan-remote-control.token";

export function webRemoteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function trustedExtensionOrigin(value: string | null): string | null {
  return value && /^chrome-extension:\/\/[a-p]{32}$/.test(value) ? value : null;
}

export async function initializeWebPreloadBridge(): Promise<void> {
  if (window.piDesktop) return;
  document.documentElement.dataset.webRemote = "true";
  document.documentElement.dataset.platform = "linux";
  document.documentElement.dataset.theme = "dark";
  // HTTP 局域网页面也使用同一 UUID 实现。
  if (typeof crypto.randomUUID !== "function") {
    Object.defineProperty(crypto, "randomUUID", { value: webRemoteId, configurable: true });
  }
  const params = new URLSearchParams(location.search);
  const server = new URL(params.get("server") || location.origin);
  if (!/^https?:$/.test(server.protocol) || server.username || server.password || server.pathname !== "/" || server.search || server.hash) {
    throw new Error("无效的服务地址");
  }
  const origin = server.origin;
  const parentOrigin = trustedExtensionOrigin(params.get("parentOrigin"));
  const extensionSession = parentOrigin !== null && parent !== window &&
    (server.hostname === "localhost" || server.hostname === "[::1]" || /^127\./.test(server.hostname));
  const storageKey = origin === location.origin ? TOKEN_KEY : `${TOKEN_KEY}:${origin}`;
  const readStored = (key: string) => {
    try { return localStorage.getItem(key) || sessionStorage.getItem(key) || ""; } catch { return ""; }
  };
  let token = extensionSession ? "" : readStored(storageKey);
  const resourceProtocol = /^(pi-genui|plugin-renderer|plugin-asset|appearance-media):\/\//;
  const resourceUrl = (value: string): string => {
    if (!resourceProtocol.test(value)) return value;
    try {
      const url = new URL(value);
      return `${origin}/api/resource/${encodeURIComponent(token)}/${url.protocol.slice(0, -1)}/${url.hostname}${url.pathname}${url.search}${url.hash}`;
    } catch { return value; }
  };
  window.__piDesktopResourceUrl = resourceUrl;
  const resourceString = (value: string): string => {
    if (resourceProtocol.test(value)) return resourceUrl(value);
    return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)/gi, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const url = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (!resourceProtocol.test(url)) return match;
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
      return `url(${quote}${resourceUrl(url)}${quote})`;
    });
  };
  const resourceData = <T,>(value: T): T => {
    if (typeof value === "string") return resourceString(value) as T;
    if (Array.isArray(value)) return value.map((item) => resourceData(item)) as T;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resourceData(item)])) as T;
    }
    return value;
  };
  const storeToken = (value: string) => {
    token = value;
    if (extensionSession) return;
    for (const storage of [() => localStorage, () => sessionStorage]) {
      try { value ? storage().setItem(storageKey, value) : storage().removeItem(storageKey); } catch { /* 当前页仍可使用内存令牌。 */ }
    }
  };
  const status: RemoteStatus = { authenticated: false, online: false, canCompose: false };
  let rendererReady = !parentOrigin;
  let initialDraftKey = "", composerDraftKey = "";
  const browseStatus: BrowseStatus = { authenticated: false, online: false, busy: false, borrowed: false, browserContext: null };
  const browsePending = new Map<string, { method: BrowseMethod; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const post = (message: unknown) => {
    if (parentOrigin && parent !== window) parent.postMessage(message, parentOrigin);
  };
  const publishBrowseStatus = () => {
    browseStatus.authenticated = status.authenticated;
    browseStatus.online = status.online;
    window.__piDesktopBrowseStatus = { ...browseStatus };
    window.dispatchEvent(new CustomEvent("pi-desktop:browse-status", { detail: { ...browseStatus } }));
  };
  const browseAction = (method: BrowseMethod): Promise<unknown> => new Promise((resolve, reject) => {
    if (!parentOrigin || parent === window) { reject(new Error("当前页面不在 Chrome 侧栏中")); return; }
    const requestId = webRemoteId();
    browsePending.set(requestId, { method, resolve, reject });
    post({ type: "pi-desktop:browse-request", requestId, method });
  });
  if (parentOrigin) window.__piDesktopBrowseAction = browseAction;
  const publishStatus = () => post({ type: "pi-desktop:remote-status", ...status, initialDraftKey, draftKey: composerDraftKey, canCompose: rendererReady && status.authenticated && status.online && status.canCompose });
  window.addEventListener("pi-desktop:sidepanel-ready", (event) => {
    initialDraftKey = (event as CustomEvent<{ draftKey: string }>).detail?.draftKey ?? "";
    rendererReady = !!initialDraftKey && composerDraftKey === initialDraftKey;
    publishStatus();
  });
  window.addEventListener("pi-desktop:composer-ready", (event) => {
    const detail = (event as CustomEvent<{ canCompose: boolean; draftKey: string }>).detail;
    composerDraftKey = detail?.draftKey ?? "";
    status.canCompose = detail?.canCompose === true;
    if (initialDraftKey && status.canCompose) rendererReady = true;
    publishStatus();
    publishBrowseStatus();
  });
  const desktopPresentationEvents = new Set<string>([
    IPC.event.temporaryWorkspacePending, IPC.event.pluginLauncherShown,
    IPC.event.browserOpenFile, IPC.event.pluginViewReveal, IPC.event.pluginComposerSuggestion,
    IPC.event.windowMaximized, IPC.event.windowFullScreen, IPC.event.windowWorkPanelResize,
    IPC.event.closePrompt, IPC.event.lifecycleDialogRequest, IPC.event.lifecycleDialogDismiss,
    IPC.event.menuCommand, IPC.event.traySessionActivated,
    IPC.event.notificationActivated, IPC.event.notificationSound,
  ]);
  const listeners = new Map<string, Set<Listener>>();
  const buffered = new Map<string, unknown[][]>();
  const emit = (channel: string, args: unknown[]) => {
    if (desktopPresentationEvents.has(channel)) return;
    args = resourceData(args);
    const entries = listeners.get(channel);
    if (entries?.size) for (const listener of entries) listener(...args);
    else {
      const events = buffered.get(channel) ?? [];
      events.push(args);
      buffered.set(channel, events.slice(-100));
    }
  };
  let socket: WebSocket | undefined;
  let connectionId = "";
  let browserTabs: { active: boolean; tabs: BrowserReference[]; browserId?: string } = { active: false, tabs: [] };
  const publishBrowserTabs = () => {
    if (parentOrigin && status.online && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "browser-context", ...browserTabs }));
    }
  };
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0, lastMessage = 0, mounted = false, expired = false;
  let requestingExtension = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const expire = () => {
    if (expired) return;
    expired = !extensionSession;
    storeToken("");
    status.authenticated = false; status.online = false;
    if (!extensionSession) status.canCompose = false;
    connectionId = "";
    publishStatus(); publishBrowseStatus();
    buffered.delete(IPC.event.browserReferenceInsertRequested);
    emit(IPC.event.browserReferencesChanged, [{ tabs: [] }]);
    const previous = socket;
    socket = undefined;
    previous?.close();
    if (retry) clearTimeout(retry);
    if (extensionSession) void connectExtension();
    else location.reload();
  };
  const bridgeError = (code: string, message: string) => Object.assign(new Error(message), { code });
  const request = async (path: string, init: RequestInit, authenticated = true, binary = false): Promise<any> => {
    const requestToken = token;
    const headers = new Headers(init.headers);
    if (authenticated) {
      if (!token) throw bridgeError("UNAUTHORIZED", "请先登录");
      headers.set("Authorization", `Bearer ${token}`);
    }
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, { ...init, headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw bridgeError(timedOut ? "TIMEOUT" : "NETWORK_ERROR", timedOut ? "请求超时" : "无法连接主机");
    }
    if (response.status === 401 && authenticated) {
      if (token === requestToken) expire();
      throw bridgeError("UNAUTHORIZED", "登录已失效");
    }
    if (response.ok && binary) return response;
    let result: any;
    try { result = await response.json(); }
    catch { throw bridgeError(response.ok ? "INVALID_RESPONSE" : `HTTP_${response.status}`, `主机响应无效 (${response.status})`); }
    if (!response.ok) throw bridgeError(
      typeof result?.error?.code === "string" ? result.error.code : `HTTP_${response.status}`,
      typeof result?.error?.message === "string" ? result.error.message : `请求失败 (${response.status})`,
    );
    return result;
  };
  const jsonRequest = (path: string, body: unknown, authenticated = true) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, authenticated);
  window.__piDesktopReadRemoteFile = async (context: FileMenuContext) => {
    const response: Response = await request("/api/file", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(context),
    }, true, true);
    const name = decodeURIComponent(response.headers.get("X-File-Name") || "download");
    const mimeType = response.headers.get("Content-Type") || "application/octet-stream";
    const previewPath = response.headers.get("X-File-Preview");
    return { blob: await response.blob(), name, mimeType, ...(previewPath?.startsWith("/api/file-view/") ? { previewUrl: `${origin}${previewPath}` } : {}) };
  };
  const picked = new Map<string, File[]>();
  const pick = (photos: boolean): Promise<Result<unknown>> => new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true;
    if (photos) input.accept = "image/*";
    input.hidden = true; document.body.append(input);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const files = Array.from(input.files ?? []);
      input.remove();
      if (!files.length) { resolve({ ok: true, data: { token: null, canceled: true } }); return; }
      const id = webRemoteId(); picked.set(id, files);
      resolve({ ok: true, data: { token: id, canceled: false } });
    };
    input.addEventListener("change", finish, { once: true });
    input.addEventListener("cancel", finish, { once: true });
    input.click();
  });
  const localPresentationChannels = new Set<string>([
    IPC.invoke.lifecycleDialogRespond, IPC.invoke.closePromptRespond,
    IPC.invoke.traySetSessionPreferences, IPC.invoke.pluginSessionActive,
    IPC.invoke.notificationSetViewingSession, IPC.invoke.notificationShowNative,
    IPC.invoke.pluginViewOpen, IPC.invoke.pluginViewClose,
    IPC.invoke.pluginViewSetBounds, IPC.invoke.pluginViewSetVisible,
    IPC.invoke.browserSetBounds, IPC.invoke.browserSetVisible,
  ]);
  window.piDesktop = {
    platform: "linux", channels: IPC, locale: navigator.language, getDroppedFilePath: () => null,
    on(channel, listener) {
      const entries = listeners.get(channel) ?? new Set<Listener>();
      entries.add(listener); listeners.set(channel, entries);
      const pending = buffered.get(channel);
      buffered.delete(channel);
      if (pending) queueMicrotask(() => { if (entries.has(listener)) for (const args of pending) listener(...args); });
      return () => { entries.delete(listener); };
    },
    async invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
      try {
        if (localPresentationChannels.has(channel)) return { ok: true, data: { ok: true, accepted: false } as T };
        if (channel === IPC.invoke.windowSetWorkPanelReservation) return { ok: true, data: { requested: 0, reserved: 0 } as T };
        if (channel === IPC.invoke.windowSetWorkPanelChatWidth) return { ok: true, data: { requested: 0, applied: 0 } as T };
        if (channel === IPC.invoke.windowSetBackgroundColor) return { ok: true, data: { applied: false, theme: document.documentElement.dataset.theme } as T };
        if (channel === IPC.invoke.windowControl || channel === IPC.invoke.nativeMenuAction) return { ok: true, data: { maximized: false, fullScreen: false, macosWindowTranslucency: false } as T };
        if (channel === IPC.invoke.menuRendererReady || channel === IPC.invoke.lifecycleDialogReady) return { ok: true, data: { ready: true } as T };
        if (channel === IPC.invoke.pluginLauncherToggle || channel === IPC.invoke.pluginLauncherDismiss) return { ok: true, data: { visible: false } as T };
        if (channel === IPC.invoke.pluginLauncherContentHeight) return { ok: true, data: { ok: true } as T };
        if (channel === IPC.invoke.workPanelTabMenu) return { ok: true, data: null as T };
        if (channel === IPC.invoke.temporaryWorkspaceTake) return { ok: true, data: { workspacePaths: [] } as T };
        if (channel === IPC.invoke.composerPickFiles || channel === IPC.invoke.composerPickPhotos) {
          return await pick(channel === IPC.invoke.composerPickPhotos) as Result<T>;
        }
        if (channel === IPC.invoke.composerReadClipboardDirectories) return { ok: true, data: null as T };
        if (channel === IPC.invoke.composerImportFiles) {
          const input = args[0] as { token?: string; sessionId?: string; draftId?: string } | undefined;
          if (!input || typeof input.token !== "string") throw bridgeError("INVALID_ARGUMENT", "缺少文件选择 token");
          if (!input.sessionId && !input.draftId) throw bridgeError("INVALID_ARGUMENT", "缺少附件所属会话或草稿");
          const files = picked.get(input.token);
          if (!files) throw bridgeError("NOT_FOUND", "文件选择已失效，请重新选择");
          const uploaded = [];
          try {
            for (const file of files) {
              const query = new URLSearchParams({ target: "renderer" });
              if (input.draftId) query.set("draftId", input.draftId);
              const result = await request(`/api/upload?${query}`, {
                method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name), ...(input.sessionId ? { "X-Session-Id": input.sessionId } : {}) }, body: file,
              });
              if (result?.ok === false) return result as Result<T>;
              const imported = result?.files ?? result?.result?.files ?? result?.data?.files;
              if (!Array.isArray(imported) || !imported.length) throw bridgeError("INVALID_RESPONSE", "附件导入响应无效");
              uploaded.push(...imported);
            }
            return { ok: true, data: { files: uploaded } as T };
          } finally { picked.delete(input.token); }
        }
        if (channel === IPC.invoke.composerPasteFiles) {
          const input = args[0] as { files?: Array<{ data: ArrayBuffer | string; [key: string]: unknown }> } | undefined;
          if (!input || !Array.isArray(input.files)) throw bridgeError("INVALID_ARGUMENT", "缺少粘贴文件");
          args = [{ ...input, files: input.files.map((file) => {
            if (typeof file.data === "string") return file;
            const bytes = new Uint8Array(file.data);
            let binary = "";
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return { ...file, data: btoa(binary) };
          }) }];
        }
        if (channel === IPC.invoke.browserReferencesClient && args[0] && typeof args[0] === "object") {
          if (!status.online || !connectionId) throw bridgeError("OFFLINE", "浏览器连接尚未就绪");
          args = [{ ...args[0], connectionId }, ...args.slice(1)];
        }
        const result = await jsonRequest("/api/ipc", { channel, args }) as Result<T>;
        return result.ok ? { ...result, data: resourceData(result.data) } : result;
      } catch (error) {
        const failure = error as { code?: unknown; message?: unknown } | null;
        return { ok: false, error: {
          code: typeof failure?.code === "string" ? failure.code : "INTERNAL",
          message: typeof failure?.message === "string" ? failure.message : String(error),
        } };
      }
    },
  };
  window.addEventListener("message", (event) => {
    if (!parentOrigin || event.source !== parent || event.origin !== parentOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "pi-desktop:status-request") { publishStatus(); return; }
    if (data.type === "pi-desktop:browser-tabs") {
      browserTabs = {
        active: data.active === true,
        ...(typeof data.browserId === "string" ? { browserId: data.browserId } : {}),
        tabs: Array.isArray(data.tabs) ? data.tabs.map(parseBrowserReference)
          .filter((tab: BrowserReference | null): tab is BrowserReference => tab?.kind === "page") : [],
      };
      publishBrowserTabs();
      return;
    }
    if (data.type === "pi-desktop:browse-status") {
      if (typeof data.authenticated === "boolean") browseStatus.authenticated = data.authenticated;
      if (typeof data.online === "boolean") browseStatus.online = data.online;
      if (typeof data.busy === "boolean") browseStatus.busy = data.busy;
      if (typeof data.borrowed === "boolean") browseStatus.borrowed = data.borrowed;
      browseStatus.browserContext = typeof data.browserContext === "string" ? data.browserContext : null;
      window.__piDesktopBrowseStatus = { ...browseStatus };
      window.dispatchEvent(new CustomEvent("pi-desktop:browse-status", { detail: { ...browseStatus } }));
      return;
    }
    if (data.type === "pi-desktop:browse-response" && typeof data.requestId === "string") {
      const pending = browsePending.get(data.requestId);
      if (!pending) return;
      browsePending.delete(data.requestId);
      if (data.ok !== true) { pending.reject(new Error(typeof data.error === "string" ? data.error : "Browse 操作失败")); return; }
      const result = data.result;
      const browserContext = result && typeof result === "object" && typeof result.browserContext === "string" ? result.browserContext : null;
      if (pending.method === "insertCurrent" && result?.inserted !== true && (!browserContext || !window.__piDesktopInsertPromptText?.(browserContext))) {
        pending.reject(new Error("当前页面无法编辑草稿"));
        return;
      }
      pending.resolve(result);
      return;
    }
    if (data.type !== "pi-desktop:request" || typeof data.requestId !== "string") return;
    const reply = (body: object) => post({ type: "pi-desktop:response", requestId: data.requestId, ...body });
    void (async () => {
      if (!status.authenticated || !status.online) throw new Error("请先登录并等待连接就绪");
      if (data.method === "browser.insertReference") {
        const reference = parseBrowserReference(data.reference);
        if (!reference || !browserTabs.active || !connectionId) throw new Error("浏览器引用或侧边栏状态无效，请重新打开侧边栏后重试");
        const targetConnectionId = connectionId;
        const targetDraftKey = typeof data.draftKey === "string" ? data.draftKey : composerDraftKey;
        const updated = await window.piDesktop!.invoke(IPC.invoke.browserReferencesUpdate, { sourceId: targetConnectionId, ...browserTabs });
        if (!updated.ok) throw new Error(updated.error.message);
        const result = await window.piDesktop!.invoke(IPC.invoke.browserReferencesInsert, {
          reference, connectionId: targetConnectionId, ...(targetDraftKey ? { draftKey: targetDraftKey } : {}),
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      }
      if (data.method === "composer.insert") {
        if (typeof data.text !== "string" || !status.canCompose || !window.__piDesktopInsertPromptText?.(data.text)) throw new Error("当前页面无法编辑草稿");
        return { inserted: true };
      }
      if (!["browse.ensureRelay", "browse.mintPairingCode"].includes(data.method)) throw new Error("不支持的侧栏操作");
      const result = await jsonRequest("/api/rpc", { requestId: data.requestId, mutationId: webRemoteId(), operation: data.method, input: {} });
      if (!result.ok) throw new Error(result.error?.message || "Browse 操作失败");
      return result.result;
    })().then((result) => reply({ ok: true, result }), (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  });
  const gate = createLanPasswordGate(async (password) => {
    const response = await jsonRequest("/api/login", { password, name: parentOrigin ? "Chrome 侧边栏" : "Web Renderer" }, false);
    if (!response.ok || typeof response.result?.token !== "string") throw new Error(response.error?.message || "登录响应无效");
    storeToken(response.result.token);
    connect();
  }, { extension: extensionSession });
  const connect = () => {
    if (!token || expired) return;
    if (retry) { clearTimeout(retry); retry = undefined; }
    if (socket && socket.readyState < WebSocket.CLOSING) return;
    gate.connecting();
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws`);
    socket = ws;
    const authTimeout = setTimeout(() => ws.close(4000, "ready timeout"), 15_000);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    ws.addEventListener("open", () => {
      if (socket !== ws || expired) { ws.close(); return; }
      lastMessage = Date.now(); ws.send(JSON.stringify({ type: "auth", token }));
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 45_000) ws.close(4000, "heartbeat timeout");
        else if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
          publishBrowserTabs();
        }
      }, 15_000);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      lastMessage = Date.now();
      let frame: any;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (frame.type === "ready") {
        clearTimeout(authTimeout); attempts = 0;
        connectionId = typeof frame.connectionId === "string" ? frame.connectionId : "";
        status.authenticated = true; status.online = true;
        publishBrowserTabs();
        gate.dispose(); publishStatus(); publishBrowseStatus();
        if (!mounted) { mounted = true; resolveReady(); }
        else window.dispatchEvent(new CustomEvent("pi-desktop:remote-reconnected"));
      } else if (frame.type === "ipc-event" && typeof frame.channel === "string" && Array.isArray(frame.args)) emit(frame.channel, frame.args);
      else if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", ts: frame.ts }));
      else if (frame.type === "error" && ["UNAUTHORIZED", "FORBIDDEN"].includes(frame.error?.code)) expire();
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(authTimeout);
      if (heartbeat) clearInterval(heartbeat);
      if (socket !== ws || expired) return;
      socket = undefined;
      status.online = false; publishStatus(); publishBrowseStatus();
      connectionId = "";
      buffered.delete(IPC.event.browserReferenceInsertRequested);
      emit(IPC.event.browserReferencesChanged, [{ tabs: [] }]);
      if (event.code === 4401 || event.code === 4403) { expire(); return; }
      gate.reconnecting();
      retry = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempts++, 5)));
    });
    ws.addEventListener("error", () => ws.close());
  };
  const connectExtension = async () => {
    if (requestingExtension || expired) return;
    requestingExtension = true;
    if (retry) { clearTimeout(retry); retry = undefined; }
    gate.connecting();
    try {
      token = await new Promise<string>((resolve, reject) => {
        const requestId = webRemoteId();
        const cleanup = () => { clearTimeout(timeout); window.removeEventListener("message", receive); };
        const receive = (event: MessageEvent) => {
          if (event.source !== parent || event.origin !== parentOrigin ||
              event.data?.type !== "pi-desktop:extension-session-response" || event.data.requestId !== requestId) return;
          cleanup();
          if (event.data.ok === true && typeof event.data.token === "string" && event.data.token) resolve(event.data.token);
          else reject(new Error(typeof event.data.error === "string" ? event.data.error : "无法连接主程序"));
        };
        const timeout = setTimeout(() => { cleanup(); reject(new Error("主程序连接超时，正在重试…")); }, 15_000);
        window.addEventListener("message", receive);
        post({ type: "pi-desktop:extension-session-request", requestId });
      });
      connect();
    } catch (error) {
      gate.failed(error instanceof Error ? error.message : "无法连接主程序，正在重试…");
      retry = setTimeout(() => { void connectExtension(); }, Math.min(15_000, 1000 * 2 ** Math.min(attempts++, 4)));
    } finally { requestingExtension = false; }
  };
  publishStatus(); publishBrowseStatus();
  if (extensionSession) void connectExtension();
  else if (token) connect();
  await ready;
}
