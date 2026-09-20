"use strict";

const { gateApp } = require("./policy");
const { presentResult } = require("./runtime");
const { validateReadValue, readValueValidationError, attachReadValue } = require("./state-value");

function stringParam(description) {
  return { type: "string", description };
}

function coerceArgs(args) {
  const next = args && typeof args === "object" ? { ...args } : {};
  if (next.element_index != null) next.element_index = String(next.element_index);
  if (next.window_id != null && next.window_id !== "") next.window_id = Number(next.window_id);
  return next;
}

function truthy(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function takeObserve(args) {
  const value = truthy(args.observe);
  delete args.observe;
  return value;
}

function takeRegion(args) {
  const region = {
    x: args.region_x,
    y: args.region_y,
    width: args.region_width,
    height: args.region_height,
  };
  delete args.region_x;
  delete args.region_y;
  delete args.region_width;
  delete args.region_height;
  if ([region.x, region.y, region.width, region.height].every((item) => item === undefined)) {
    return null;
  }
  return region;
}

const TREE_DEFAULTS = {
  max_tree_depth: 20,
  max_tree_nodes: 400,
};

function applyTreeDefaults(args) {
  const next = { ...args };
  if (next.max_tree_depth == null) next.max_tree_depth = TREE_DEFAULTS.max_tree_depth;
  if (next.max_tree_nodes == null) next.max_tree_nodes = TREE_DEFAULTS.max_tree_nodes;
  if (next.include_screenshot == null) next.include_screenshot = true;
  if (next.include_tree == null) next.include_tree = true;
  return next;
}

const OBSERVE_PROP = {
  observe: {
    type: "boolean",
    description: "If true, capture state after the single action. Default false. This is observation, not proof that the business goal succeeded.",
  },
};

// region_* crop the post-action observe screenshot (or the get_app_state
// capture). Cheap verification for AX-less windows: crop only the strip that
// changes (for example a game chat box at the bottom-left) instead of reading
// a full screenshot. Detail coordinates are not window coordinates.
const REGION_PROPS = {
  region_x: { type: "number", description: "Screenshot-relative crop X of the observe screenshot" },
  region_y: { type: "number", description: "Screenshot-relative crop Y of the observe screenshot" },
  region_width: { type: "number", description: "Screenshot-relative crop width" },
  region_height: { type: "number", description: "Screenshot-relative crop height" },
};

// Matches the driver's own escalation hint ("retry with delivery_mode:
// foreground"). Foreground brings the target to the front before the single
// delivery attempt; it never authorizes a second attempt.
const DELIVERY_PROP = {
  delivery_mode: {
    type: "string",
    enum: ["background", "foreground"],
    description: "Default background. foreground brings the window to the front before the one delivery attempt; use when the driver reports background delivery unavailable.",
  },
};

function routeSecondaryAction(args) {
  const raw = String(args.action || "").trim();
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (key === "scrolldown") {
    return { name: "scroll", args: { app: args.app, element_index: args.element_index, window_id: args.window_id, direction: "down", pages: 1 } };
  }
  if (key === "scrollup") {
    return { name: "scroll", args: { app: args.app, element_index: args.element_index, window_id: args.window_id, direction: "up", pages: 1 } };
  }
  if (key === "scrollleft") {
    return { name: "scroll", args: { app: args.app, element_index: args.element_index, window_id: args.window_id, direction: "left", pages: 1 } };
  }
  if (key === "scrollright") {
    return { name: "scroll", args: { app: args.app, element_index: args.element_index, window_id: args.window_id, direction: "right", pages: 1 } };
  }
  if (key === "setvalue") {
    return { name: "set_value", args: { app: args.app, element_index: args.element_index,
      window_id: args.window_id, value: args.value ?? args.text ?? "" } };
  }
  if (key === "invoke") {
    return { name: "click", args: { app: args.app, element_index: args.element_index, window_id: args.window_id } };
  }
  // A driver's default click may prefer Invoke over SelectionItem on a file.
  // Never substitute a different accessibility operation for the requested one.
  return null;
}

const SNAPSHOT_TOOLS = new Set(["get_app_state"]);

const OCU_TOOLS = [
  {
    name: "list_apps",
    description:
      "List running desktop apps cua-driver can target. Default is running windows only (fast). Pass include_installed=true to also list installed-but-not-running apps.",
    risk: "low",
    needsApp: false,
    schema: {
      type: "object",
      properties: {
        include_installed: { type: "boolean", description: "Include installed apps that are not running. Default false." },
      },
    },
  },
  {
    name: "list_windows",
    description: "List top-level windows (pid, window_id, title, on-screen). Optional app filter.",
    risk: "low",
    needsApp: false,
    schema: {
      type: "object",
      properties: {
        app: stringParam("Optional app name filter"),
        on_screen_only: { type: "boolean", description: "Drop off-screen/minimized windows. Default false." },
      },
    },
  },
  {
    name: "launch_app",
    description: "Launch an installed app without requiring it to already be running. Prefer name from list_apps.",
    risk: "high",
    needsApp: false,
    schema: {
      type: "object",
      properties: {
        name: stringParam("App display name"),
        path: stringParam("Full path to executable"),
        launch_path: stringParam("launch_path from list_apps"),
      },
    },
  },
  {
    name: "get_app_state",
    description:
      "Observe one window, wait read-only for an AX predicate via wait_for, or request an exact native control value with read_value. Reading and waiting are separate. Image/tree versions are independent; snapshot_id alone is not image freshness. Refresh AX after an action or screenshot-only observation before element_index use.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps / list_windows"),
        window_id: { type: "number", description: "HWND from list_windows. Optional if the app has one window." },
        include_screenshot: { type: "boolean", description: "Default true. Set false to skip the grab (cheap AX reindex)." },
        include_tree: { type: "boolean", description: "Default true. Set false to skip the UIA walk (screenshot only)." },
        query: stringParam("Case-insensitive filter for tree rows; indices stay stable"),
        refresh: { type: "boolean", description: "Bypass local query cache. Default false; wait_for always uses fresh observations." },
        read_value: {
          type: "object",
          description: "Optional Windows read-only UIA ValuePattern/TextPattern lookup. Specify an observed exact name or automation_id (and optional role). No focus/input/clipboard/OCR; ambiguous, missing, password or partial reads return unavailable. Cannot combine with wait_for.",
          properties: {
            name: stringParam("Exact UIA Name; do not use a truncated label."),
            automation_id: stringParam("Exact UIA AutomationId of the target control."),
            role: stringParam("Optional exact UIA control type, for example Edit."),
          },
          anyOf: [{ required: ["name"] }, { required: ["automation_id"] }],
          additionalProperties: false,
        },
        wait_for: {
          type: "object",
          description: "Read-only AX condition. No OCR/canvas cell inference. Text is literal case-insensitive substring; name/role are exact case-insensitive matches. Values use explicit value/baseline. Missing or ambiguous value targets cannot match.",
          properties: {
            kind: { type: "string", enum: ["text_present", "text_absent", "value_equals", "value_changed"] },
            text: stringParam("Nonempty text required for text_present/text_absent."),
            name: stringParam("Nonempty accessible name required for value_equals/value_changed."),
            role: stringParam("Optional exact accessible role for value targets."),
            value: stringParam("Required expected value for value_equals; empty string is allowed."),
            baseline: stringParam("Required previous value for value_changed; empty string is allowed."),
          },
          required: ["kind"],
          additionalProperties: false,
        },
        wait_timeout_ms: { type: "integer", minimum: 0, maximum: 30000, description: "Condition wait deadline; default 10000 ms. Timeout is not success." },
        poll_interval_ms: { type: "integer", minimum: 100, maximum: 5000, description: "Condition polling interval; default 500 ms. Intermediate polls omit screenshots." },
        max_tree_depth: { type: "integer", minimum: 1, description: "Max UIA depth. Default 20." },
        max_tree_nodes: { type: "integer", minimum: 1, description: "Max UIA nodes. Default 400." },
        ...REGION_PROPS,
      },
      required: ["app"],
    },
  },
  {
    name: "click",
    description:
      "Click a fresh element_index, or screenshot-local x,y. At most one action delivery; unknown effect is not retried. Right-click selects foreground before its only attempt; it is not a left-click AX invoke. Named left-click pixel hits are upgraded only with a valid current tree. Returns structured delivery/UI-change/goal evidence; generic clicks do not prove a business goal.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Element index from the latest get_app_state"),
        x: { type: "number", description: "Window-local screenshot X" },
        y: { type: "number", description: "Window-local screenshot Y" },
        click_count: { type: "integer", description: "Click count. Default 1" },
        mouse_button: { type: "string", enum: ["left", "right", "middle"] },
        ...OBSERVE_PROP,
        ...DELIVERY_PROP,
        ...REGION_PROPS,
      },
      required: ["app"],
    },
  },
  {
    name: "perform_secondary_action",
    description: "Run supported accessibility actions: Invoke, SetValue, or directional Scroll. Select, Toggle, Expand, Collapse, ScrollIntoView, SetFocus and unknown actions are rejected without input; they are never replaced with Invoke.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Element index from the latest get_app_state"),
        action: stringParam("Secondary action name from get_app_state"),
        value: stringParam("Value when action is SetValue"),
        ...OBSERVE_PROP,
      },
      required: ["app", "element_index", "action"],
    },
  },
  {
    name: "scroll",
    description: "Scroll a window or element. Background by default. Result is verified/effect, not a screenshot.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Element index from the latest get_app_state"),
        direction: { type: "string", description: "up, down, left, or right" },
        pages: { type: "number", description: "Pages to scroll. Default 1" },
        ...OBSERVE_PROP,
        ...REGION_PROPS,
      },
      required: ["app", "direction"],
    },
  },
  {
    name: "drag",
    description: "Drag between screenshot coordinates in an app window. Background by default.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        from_x: { type: "number" },
        from_y: { type: "number" },
        to_x: { type: "number" },
        to_y: { type: "number" },
        ...OBSERVE_PROP,
        ...REGION_PROPS,
      },
      required: ["app", "from_x", "from_y", "to_x", "to_y"],
    },
  },
  {
    name: "type_text",
    description: "Type literal text into the target app (background). XAML/UWP fields need a Document/edit index; the plugin picks one from the last snapshot if omitted. Unverified results include a focus_state probe (GetGUIThreadInfo).",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Optional element index from get_app_state"),
        text: stringParam("Literal text to type"),
        ...OBSERVE_PROP,
        ...DELIVERY_PROP,
        ...REGION_PROPS,
      },
      required: ["app", "text"],
    },
  },
  {
    name: "press_key",
    description: "Press one host-OS key/chord. Windows unmodified navigation keys use one guarded native delivery without refocusing the editor or moving its caret first. Escape distinguishes editor/dropdown/menu evidence (title-bar system menu is excluded as window chrome) and reports cancellation state separately from accepted input. Partial trees never prove absence. Menu retains its editor guard. macOS uses Command, not Menu. No uncertain replay. Paste chords do not set clipboard — use paste_text. delivery_mode=foreground answers the driver's background-unavailable escalation hint.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Optional element index from get_app_state"),
        key: stringParam("Key or + separated chord"),
        ...OBSERVE_PROP,
        ...DELIVERY_PROP,
        ...REGION_PROPS,
      },
      required: ["app", "key"],
    },
  },
  {
    name: "paste_text",
    description: "Set clipboard and paste once into the currently focused target control (Ctrl+V on Windows, Command+v on macOS). Does not move the caret. Partial/unknown delivery is never replayed; verify or wait before another paste.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Legacy compatibility only; does not refocus the paste destination. Select the target control before pasting."),
        text: stringParam("Unicode text to place on the clipboard and paste"),
        ...OBSERVE_PROP,
        ...REGION_PROPS,
      },
      required: ["app", "text"],
    },
  },
  {
    name: "set_value",
    description: "Replace the value of a settable accessibility element from the latest get_app_state.",
    risk: "high",
    needsApp: true,
    schema: {
      type: "object",
      properties: {
        app: stringParam("App name from list_apps"),
        window_id: { type: "number" },
        element_index: stringParam("Element index from the latest get_app_state"),
        value: stringParam("Replacement value"),
        ...OBSERVE_PROP,
        ...REGION_PROPS,
      },
      required: ["app", "element_index", "value"],
    },
  },
];

function makeExecutors(runtime, loadSettings, dependencies = {}) {
  const executors = {};
  for (const tool of OCU_TOOLS) {
    executors[tool.name] = async (args, context) => {
      const settings = await loadSettings();
      if (settings.enabled === false) {
        return { ok: false, error: "Computer Use is disabled in plugin settings." };
      }
      const forwarded = tool.name === "get_app_state" ? applyTreeDefaults(coerceArgs(args)) : coerceArgs(args);
      const observe = SNAPSHOT_TOOLS.has(tool.name) || takeObserve(forwarded);
      const region = takeRegion(forwarded);
      if (tool.needsApp) {
        const blocked = gateApp(forwarded.app, settings);
        if (blocked) return { ok: false, error: blocked };
      }
      if (tool.name === "launch_app") {
        const blocked = gateApp(forwarded.name || forwarded.path || forwarded.launch_path, settings);
        if (blocked) return { ok: false, error: blocked };
      }
      const valueSelector = tool.name === "get_app_state" ? forwarded.read_value : undefined;
      if (valueSelector !== undefined) {
        const validation = validateReadValue(valueSelector, forwarded);
        if (validation) return readValueValidationError(validation);
        delete forwarded.read_value;
        forwarded.refresh = true;
        // read_value needs no screenshot/tree itself, but the runtime observation
        // supplies the verified target identity; never fail such requests on the
        // both-outputs-off validation.
        if ([false, "false"].includes(forwarded.include_screenshot) && [false, "false"].includes(forwarded.include_tree)) {
          forwarded.include_tree = true;
        }
      }
      context?.log?.(`${tool.name} ${forwarded.app || forwarded.name || ""}`.trim());
      if (tool.name === "perform_secondary_action") {
        const routed = routeSecondaryAction(forwarded);
        if (!routed) {
          const error = `unsupported_secondary_action: ${String(forwarded.action || "")}; no action sent. Use an observed supported command or verified keyboard navigation; Select is never replaced with Invoke.`;
          return presentResult({ isError: true, content: [{ type: "text", text: error }], structuredContent: {
            code: "unsupported_secondary_action", requested_action: forwarded.action, delivery: "not_sent", transport_sent: false,
            action_result: { schema_version: 1, action: tool.name, delivery: "not_sent", ui_change: "unchanged",
              goal: "unconfirmed", retry_safe: true, evidence: [] },
          } }, { observe: false, action: tool.name, app: forwarded.app });
        }
        const result = await runtime.callTool(routed.name, routed.args, { observe, settings });
        const structured = result && result.structuredContent || {};
        const presented = { ...result, structuredContent: { ...structured, requested_action: forwarded.action,
          ...(structured.action_result ? { action_result: { ...structured.action_result, action: tool.name, routed_action: routed.name } } : {}) } };
        return presentResult(presented, { observe, region, action: tool.name, app: forwarded.app, screenshotExpected: observe,
          env: runtime._childEnv ? runtime._childEnv() : process.env });
      }
      let result = await runtime.callTool(tool.name, forwarded, { observe, settings });
      if (valueSelector !== undefined) result = await attachReadValue(runtime,
        { ...forwarded, read_value: valueSelector }, result, dependencies.readControlValue);
      const screenshotExpected =
        tool.name === "get_app_state"
          ? forwarded.include_screenshot !== false && forwarded.include_screenshot !== "false"
          : observe && tool.name !== "list_apps" && tool.name !== "list_windows" && tool.name !== "launch_app";
      return presentResult(result, { observe, region, action: tool.name, app: forwarded.app, screenshotExpected,
        env: runtime._childEnv ? runtime._childEnv() : process.env });
    };
  }
  executors.stop_computer_use = async (_args, context) => {
    context?.log?.("stop_computer_use");
    runtime.stop("stopped by agent");
    return { ok: true, stopped: true };
  };
  return executors;
}

const STOP_TOOL = {
  name: "stop_computer_use",
  description: "Stop the local Computer Use runtime immediately. Further GUI actions need a panel restart.",
  risk: "low",
  schema: { type: "object", properties: {} },
};

module.exports = { OCU_TOOLS, STOP_TOOL, makeExecutors };
