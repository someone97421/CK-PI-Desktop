import { BrowserWindow, ipcMain, Menu, screen, session, systemPreferences } from "electron";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import { isNetUrlAllowed, THEME_ASSET_SCHEME } from "@pi-desktop/plugin-sdk";
import { builtinWindowBackground } from "@pi-desktop/shared";
import { suppressLinuxFramelessSystemMenu } from "./frameless-system-menu";
import {
  isPluginPanelWindowControlAction,
  isPluginWidgetAction,
  PLUGIN_PANEL_MIN_SIZE,
  PLUGIN_PANEL_PRIMARY_WIDGET_ID,
  PLUGIN_PANEL_WIDGET_MIN_SIZE,
  PLUGIN_PANEL_WIDGET_ARGUMENT,
  PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL,
  PLUGIN_PANEL_WINDOW_STATE_CHANNEL,
  PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX,
  PLUGIN_WIDGET_CLOSED_EVENT,
  PLUGIN_WIDGET_ID_PATTERN,
  PLUGIN_WIDGET_INVOKE_CHANNEL,
  PLUGIN_WIDGET_OPENED_EVENT,
  type PluginPanelTheme,
  type PluginPanelWindowControlAction,
  type PluginWidgetAction,
  type PluginWidgetBounds,
  type PluginWidgetOpenInput,
  type PluginWidgetState,
} from "../shared/plugin-panel-chrome";

export type PluginPanelOpenRequest = {
  pluginId: string;
  title: string;
  locale: string;
  theme: PluginPanelTheme;
  width: number;
  height: number;
  htmlPath: string;
  /**
   * `"panel"` (default) keeps the 46px host drag band and its three-control
   * capsule. `"widget"` opens the same sandboxed page as a transparent floating
   * surface with neither, so a plugin can be a small orb the user keeps on
   * screen. The plugin surface itself is unchanged: same preload bridge, same
   * partition, same egress policy.
   */
  shape?: "panel" | "widget";
  /** Floating widget placement only: keep the surface above other windows. */
  alwaysOnTop?: boolean;
  /** Overrides the per-shape default: panels are resizable, widgets are not. */
  resizable?: boolean;
  /**
   * Egress allowlist from `manifest.net.domains`. A panel is a full web page:
   * `sandbox: true` removes Node, not the network, so without this the panel is
   * an unmetered outbound channel that bypasses the `net.fetch` permission.
   */
  netDomains?: readonly string[];
  /** Allows microphone audio for plugins with the explicit ui.microphone grant. */
  allowMicrophone?: boolean;
  /** Adds a development-only reminder for the non-clickable drag band. */
  development?: boolean;
};

/**
 * Schemes a panel may always load: its own bundle, devtools plumbing, and the
 * host scheme that serves declared theme assets. The asset handler resolves
 * through the requested plugin's own declarations, so admitting it here does
 * not widen egress — it is read-only and package-scoped (ADR 0248).
 */
const PANEL_LOCAL_SCHEMES = new Set([
  "file:",
  "data:",
  "blob:",
  "devtools:",
  "chrome-extension:",
  `${THEME_ASSET_SCHEME}:`,
]);

const DROPPED_PATH_TTL_MS = 30_000;

/** A widget keeps at least this much of itself on a display, in DIP. */
const WIDGET_MIN_VISIBLE_DIP = 48;
/** A new widget's default square, in DIP, when the caller names no size. */
const WIDGET_DEFAULT_SIZE = 220;
/** Bound on `widget.open`'s query: it reaches a page, so it stays small. */
const WIDGET_QUERY_MAX_ENTRIES = 16;
const WIDGET_QUERY_MAX_VALUE_CHARS = 512;

/**
 * `Math.min`/`Math.max` with a defined answer when the range is empty: a window
 * larger than every display together still lands with a visible edge.
 */
function clampNumber(value: number, lower: number, upper: number): number {
  return Math.round(Math.min(Math.max(value, lower), Math.max(lower, upper)));
}

/**
 * Bound one requested widget geometry to real, reachable pixels.
 *
 * A plugin computes positions from `getState()` — cursor and display bounds —
 * on a desktop whose displays may sit at negative coordinates, hold different
 * scale factors, and need not share an edge. Sizes are clamped between the
 * caller's minimum and the displays' union (a widget may span a stitched
 * desktop), and the position keeps at least `WIDGET_MIN_VISIBLE_DIP` of the
 * window on one *real* display: the union's bounding rectangle is not enough,
 * because an offset arrangement leaves voids inside it where a window would be
 * invisible. A request that is already valid is returned untouched, so movement
 * across a stitch stays smooth and negative coordinates stay ordinary values.
 */
export function clampWidgetBounds(
  requested: PluginWidgetBounds,
  minimum: { width: number; height: number },
): PluginWidgetBounds {
  const displays = screen.getAllDisplays();
  if (!displays.length) {
    return {
      x: Math.round(requested.x),
      y: Math.round(requested.y),
      width: clampNumber(requested.width, minimum.width, requested.width),
      height: clampNumber(requested.height, minimum.height, requested.height),
    };
  }
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  const width = clampNumber(requested.width, minimum.width, right - left);
  const height = clampNumber(requested.height, minimum.height, bottom - top);

  // One candidate per display: the least movement that still leaves the widget
  // visible on that display. The nearest candidate wins, so a window that is
  // already on screen does not move at all. A range can be empty when the
  // window is larger than the display; `clampNumber` then keeps its far edge
  // just inside the border, which is still a visible window.
  let best: { x: number; y: number; cost: number } | null = null;
  for (const display of displays) {
    const bounds = display.bounds;
    const x = clampNumber(
      requested.x,
      bounds.x + WIDGET_MIN_VISIBLE_DIP - width,
      bounds.x + bounds.width - WIDGET_MIN_VISIBLE_DIP,
    );
    const y = clampNumber(
      requested.y,
      bounds.y + WIDGET_MIN_VISIBLE_DIP - height,
      bounds.y + bounds.height - WIDGET_MIN_VISIBLE_DIP,
    );
    const cost = (x - requested.x) ** 2 + (y - requested.y) ** 2;
    if (!best || cost < best.cost) best = { x, y, cost };
  }
  const chosen = best ?? {
    x: Math.round(requested.x),
    y: Math.round(requested.y),
  };
  return { x: chosen.x, y: chosen.y, width, height };
}

/** Key of one widget window: a plugin's window is only addressable through it. */
function widgetWindowKey(pluginId: string, id: string): string {
  return `${pluginId}\u0000${id}`;
}

/**
 * Parse `widget.open`'s query. Values reach the page as URL search parameters,
 * so anything but a short string of each is refused rather than coerced.
 */
function widgetQuery(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_ARGUMENT: widget query must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > WIDGET_QUERY_MAX_ENTRIES) {
    throw new Error("INVALID_ARGUMENT: widget query has too many entries");
  }
  const query: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!key || key.length > 64 || typeof raw !== "string") {
      throw new Error("INVALID_ARGUMENT: widget query values must be short strings");
    }
    query[key] = raw.slice(0, WIDGET_QUERY_MAX_VALUE_CHARS);
  }
  return Object.keys(query).length ? query : null;
}

/** A named dimension, or null when the caller left it out. */
function widgetDimension(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`INVALID_ARGUMENT: ${field} must be a finite number`);
  }
  return value;
}

type BridgeHandler = (
  pluginId: string,
  channel: string,
  payload?: Record<string, unknown>,
  context?: { droppedPath?: string },
) => Promise<unknown>;

/** Reports an egress attempt a panel was not allowed to make. */
export type PluginPanelBlockedRequest = (input: {
  pluginId: string;
  url: string;
}) => void;

/**
 * Confine everything a plugin's web contents can reach to its declared domains.
 *
 * Shared by the detached panel window and the docked work-panel view: both are
 * full web pages under the same plugin identity, so one policy governs both.
 * Registering again on the same persisted partition replaces the previous
 * handlers, so re-opening re-reads the current allowlist rather than stacking
 * filters.
 */
export function applyPluginEgressPolicy(
  ses: Electron.Session,
  input: {
    pluginId: string;
    netDomains?: readonly string[];
    allowMicrophone?: boolean;
    onBlockedRequest?: PluginPanelBlockedRequest;
  },
): void {
  const domains = input.netDomains ?? [];
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    let scheme = "";
    try {
      scheme = new URL(details.url).protocol;
    } catch {
      // An unparseable URL cannot be matched against the allowlist; drop it.
      callback({ cancel: true });
      return;
    }
    if (PANEL_LOCAL_SCHEMES.has(scheme)) {
      callback({ cancel: false });
      return;
    }
    if (isNetUrlAllowed(details.url, domains)) {
      callback({ cancel: false });
      return;
    }
    input.onBlockedRequest?.({ pluginId: input.pluginId, url: details.url });
    callback({ cancel: true });
  });
  // A panel is denied device access by default. The only opt-in is an
  // audio-only media request for a plugin that declared ui.microphone.

  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes =
      permission === "media" && "mediaTypes" in details ? details.mediaTypes : undefined;
    const audioOnly =
      Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
    callback(input.allowMicrophone === true && audioOnly);
  });
  ses.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    if (permission !== "media" || input.allowMicrophone !== true) return false;
    // Chromium probes with "unknown" (or an empty mediaType) before the
    // request. Denying that fails getUserMedia even when the following
    // request is audio-only.
    return details.mediaType !== "video";
  });

}

/** macOS TCC: a sandboxed file:// panel often never prompts on its own. */
async function ensureOsMicrophone(allowMicrophone?: boolean): Promise<void> {
  if (!allowMicrophone || process.platform !== "darwin") return;
  try {
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return;
    await systemPreferences.askForMediaAccess("microphone");
  } catch {
    // Headless tests have no TCC surface.
  }
}


/** Persisted session partition shared by a plugin's panel window and views. */
export function pluginSessionPartition(pluginId: string): string {
  return `persist:pi-plugin-${pluginId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

/**
 * Hosts isolated plugin panel windows.
 * Each plugin panel gets a dedicated session partition and no Node integration.
 */
export class PluginPanelHost {
  private windows = new Map<string, BrowserWindow>();
  private pendingOpens = new Map<string, { token: { canceled: boolean }; promise: Promise<void> }>();
  private bridge: BridgeHandler;
  private onBlockedRequest?: PluginPanelBlockedRequest;
  private handlerReady = false;
  /** Paths reported by the preload for a real drop, keyed by web contents. */
  private pendingDrops = new Map<number, Map<string, number>>();
  /**
   * Other owners of plugin web contents that may use the panel bridge — the
   * docked work-panel views. Kept separate from `windows` so window controls
   * stay window-only: a docked view must not be able to close the same
   * plugin's detached panel window.
   */
  private senderResolvers: Array<(senderId: number) => string | null> = [];
  /** Observer for failures of the fire-and-forget legacy sync bridge. */
  private onBridgeError?: (pluginId: string, channel: string, error: unknown) => void;
  /**
   * Locale per floating-widget web contents. Presence in this map is also what
   * makes a window a widget for `showWidgetMenu`, so a panel never gets a
   * context menu it did not ask for.
   */
  private widgetLocales = new Map<number, string>();
  /**
   * Extra windows of one plugin beyond its primary surface, keyed by plugin and
   * widget id. A widget is reachable only through its own plugin's key, so a
   * page can never address a sibling plugin's window.
   */
  private widgetWindows = new Map<
    string,
    { win: BrowserWindow; pluginId: string; id: string }
  >();
  /**
   * The last verified open request per plugin: its own resolved `ui.panel`
   * entry, never a path a page supplied. `widget.open` seeds an extra window
   * from here, or asks `widgetEntryResolver` when the plugin's surface was
   * opened elsewhere (a docked view) or has closed since.
   */
  private panelRequests = new Map<string, PluginPanelOpenRequest>();
  private widgetEntryResolver?: (pluginId: string) => PluginPanelOpenRequest | null;
  /**
   * Each in-flight open owns a token, including concurrent opens of one id. It
   * waits on the microphone grant and on the page load, and the host may close
   * the plugin's windows in between: the token is how that close reaches an
   * open that has no window to close yet, so no orphan window appears afterwards.
   */
  private pendingWidgetOpens = new Set<{
    pluginId: string;
    id: string;
    canceled: boolean;
  }>();

  constructor(
    bridge: BridgeHandler,
    onBlockedRequest?: PluginPanelBlockedRequest,
    onBridgeError?: (pluginId: string, channel: string, error: unknown) => void,
  ) {
    this.bridge = bridge;
    this.onBlockedRequest = onBlockedRequest;
    this.onBridgeError = onBridgeError;
    this.ensureHandlers();
  }

  /** Lets another host serve `pluginBridge` calls from its own web contents. */
  addSenderResolver(resolve: (senderId: number) => string | null): void {
    this.senderResolvers.push(resolve);
  }

  /**
   * Resolves the plugin's own verified `ui.panel` entry, for a widget opened by
   * a surface the host did not create itself (a docked work-panel view). The
   * host calls this instead of trusting the page, and a plugin that holds no
   * `ui.panel` grant answers null: extra windows stay inside the grant the
   * plugin already had.
   */
  setWidgetEntryResolver(resolve: (pluginId: string) => PluginPanelOpenRequest | null): void {
    this.widgetEntryResolver = resolve;
  }

  private ensureHandlers(): void {
    if (this.handlerReady) return;
    this.handlerReady = true;

    ipcMain.handle(
      "pi-plugin-panel-invoke",
      async (event, rawChannel: unknown, rawPayload: unknown) => {
        const pluginId = this.pluginIdForSender(event.sender.id);
        if (!pluginId) throw new Error("invalid panel invoker");
        const channel = String(rawChannel ?? "");
        const payload =
          rawPayload && typeof rawPayload === "object"
            ? (rawPayload as Record<string, unknown>)
            : undefined;
        const droppedPath =
          channel === "fs.registerDropped"
            ? this.consumeDroppedPath(event.sender.id, payload?.path)
            : undefined;
        return this.bridge(pluginId, channel, payload, droppedPath ? { droppedPath } : undefined);
      },
    );

    ipcMain.on("pi-plugin-panel-drop", (event, rawPaths: unknown) => {
      const pluginId = this.pluginIdForSender(event.sender.id);
      if (!pluginId || !Array.isArray(rawPaths)) return;
      this.recordDroppedPaths(
        event.sender.id,
        rawPaths.filter((value): value is string => typeof value === "string"),
      );
    });

    // Legacy sync bridge used by older sample panels.
    ipcMain.on(
      "pi-plugin-panel-bridge",
      (event, rawChannel: unknown, rawPayload: unknown) => {
        const pluginId = this.pluginIdForSender(event.sender.id);
        if (!pluginId) {
          event.returnValue = {
            ok: false,
            error: { code: "NOT_FOUND", message: "invalid panel invoker" },
          };
          return;
        }
        const channel = String(rawChannel ?? "");
        const payload =
          rawPayload && typeof rawPayload === "object"
            ? (rawPayload as Record<string, unknown>)
            : undefined;
        // Sync IPC cannot await; kick async work and return ack. The bridge
        // rejects when the plugin is unloaded or times out, and a panel page
        // can call this at will, so the rejection must be observed here
        // rather than surfacing as an unhandled rejection in main.
        this.bridge(pluginId, channel, payload).catch((error) => {
          this.onBridgeError?.(pluginId, channel, error);
        });
        event.returnValue = { ok: true, accepted: true };
      },
    );

    ipcMain.handle(
      PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL,
      async (event, rawAction: unknown) => {
        const window = this.windowForSender(event.sender.id);
        if (!window) throw new Error("invalid panel window control invoker");
        if (!isPluginPanelWindowControlAction(rawAction)) {
          throw new Error("unsupported panel window control action");
        }
        this.applyWindowControl(window, rawAction);
        return {
          maximized: !window.isDestroyed() && window.isMaximized(),
        };
      },
    );
    // The plugin surface bridge a plugin's own windows use for geometry,
    // click-through and extra widget instances (`pluginBridge.widget.invoke`).
    // The caller is identified by its own web contents: the payload may name a
    // widget of its own plugin and nothing else.
    ipcMain.handle(
      PLUGIN_WIDGET_INVOKE_CHANNEL,
      async (event, rawAction: unknown, rawPayload: unknown) => {
        if (!isPluginWidgetAction(rawAction)) {
          throw new Error("unsupported widget action");
        }
        const surface = this.surfaceForSender(event.sender.id);
        // `open` only needs the plugin behind the caller; every action that
        // acts on "this window" needs a window the host actually created, so a
        // docked view cannot pass itself off as one.
        const pluginId = surface?.pluginId ?? this.pluginIdForSender(event.sender.id);
        if (!pluginId) throw new Error("invalid widget invoker");
        const payload =
          rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
            ? (rawPayload as Record<string, unknown>)
            : {};
        // An open that outlives its caller must not mint a window: the caller is
        // re-checked by its own web contents id after every wait.
        const senderId = event.sender.id;
        return this.applyWidgetAction(pluginId, surface, rawAction, payload, () =>
          this.pluginIdForSender(senderId) === pluginId,
        );
      },
    );
  }

  private pluginIdForSender(senderId: number): string | null {
    for (const [pluginId, win] of this.windows) {
      if (!win.isDestroyed() && win.webContents.id === senderId) return pluginId;
    }
    // A widget window is as much a plugin surface as the panel its plugin was
    // opened with: the whole `pluginBridge` API stays reachable from it.
    for (const record of this.widgetWindows.values()) {
      if (!record.win.isDestroyed() && record.win.webContents.id === senderId) {
        return record.pluginId;
      }
    }
    for (const resolve of this.senderResolvers) {
      const pluginId = resolve(senderId);
      if (pluginId) return pluginId;
    }
    return null;
  }

  /**
   * The window a sender owns, with its widget id — a plugin's primary surface
   * answers `"panel"`. Null for a docked view: it is a plugin surface but no
   * window, and every action that moves, hides or closes "this window" needs one.
   */
  private surfaceForSender(
    senderId: number,
  ): { pluginId: string; id: string; win: BrowserWindow } | null {
    for (const [pluginId, win] of this.windows) {
      if (!win.isDestroyed() && win.webContents.id === senderId) {
        return { pluginId, id: PLUGIN_PANEL_PRIMARY_WIDGET_ID, win };
      }
    }
    for (const record of this.widgetWindows.values()) {
      if (!record.win.isDestroyed() && record.win.webContents.id === senderId) {
        return { pluginId: record.pluginId, id: record.id, win: record.win };
      }
    }
    return null;
  }

  private recordDroppedPaths(senderId: number, paths: readonly string[]): void {
    const now = Date.now();
    const pending = this.pendingDrops.get(senderId) ?? new Map<string, number>();
    for (const rawPath of paths.slice(0, 32)) {
      if (!rawPath) continue;
      pending.set(resolve(rawPath), now + DROPPED_PATH_TTL_MS);
    }
    if (pending.size) this.pendingDrops.set(senderId, pending);
  }

  private consumeDroppedPath(senderId: number, rawPath: unknown): string | null {
    if (typeof rawPath !== "string" || !rawPath) return null;
    const pending = this.pendingDrops.get(senderId);
    if (!pending) return null;
    const now = Date.now();
    for (const [path, expiresAt] of pending) {
      if (expiresAt <= now) pending.delete(path);
    }
    const path = resolve(rawPath);
    if (!pending.has(path)) {
      if (!pending.size) this.pendingDrops.delete(senderId);
      return null;
    }
    pending.delete(path);
    if (!pending.size) this.pendingDrops.delete(senderId);
    return path;
  }

  /**
   * The *window* a sender owns, primary panel or extra widget. Deliberately not
   * routed through `pluginIdForSender`: that also resolves docked views, and a
   * docked view asking for a window control must not reach the same plugin's
   * separate panel window.
   *
   * Widgets belong here because a floating widget has no capsule and asks for
   * its context menu through this channel; both kinds of window are the host's
   * own, so neither can reach a sibling plugin's window.
   */
  private windowForSender(senderId: number): BrowserWindow | null {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && win.webContents.id === senderId) return win;
    }
    for (const record of this.widgetWindows.values()) {
      if (!record.win.isDestroyed() && record.win.webContents.id === senderId) {
        return record.win;
      }
    }
    return null;
  }

  private applyWindowControl(
    window: BrowserWindow,
    action: PluginPanelWindowControlAction,
  ): void {
    switch (action) {
      case "getState":
        break;
      case "minimize":
        window.minimize();
        break;
      case "toggleMaximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "contextMenu":
        this.showWidgetMenu(window);
        break;
      case "close":
        window.close();
        break;
    }
  }

  /**
   * A floating widget has no capsule, so its own context menu opens the host's
   * window menu instead. Without it the only way out of a widget would be a
   * plugin-authored close button, and a plugin that never added one would leave
   * a window the user cannot dismiss.
   *
   * Only a widget is registered in `widgetLocales`; a panel or docked view that
   * asks for this action gets nothing, because panels keep the capsule.
   */
  private showWidgetMenu(window: BrowserWindow): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const locale = this.widgetLocales.get(window.webContents.id);
    if (locale === undefined) return;
    const labels = catalogs[resolveLocale(locale)].pluginPanelWidget;
    const menu = Menu.buildFromTemplate([
      {
        label: labels.alwaysOnTop,
        type: "checkbox",
        checked: window.isAlwaysOnTop(),
        click: (item) => {
          if (!window.isDestroyed()) window.setAlwaysOnTop(item.checked);
        },
      },
      { type: "separator" },
      {
        label: labels.minimize,
        click: () => {
          if (!window.isDestroyed()) window.minimize();
        },
      },
      {
        label: labels.close,
        click: () => {
          if (!window.isDestroyed()) window.close();
        },
      },
    ]);
    menu.popup({ window });
  }

  /**
   * Confine everything the panel's web contents can reach to the plugin's
   * declared domains. See `applyPluginEgressPolicy`, which the docked work-panel
   * view host shares.
   */
  private applyEgressPolicy(
    ses: Electron.Session,
    request: PluginPanelOpenRequest,
  ): void {
    applyPluginEgressPolicy(ses, {
      pluginId: request.pluginId,
      netDomains: request.netDomains,
      allowMicrophone: request.allowMicrophone,
      onBlockedRequest: this.onBlockedRequest,
    });
  }

  async open(request: PluginPanelOpenRequest): Promise<void> {
    const pending = this.pendingOpens.get(request.pluginId);
    // 同一轮打开共享结果；权限策略由创建者负责，旧等待者不能重新应用旧授权。
    if (pending) return pending.promise;

    const token = { canceled: false };
    const promise = (async () => {
      // The plugin's own entry, as the host resolved it. Extra widget windows
      // are seeded from this record when the plugin asks for one before its
      // surface was seen by the resolver.
      this.panelRequests.set(request.pluginId, request);
      const existing = this.windows.get(request.pluginId);
      if (existing && !existing.isDestroyed()) {
        this.applyEgressPolicy(existing.webContents.session, request);
        await ensureOsMicrophone(request.allowMicrophone);
        if (token.canceled) return;
        if (!existing.isDestroyed()) {
          if (existing.isMinimized()) existing.restore();
          existing.show();
          existing.focus();
        }
        return;
      }

      const partition = pluginSessionPartition(request.pluginId);
      const ses = session.fromPartition(partition, { cache: true });
      this.applyEgressPolicy(ses, request);
      await ensureOsMicrophone(request.allowMicrophone);
      if (token.canceled) return;

      const widget = request.shape === "widget";
      const minSize = widget ? PLUGIN_PANEL_WIDGET_MIN_SIZE : PLUGIN_PANEL_MIN_SIZE;
      const win = new BrowserWindow({
        width: Math.max(minSize.width, request.width || (widget ? 220 : 480)),
        height: Math.max(minSize.height, request.height || (widget ? 220 : 360)),
        title: request.title,
        show: false,
        autoHideMenuBar: true,
        // The host theme is only a fallback; the preload samples the actual
        // plugin page colors after it has loaded and paints the chrome from them.
        backgroundColor: widget ? "#00000000" : builtinWindowBackground(request.theme),
        // Every platform uses the same frameless surface. A panel's visible window
        // controls are the preload's three-button capsule; a floating widget has
        // no chrome of its own — the plugin draws its silhouette edge to edge.
        frame: false,
        transparent: widget,
        // A transparent window would otherwise carry a rectangular native shadow
        // around an orb that is round; a widget draws its own glow instead.
        hasShadow: !widget,
        resizable: request.resizable ?? !widget,
        alwaysOnTop: widget && request.alwaysOnTop === true,
        // A floating widget is a desktop companion, not a taskbar entry, and it
        // has no capsule to restore from a maximized state.
        skipTaskbar: widget,
        maximizable: !widget,
        ...(widget ? { fullscreenable: false } : {}),
        webPreferences: {
          session: ses,
          preload: join(__dirname, "../preload/plugin-panel.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          additionalArguments: [
            `${PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX}${encodeURIComponent(request.locale)}`,
            `--pi-plugin-panel-theme=${request.theme}`,
            ...(widget ? [PLUGIN_PANEL_WIDGET_ARGUMENT] : []),
            ...(request.development
              ? ["--pi-plugin-panel-development=1"]
              : []),
          ],
        },
      });
      // A panel owns its visible surface; do not add a native application menu
      // to the window around the plugin's own UI.
      win.setMenu(null);
      suppressLinuxFramelessSystemMenu(win);

      // A panel gets exactly one web contents. `window.open` would otherwise mint
      // a chromeless window outside the egress policy applied above.
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      const sendWindowState = () => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        win.webContents.send(PLUGIN_PANEL_WINDOW_STATE_CHANNEL, {
          maximized: win.isMaximized(),
        });
      };
      win.on("maximize", sendWindowState);
      win.on("unmaximize", sendWindowState);
      win.webContents.on("did-finish-load", sendWindowState);

      // `closed` fires after the native window is gone. Copy the contents id
      // while the window is still alive; reading `webContents` later throws
      // "Object has been destroyed" and surfaces an uncaught main-process dialog.
      const webContentsId = win.webContents.id;
      if (widget) this.widgetLocales.set(webContentsId, request.locale);
      win.on("closed", () => {
        this.pendingDrops.delete(webContentsId);
        this.widgetLocales.delete(webContentsId);
        if (this.windows.get(request.pluginId) === win) {
          this.windows.delete(request.pluginId);
        }
        // The plugin's other windows learn the surface is gone, exactly as they
        // do for an extra widget: one lifecycle for every window it owns.
        this.emitWidgetEvent(
          request.pluginId,
          PLUGIN_WIDGET_CLOSED_EVENT,
          { id: PLUGIN_PANEL_PRIMARY_WIDGET_ID },
        );
      });

      if (token.canceled) {
        if (!win.isDestroyed()) win.destroy();
        return;
      }

      this.windows.set(request.pluginId, win);

      try {
        await win.loadURL(pathToFileURL(request.htmlPath).toString());
      } catch (err) {
        if (token.canceled || win.isDestroyed()) return;
        throw err;
      }

      if (token.canceled) {
        if (!win.isDestroyed()) win.destroy();
        if (this.windows.get(request.pluginId) === win) {
          this.windows.delete(request.pluginId);
        }
        return;
      }

      if (!win.isDestroyed()) {
        win.show();
      }
    })();

    this.pendingOpens.set(request.pluginId, { token, promise });
    try {
      await promise;
    } finally {
      if (this.pendingOpens.get(request.pluginId)?.token === token) {
        this.pendingOpens.delete(request.pluginId);
      }
    }
  }

  /**
   * Close every window of one plugin: its primary surface and every extra
   * widget. Unload, a crash and a self-inflicted `ui.closePanel` all land here,
   * so a plugin that is going away can never leave a widget on screen.
   */
  async close(pluginId: string): Promise<void> {
    const pending = this.pendingOpens.get(pluginId);
    if (pending) {
      pending.token.canceled = true;
      this.pendingOpens.delete(pluginId);
    }
    // An open that is still waiting has no window to close, so cancel it here:
    // it must not finish by handing the plugin a window nothing can dismiss.
    this.cancelPendingWidgetOpens((entry) => entry.pluginId === pluginId);
    this.panelRequests.delete(pluginId);
    for (const [key, record] of [...this.widgetWindows]) {
      if (record.pluginId !== pluginId) continue;
      this.widgetWindows.delete(key);
      if (!record.win.isDestroyed()) record.win.close();
    }
    const win = this.windows.get(pluginId);
    if (!win || win.isDestroyed()) {
      if (this.windows.get(pluginId) === win) {
        this.windows.delete(pluginId);
      }
      return;
    }
    win.close();
    if (this.windows.get(pluginId) === win) {
      this.windows.delete(pluginId);
    }
  }

  async closeAll(): Promise<void> {
    for (const pending of this.pendingOpens.values()) {
      pending.token.canceled = true;
    }
    this.pendingOpens.clear();
    this.cancelPendingWidgetOpens(() => true);
    for (const pluginId of [
      ...new Set([
        ...this.windows.keys(),
        ...[...this.widgetWindows.values()].map((record) => record.pluginId),
      ]),
    ]) {
      await this.close(pluginId);
    }
    this.widgetWindows.clear();
    this.panelRequests.clear();
  }

  /** Mark the in-flight widget opens matching `match` as abandoned. */
  private cancelPendingWidgetOpens(
    match: (entry: { pluginId: string; id: string }) => boolean,
  ): void {
    for (const entry of this.pendingWidgetOpens.values()) {
      if (match(entry)) entry.canceled = true;
    }
  }

  /**
   * Push a one-way event to every window of every plugin: the primary surface
   * and each extra widget. The preload maps `pluginBridge.on(event, handler)`
   * to `pi-plugin-panel-event:<event>`, so the host sends on that channel.
   * Receivers that do not subscribe are inert; the event names are fixed by the
   * host (e.g. `appearance:changed`).
   */
  broadcast(event: string, payload: unknown): void {
    const pluginIds = new Set([
      ...this.windows.keys(),
      ...[...this.widgetWindows.values()].map((record) => record.pluginId),
    ]);
    for (const pluginId of pluginIds) {
      this.emitWidgetEvent(pluginId, event, payload);
    }
  }

  /** Every live window of one plugin, primary surface first. */
  private pluginWindows(pluginId: string): BrowserWindow[] {
    const windows: BrowserWindow[] = [];
    const primary = this.windows.get(pluginId);
    if (primary) windows.push(primary);
    for (const record of this.widgetWindows.values()) {
      if (record.pluginId === pluginId) windows.push(record.win);
    }
    return windows;
  }

  /**
   * Deliver one host event to the plugin's own windows. Like `broadcast`, this
   * is best-effort and one-way: a window that cannot receive must not starve
   * its siblings, and a widget that is mid-close is simply skipped.
   */
  private emitWidgetEvent(pluginId: string, event: string, payload: unknown): void {
    const channel = `pi-plugin-panel-event:${event}`;
    for (const win of this.pluginWindows(pluginId)) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // One window that cannot receive must not starve the others.
      }
    }
  }


  /**
   * Resolve the plugin's own entry page for an extra widget. The host resolves
   * it — from the resolver, or from the request its own `open` recorded — so a
   * page can never turn this call into a navigation of its choosing.
   */
  private resolveWidgetEntry(pluginId: string): PluginPanelOpenRequest | null {
    const resolved = this.widgetEntryResolver?.(pluginId);
    if (resolved) return resolved;
    return this.panelRequests.get(pluginId) ?? null;
  }

  private widgetState(win: BrowserWindow, id: string): PluginWidgetState {
    return {
      id,
      bounds: win.getBounds(),
      displays: screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      })),
      cursor: screen.getCursorScreenPoint(),
    };
  }

  /**
   * Run one `pluginBridge.widget` action for the plugin that owns `surface`.
   *
   * Every action is scoped to that plugin: `close` and `open` address a widget
   * id inside it, and the window actions are applied to the caller's own
   * window. A surface-less caller (a docked view) may only `open`.
   *
   * `isCallerAlive` tells the one action that waits whether the page behind the
   * call is still there when the wait ends.
   */
  private async applyWidgetAction(
    pluginId: string,
    surface: { id: string; win: BrowserWindow } | null,
    action: PluginWidgetAction,
    payload: Record<string, unknown>,
    isCallerAlive: () => boolean,
  ): Promise<unknown> {
    if (action === "open") {
      return this.openWidgetWindow(pluginId, payload, isCallerAlive);
    }
    if (!surface || surface.win.isDestroyed()) {
      throw new Error("UNSUPPORTED: no window for this widget action");
    }
    const win = surface.win;
    switch (action) {
      case "getState":
        return this.widgetState(win, surface.id);
      case "setBounds": {
        const requested = {
          x: widgetDimension(payload.x, "x") ?? win.getBounds().x,
          y: widgetDimension(payload.y, "y") ?? win.getBounds().y,
          width: widgetDimension(payload.width, "width") ?? win.getBounds().width,
          height: widgetDimension(payload.height, "height") ?? win.getBounds().height,
        };
        // 120 DIP is the floor for every surface: a plugin that shrinks its own
        // window knows what it is doing, and the host only refuses a size no
        // page could live in.
        win.setBounds(clampWidgetBounds(requested, PLUGIN_PANEL_WIDGET_MIN_SIZE));
        return { ok: true, bounds: win.getBounds() };
      }
      case "setIgnoreMouse": {
        if (typeof payload.ignore !== "boolean") {
          throw new Error("INVALID_ARGUMENT: ignore must be a boolean");
        }
        // `forward` keeps pointer moves reaching the page while clicks pass
        // through, which is what lets a companion tell when the cursor has come
        // back over it.
        win.setIgnoreMouseEvents(payload.ignore, { forward: true });
        return { ok: true, ignore: payload.ignore };
      }
      case "setAlwaysOnTop": {
        if (typeof payload.value !== "boolean") {
          throw new Error("INVALID_ARGUMENT: value must be a boolean");
        }
        win.setAlwaysOnTop(payload.value);
        return { ok: true, value: win.isAlwaysOnTop() };
      }
      case "close": {
        const rawId = payload.id;
        if (rawId !== undefined && rawId !== null && typeof rawId !== "string") {
          throw new Error("INVALID_ARGUMENT: widget id must be a string");
        }
        const id = typeof rawId === "string" && rawId ? rawId.trim() : surface.id;
        return this.closeWidgetWindow(pluginId, id);
      }
      default:
        throw new Error("unsupported widget action");
    }
  }

  /** Bring an existing widget window forward: `open` is idempotent per id. */
  private revealWidget(
    win: BrowserWindow,
    id: string,
  ): { ok: true; id: string; created: false } {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { ok: true, id, created: false };
  }

  /**
   * Open one extra window for a plugin, or bring the existing one forward.
   *
   * The window loads the plugin's own `ui.panel` entry — the same page, egress
   * policy, session partition and preload as its primary surface — with the
   * caller's query appended. Same id, same window: a second `open` never mints
   * a twin, so a plugin can address an instance without tracking handles.
   *
   * `isCallerAlive` is re-checked after every wait: an open whose page (or whole
   * plugin) went away in the meantime is abandoned, because a window nobody can
   * reach is a window nobody can close.
   */
  private async openWidgetWindow(
    pluginId: string,
    payload: Record<string, unknown>,
    isCallerAlive: () => boolean,
  ): Promise<{ ok: true; id: string; created: boolean }> {
    const id = typeof payload.id === "string" ? payload.id.trim() : "";
    if (!PLUGIN_WIDGET_ID_PATTERN.test(id) || id === PLUGIN_PANEL_PRIMARY_WIDGET_ID) {
      throw new Error("INVALID_ARGUMENT: widget id");
    }
    const query = widgetQuery(payload.query);
    const width = widgetDimension(payload.width, "width");
    const height = widgetDimension(payload.height, "height");
    const input: PluginWidgetOpenInput = {
      id,
      ...(query ? { query } : {}),
      ...(width === null ? {} : { width }),
      ...(height === null ? {} : { height }),
    };

    const key = widgetWindowKey(pluginId, id);
    const token = { pluginId, id, canceled: false };
    this.pendingWidgetOpens.add(token);
    try {
      const open = this.widgetWindows.get(key);
      if (open && !open.win.isDestroyed()) return this.revealWidget(open.win, id);
      if (open) this.widgetWindows.delete(key);

      const entry = this.resolveWidgetEntry(pluginId);
      if (!entry) throw new Error("UNSUPPORTED: plugin has no panel entry");

      const partition = pluginSessionPartition(pluginId);
      const ses = session.fromPartition(partition, { cache: true });
      this.applyEgressPolicy(ses, entry);
      await ensureOsMicrophone(entry.allowMicrophone);
      this.assertWidgetOpenAlive(token, isCallerAlive);
      // A second `open` of the same id may arrive while the microphone grant is
      // pending: it must find one window, not two.
      const raced = this.widgetWindows.get(key);
      if (raced && !raced.win.isDestroyed()) return this.revealWidget(raced.win, id);

      // Only the size is bound here; the window opens where the platform puts it
      // and the page moves it with `setBounds` once it knows where it belongs.
      const size = clampWidgetBounds(
        {
          x: 0,
          y: 0,
          width: input.width ?? WIDGET_DEFAULT_SIZE,
          height: input.height ?? WIDGET_DEFAULT_SIZE,
        },
        PLUGIN_PANEL_WIDGET_MIN_SIZE,
      );
      const win = new BrowserWindow({
        width: size.width,
        height: size.height,
        title: entry.title,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#00000000",
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        alwaysOnTop: entry.alwaysOnTop === true,
        skipTaskbar: true,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          session: ses,
          preload: join(__dirname, "../preload/plugin-panel.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          additionalArguments: [
            `${PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX}${encodeURIComponent(entry.locale)}`,
            `--pi-plugin-panel-theme=${entry.theme}`,
            PLUGIN_PANEL_WIDGET_ARGUMENT,
            ...(entry.development ? ["--pi-plugin-panel-development=1"] : []),
          ],
        },
      });
      win.setMenu(null);
      suppressLinuxFramelessSystemMenu(win);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const webContentsId = win.webContents.id;
      this.widgetLocales.set(webContentsId, entry.locale);
      win.on("closed", () => {
        this.pendingDrops.delete(webContentsId);
        this.widgetLocales.delete(webContentsId);
        if (this.widgetWindows.get(key)?.win === win) this.widgetWindows.delete(key);
        this.emitWidgetEvent(pluginId, PLUGIN_WIDGET_CLOSED_EVENT, { id });
      });
      // Registered before the load so a second `open` of the same id finds this
      // window instead of racing it into existence.
      this.widgetWindows.set(key, { win, pluginId, id });
      this.emitWidgetEvent(pluginId, PLUGIN_WIDGET_OPENED_EVENT, { id });
      try {
        await win.loadFile(entry.htmlPath, input.query ? { query: input.query } : undefined);
      } catch (error) {
        this.discardWidgetWindow(key, win, webContentsId);
        throw error;
      }
      // The wait above is long enough for a `close(pluginId)` or a `close({id})`
      // to have arrived: drop the window rather than hand over an orphan.
      if (token.canceled || !isCallerAlive()) {
        this.discardWidgetWindow(key, win, webContentsId);
        throw new Error("UNSUPPORTED: widget open cancelled");
      }
      if (!win.isDestroyed()) win.show();
      return { ok: true, id, created: true };
    } finally {
      this.pendingWidgetOpens.delete(token);
    }
  }

  /** Throw when an in-flight widget open lost its reason to exist. */
  private assertWidgetOpenAlive(
    token: { canceled: boolean },
    isCallerAlive: () => boolean,
  ): void {
    if (token.canceled || !isCallerAlive()) {
      throw new Error("UNSUPPORTED: widget open cancelled");
    }
  }

  /**
   * Drop a widget window whose creation did not finish. The record is only
   * removed when it still points at this window: an id can have been closed and
   * reopened while the load was pending, and that newer window must survive.
   */
  private discardWidgetWindow(key: string, win: BrowserWindow, webContentsId: number): void {
    if (this.widgetWindows.get(key)?.win === win) this.widgetWindows.delete(key);
    this.widgetLocales.delete(webContentsId);
    if (!win.isDestroyed()) win.destroy();
  }

  /** Close one widget of a plugin by id; the primary surface answers to `panel`. */
  private closeWidgetWindow(
    pluginId: string,
    id: string,
  ): { ok: true; closed: boolean } {
    // A close for this id also stops an open of the same id that is still
    // waiting: whatever it would have created is exactly what is being closed.
    this.cancelPendingWidgetOpens(
      (entry) => entry.pluginId === pluginId && entry.id === id,
    );
    if (id === PLUGIN_PANEL_PRIMARY_WIDGET_ID) {
      const win = this.windows.get(pluginId);
      if (!win || win.isDestroyed()) return { ok: true, closed: false };
      win.close();
      return { ok: true, closed: true };
    }
    const record = this.widgetWindows.get(widgetWindowKey(pluginId, id));
    if (!record || record.win.isDestroyed()) return { ok: true, closed: false };
    record.win.close();
    return { ok: true, closed: true };
  }
}
