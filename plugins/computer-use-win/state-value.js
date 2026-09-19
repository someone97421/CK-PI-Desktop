"use strict";

function validateReadValue(selector, args) {
  if (selector === undefined) return null;
  if (args.wait_for !== undefined) return "read_value cannot combine with wait_for";
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return "read_value must be an object";
  if (Object.keys(selector).some(key => !["name", "automation_id", "role"].includes(key))) return "unknown read_value selector field";
  for (const key of ["name", "automation_id", "role"]) {
    if (selector[key] !== undefined && (typeof selector[key] !== "string" || !selector[key].trim() || selector[key].length > 1024)) {
      return `read_value.${key} must be a nonempty string of at most 1024 characters`;
    }
  }
  if (selector.name === undefined && selector.automation_id === undefined) return "read_value requires name or automation_id";
  return null;
}

function readValueValidationError(message) {
  return { ok: false, isError: true, error: message, text: message,
    content: [{ type: "text", text: message }], structuredContent: {
      code: "validation_error", action_result: { schema_version: 1, action: "get_app_state", delivery: "not_sent",
        ui_change: "unknown", goal: "unconfirmed", retry_safe: true, evidence: [] },
    } };
}

async function attachReadValue(runtime, args, result, reader) {
  const s = result?.structuredContent || {};
  const selector = args.read_value;
  const target = { pid: Number(s.pid), window_id: Number(s.window_id) };
  const epoch = runtime._sessionEpoch || 0;
  let read;
  const unavailable = (code, status = "unavailable") => ({ status, code, source: null, complete: false, match_count: 0 });
  const currentTarget = () => {
    const cache = runtime.targets;
    if (!cache || typeof cache.values !== "function") return true;
    return [...cache.values()].some(item => Number(item.pid) === target.pid && Number(item.window_id) === target.window_id);
  };
  if (runtime.stoppedByUser) read = unavailable("stopped_by_user", "error");
  else if (!result || result.isError || result.ok === false || s._capture_target_match === false || s.query_local
    || !Number.isSafeInteger(target.pid) || target.pid <= 0 || !Number.isSafeInteger(target.window_id) || target.window_id <= 0
    || (args.window_id != null && Number(args.window_id) !== target.window_id) || !currentTarget()) read = unavailable("observation_target_unavailable");
  else {
    try {
      const readControlValue = reader || require("./value-reader").readControlValue;
      read = await readControlValue(target, selector, runtime._childEnv ? runtime._childEnv() : process.env);
    } catch { read = unavailable("value_reader_failed", "error"); }
    if (runtime.stoppedByUser || epoch !== (runtime._sessionEpoch || 0) || !currentTarget()) {
      read = unavailable(runtime.stoppedByUser ? "stopped_by_user" : "session_changed", "error");
    }
  }
  if (!read || !["read", "unavailable", "error"].includes(read.status)) read = unavailable("invalid_value_result", "error");
  if (read.status === "read" && (typeof read.value !== "string" || read.complete !== true || read.match_count !== 1
      || !["uia_value_pattern", "uia_text_pattern"].includes(read.source)
      || Number(read.target?.pid) !== target.pid || Number(read.target?.window_id) !== target.window_id)) {
    read = unavailable("invalid_value_result", "error");
  }
  if (read.status !== "read") { read = { ...read }; delete read.value; }
  read = { ...read, observed_at: new Date().toISOString() };
  const text = `read_value=${read.status} code=${read.code || ""} source=${read.source || "none"}`
    + (read.status === "read" ? ` value=${JSON.stringify(read.value)}` : "; no exact value available; do not infer it from labels or rounded display text");
  return { ...result, ...(read.status === "error" ? { isError: true } : {}),
    content: [...(result?.content || []), { type: "text", text }],
    structuredContent: { ...s, read_value: read },
  };
}

module.exports = { validateReadValue, readValueValidationError, attachReadValue };
