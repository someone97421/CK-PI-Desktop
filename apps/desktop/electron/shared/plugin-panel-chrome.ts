export const PLUGIN_PANEL_TITLEBAR_HEIGHT = 46;

/**
 * Opt-in marker for plugin pages that use the host-published titlebar CSS
 * variable. Pages with this marker own their normal-flow top spacing; legacy
 * pages keep the host's additive padding fallback.
 */
export const PLUGIN_PANEL_CHROME_META_NAME = "pi-plugin-chrome";
export const PLUGIN_PANEL_CHROME_VERSION = "v2";
/**
 * Opt-in mode for pages that draw through the transparent host drag band.
 * The host keeps the capsule above the page, while the page owns hit testing
 * and supplies its own drag/no-drag regions.
 */
export const PLUGIN_PANEL_CHROME_PAINT_THROUGH_VERSION = "v3";

export type PluginPanelTheme = "light" | "dark";

/**
 * The appearance the host is currently showing, handed to plugin panels.
 *
 * `theme` is the user's raw preference (`light` | `dark` | `system`, or
 * `plugin:<pluginId>:<themeId>` when a plugin theme is active). `base` is the
 * palette that preference resolves to — `"system"` only when the host could
 * not resolve it, which the panel renderer treats as "follow the OS".
 * `pluginTheme` carries the active contributed theme's sanitized CSS so a
 * panel can mirror the app's custom palette exactly.
 */
export type PluginAppearance = {
  /** Raw preference stored in AppSettings.theme. */
  theme: string;
  /** Resolved palette: "light" | "dark", or "system" when unresolved. */
  base: "light" | "dark" | "system";
  /** Active app language tag (e.g. "en", "zh-CN"). */
  locale: string;
  /** The active contributed theme, when the preference selects one. */
  pluginTheme: { id: string; base: "light" | "dark"; css: string } | null;
};

export const PLUGIN_PANEL_LOCALE_ARGUMENT_PREFIX = "--pi-plugin-panel-locale=";

/**
 * Marks a plugin surface as docked inside the host work panel rather than
 * living in its own window.
 *
 * An embedded view has no window to minimize, maximize, or drag, so the preload
 * skips the control capsule and the 46px safe area entirely and reports a
 * titlebar height of 0. `window.pluginBridge` is identical either way, so the
 * same HTML entry works in both placements (ADR 0092 §2 addendum).
 */
export const PLUGIN_PANEL_EMBEDDED_ARGUMENT = "--pi-plugin-panel-embedded=1";

/**
 * Marks a plugin surface as a floating widget: a transparent, frameless window
 * with no 46px titlebar band and no host control capsule. The preload publishes
 * a titlebar height of 0, installs a drag map over the whole window, and routes
 * right-click to the host's widget menu. `window.pluginBridge` is identical to
 * a panel, so one HTML entry can serve both placements.
 */
export const PLUGIN_PANEL_WIDGET_ARGUMENT = "--pi-plugin-panel-widget=1";

/**
 * Smallest surface each placement may ask for. A panel is sized around
 * plugin-drawn content; a widget draws its own silhouette — a floating orb —
 * and may shrink far below that.
 */
export const PLUGIN_PANEL_MIN_SIZE = { width: 360, height: 280 } as const;
export const PLUGIN_PANEL_WIDGET_MIN_SIZE = { width: 120, height: 120 } as const;

export const PLUGIN_PANEL_WINDOW_CONTROL_CHANNEL =
  "pi-plugin-panel-window-control";
export const PLUGIN_PANEL_WINDOW_STATE_CHANNEL =
  "pi-plugin-panel-window-state";

export const PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS = [
  "getState",
  "minimize",
  "toggleMaximize",
  // A floating widget has no capsule, so right-click on the surface asks the
  // host for its widget menu: close, minimize, always on top. A panel answers
  // the same action with a no-op — panels keep the capsule.
  "contextMenu",
  "close",
] as const;

export type PluginPanelWindowControlAction =
  (typeof PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS)[number];

export function isPluginPanelWindowControlAction(
  value: unknown,
): value is PluginPanelWindowControlAction {
  return (
    typeof value === "string" &&
    PLUGIN_PANEL_WINDOW_CONTROL_ACTIONS.includes(
      value as PluginPanelWindowControlAction,
    )
  );
}

/**
 * Root-node opt-out of the host's native drag regions.
 *
 * A plugin page that moves its own window (through
 * `pluginBridge.widget.setBounds`) marks `document.documentElement` or
 * `document.body` with this attribute in its HTML: the preload then installs
 * no drag band and no drag segment map, so every pixel keeps delivering real
 * pointer events instead of being swallowed by `-webkit-app-region: drag`.
 */
export const PLUGIN_PANEL_NO_DRAG_ATTRIBUTE = "data-pi-plugin-no-drag";

/**
 * Bridge channel behind `pluginBridge.widget.invoke`: the host-side window
 * control a plugin's own surfaces may use — geometry, click-through,
 * always-on-top and extra widget instances.
 *
 * The invoker is identified by its own web contents, never by a payload field,
 * so no widget action can name another plugin's window, and the page a new
 * widget loads is the plugin's own verified `ui.panel` entry rather than a URL
 * the page picked.
 */
export const PLUGIN_WIDGET_INVOKE_CHANNEL = "pi-plugin-widget-invoke";

export const PLUGIN_WIDGET_ACTIONS = [
  "getState",
  "setBounds",
  "setIgnoreMouse",
  "open",
  "close",
  "setAlwaysOnTop",
] as const;

export type PluginWidgetAction = (typeof PLUGIN_WIDGET_ACTIONS)[number];

export function isPluginWidgetAction(value: unknown): value is PluginWidgetAction {
  return (
    typeof value === "string" &&
    PLUGIN_WIDGET_ACTIONS.includes(value as PluginWidgetAction)
  );
}

/**
 * Widget id of a plugin's primary surface: the `ui.panel` entry the host opened
 * for it, whether that entry runs in a panel or in a floating widget.
 * `widget.open` refuses this id — it names a window that already exists.
 */
export const PLUGIN_PANEL_PRIMARY_WIDGET_ID = "panel";

/** Charset and length of a widget id. One id is one window of one plugin. */
export const PLUGIN_WIDGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Sent to every live window of a plugin when one of its widgets opens. */
export const PLUGIN_WIDGET_OPENED_EVENT = "widget:opened";
/** Sent to the remaining windows of a plugin when one of its widgets closes. */
export const PLUGIN_WIDGET_CLOSED_EVENT = "widget:closed";

/** Window geometry in DIP, the unit both `screen` and `BrowserWindow` report. */
export type PluginWidgetBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** One display as `widget.getState` reports it. */
export type PluginWidgetDisplay = {
  /** Platform display id, stringified: it is an opaque handle, not a rank. */
  id: string;
  bounds: PluginWidgetBounds;
  workArea: PluginWidgetBounds;
  scaleFactor: number;
};

/** Answer of `widget.getState`: the calling window, the screens, the cursor. */
export type PluginWidgetState = {
  id: string;
  bounds: PluginWidgetBounds;
  displays: PluginWidgetDisplay[];
  cursor: { x: number; y: number };
};

/**
 * Payload of `widget.open`. `query` is appended to the plugin's own entry page
 * as URL search parameters; nothing here can point the window at another page.
 */
export type PluginWidgetOpenInput = {
  id: string;
  query?: Record<string, string>;
  width?: number;
  height?: number;
};
