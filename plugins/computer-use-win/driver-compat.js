"use strict";

const TOKEN_ACTIONS = new Set(["click", "scroll", "type_text", "press_key", "hotkey", "set_value"]);
const PRE_DISPATCH_CODES = new Set([
  "window_target_mismatch", "window_target_not_found", "window_target_ambiguous",
  "session_ended", "element_not_visible",
]);

function usesTokenContract(version) {
  const match = /^v?(\d+)\.(\d+)\.\d+(?:[-+]|$)/.exec(String(version || ""));
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 53));
}

function driverRequest(name, args, modern) {
  if (!modern) return args;
  if (name === "set_config" && args.key === "max_image_dimension") {
    return { max_image_dimension: args.value };
  }
  if (name === "get_window_state") return { ...args, tree_format: "elements" };
  if (TOKEN_ACTIONS.has(name)) {
    const { element_index, snapshot_id, ...payload } = args;
    return payload;
  }
  return args;
}

function windowBounds(record) {
  const bounds = record?.bounds || record?.window_bounds || record;
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height } : null;
}

function sameWindowBounds(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function sameWindow(record, target) {
  return record?.pid === target.pid && record?.window_id === target.window_id;
}

function validWindow(record) {
  return Number.isSafeInteger(record?.pid) && record.pid > 0
    && Number.isSafeInteger(record?.window_id) && record.window_id > 0;
}

function screenshotFrame(state, actualSize, target) {
  const { screenshot_width: width, screenshot_height: height, capture_id: id } = state;
  const bounds = windowBounds(state.window_bounds);
  if (!validWindow(state) || !sameWindow(state, target) || !bounds
    || typeof id !== "string" || !id.length || width !== actualSize.width || height !== actualSize.height
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  return { pid: state.pid, window_id: state.window_id, id, width, height, bounds };
}

function pointsInsideFrame(frame, points) {
  return points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)
    && x >= 0 && y >= 0 && x < frame.width && y < frame.height);
}

function driverResponse(name, result, args, modern) {
  if (!modern || !result?.structuredContent) return result;
  const state = result.structuredContent;
  if ((name === "list_windows" || name === "launch_app") && Array.isArray(state.windows)) {
    const windows = state.windows.map((record) => {
      const bounds = windowBounds(record);
      return bounds ? { ...record, bounds } : record;
    });
    return { ...result, structuredContent: { ...state, windows } };
  }
  if (result.isError && (TOKEN_ACTIONS.has(name) || name === "drag" || name === "launch_app")) {
    const code = state.refusal?.code || state.code;
    const captureRefused = args.capture_id && state.effect === "refused" && /^Capture-bound click refused:/.test(result.content?.[0]?.text || "");
    if (PRE_DISPATCH_CODES.has(code) || captureRefused) {
      return { ...result, structuredContent: { ...state, delivery: "not_sent", transport_sent: false } };
    }
  }
  return result;
}

module.exports = {
  usesTokenContract, driverRequest, driverResponse, validWindow, sameWindow, windowBounds,
  sameWindowBounds, screenshotFrame, pointsInsideFrame,
};
