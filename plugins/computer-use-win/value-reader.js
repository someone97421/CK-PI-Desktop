"use strict";

const childProcess = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { resolvePowerShell } = require("./powershell");

const SOURCES = new Set(["uia_value_pattern", "uia_text_pattern"]);
const DEFAULT_MAX_CHARS = 4096;
const DEFAULT_MAX_NODES = 2000;
const DEFAULT_DEADLINE_MS = 4500;
const PROCESS_TIMEOUT_MS = 8000;

function boundedInteger(value, fallback, minimum, maximum) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeRole(value) {
  if (typeof value !== "string") return undefined;
  let role = value.trim();
  if (!role) return undefined;
  if (/^ControlType\./i.test(role)) role = role.slice("ControlType.".length);
  return role || undefined;
}

function normalizeInputs(target, selector) {
  if (!target || !Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid > 0xffffffff ||
      !Number.isSafeInteger(target.window_id) || target.window_id <= 0) {
    return { error: "invalid_target" };
  }
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    return { error: "invalid_selector" };
  }
  const name = typeof selector.name === "string" && selector.name.trim() ? selector.name : undefined;
  const automationId = typeof selector.automation_id === "string" && selector.automation_id.trim()
    ? selector.automation_id : undefined;
  if (name === undefined && automationId === undefined) return { error: "invalid_selector" };
  if (selector.name !== undefined && name === undefined) return { error: "invalid_selector" };
  if (selector.automation_id !== undefined && automationId === undefined) return { error: "invalid_selector" };
  const role = selector.role === undefined ? undefined : normalizeRole(selector.role);
  if (selector.role !== undefined && role === undefined) return { error: "invalid_selector" };
  const cleanSelector = {};
  if (name !== undefined) cleanSelector.name = name;
  if (automationId !== undefined) cleanSelector.automation_id = automationId;
  if (role !== undefined) cleanSelector.role = role;
  return {
    target: { pid: target.pid, window_id: target.window_id },
    selector: cleanSelector,
  };
}

function resultBase(status, code, target, selector, complete, diagnostics = {}, matchCount = 0) {
  return {
    status,
    source: null,
    code,
    match_count: matchCount,
    target: target || null,
    selector: selector || null,
    complete,
    diagnostics,
  };
}

function sameObject(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

// Only allow non-content diagnostics across the native boundary. In particular, provider
// exception messages and arbitrary helper fields can contain control text.
function safeDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const key of ["nodes_visited", "elapsed_ms", "limit", "deadline_ms", "roots_scanned", "owned_roots", "candidates_filtered"]) {
    if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 1000000) output[key] = value[key];
  }
  if (typeof value.stage === "string" && /^[a-z_]{1,32}$/.test(value.stage)) output.stage = value.stage;
  if (typeof value.provider === "string" && SOURCES.has(value.provider)) output.provider = value.provider;
  if (typeof value.is_password === "boolean") output.is_password = value.is_password;
  if (typeof value.uia_activation === "string" && /^[a-z_]{1,32}$/.test(value.uia_activation)) {
    output.uia_activation = value.uia_activation;
  }
  return output;
}

function validateHelperResult(raw, target, selector, maxChars) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!sameObject(raw.target, target) || !sameObject(raw.selector, selector)) return null;
  if (!["read", "unavailable", "error"].includes(raw.status) ||
      typeof raw.code !== "string" || raw.code.length < 1 || raw.code.length > 64 ||
      !Number.isInteger(raw.match_count) || raw.match_count < 0 || raw.match_count > 2000 ||
      typeof raw.complete !== "boolean") return null;

  const diagnostics = safeDiagnostics(raw.diagnostics);
  if (raw.status === "read") {
    if (!raw.complete || raw.match_count !== 1 || !SOURCES.has(raw.source) ||
        raw.code !== "value_read" || typeof raw.value !== "string" || raw.value.length > maxChars ||
        diagnostics.is_password !== false) return null;
    return { status: "read", source: raw.source, value: raw.value, code: raw.code,
      match_count: 1, target, selector, complete: true, diagnostics };
  }
  if (raw.source !== null && raw.source !== undefined) return null;
  // Never propagate a value attached to an unavailable/error response.
  return resultBase(raw.status, raw.code, target, selector, raw.complete, diagnostics, raw.match_count);
}

/**
 * Read an explicitly selected control without changing focus or producing input.
 * The third argument supports dependency injection (`spawnSync`, `platform`) and
 * bounded native options (`maxChars`, `maxNodes`, `deadlineMs`, `tempDir`).
 */
function readControlValue(target, selector, env = {}) {
  const normalized = normalizeInputs(target, selector);
  if (normalized.error) {
    return resultBase("error", normalized.error, normalized.target || null,
      normalized.selector || null, false, { stage: "validation" });
  }
  const cleanTarget = normalized.target;
  const cleanSelector = normalized.selector;
  const platform = env.platform === undefined ? process.platform : env.platform;
  if (platform !== "win32") {
    return resultBase("unavailable", "unsupported_platform", cleanTarget, cleanSelector, true,
      { stage: "platform" });
  }

  const maxChars = boundedInteger(env.maxChars, DEFAULT_MAX_CHARS, 0, 100000);
  const maxNodes = boundedInteger(env.maxNodes, DEFAULT_MAX_NODES, 1, DEFAULT_MAX_NODES);
  const deadlineMs = boundedInteger(env.deadlineMs, DEFAULT_DEADLINE_MS, 1, 5000);
  const input = JSON.stringify({
    target: cleanTarget,
    selector: cleanSelector,
    limits: { max_chars: maxChars, max_nodes: maxNodes, deadline_ms: deadlineMs },
  });
  const spawnSync = typeof env.spawnSync === "function" ? env.spawnSync : childProcess.spawnSync;
  const executable = resolvePowerShell({
    env: { ...process.env, ...env },
    powershellPath: env.powershellPath,
    powershellExe: env.powershellExe,
  });
  const scriptPath = env.scriptPath || path.join(__dirname, "scripts", "windows-read-value.ps1");
  const tempDir = env.tempDir || env.PI_SCRATCH_DIR || env.TEMP || process.env.PI_SCRATCH_DIR;
  if (!tempDir) return resultBase("error", "safe_temp_unavailable", cleanTarget, cleanSelector, false, { stage: "configuration" });
  let processResult;
  try {
    processResult = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath], {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir },
    });
  } catch {
    return resultBase("error", "helper_spawn_error", cleanTarget, cleanSelector, false,
      { stage: "spawn" });
  }
  if (!processResult || processResult.error) {
    const timedOut = processResult && processResult.error && processResult.error.code === "ETIMEDOUT";
    return resultBase("error", timedOut ? "helper_timeout" : "helper_spawn_error",
      cleanTarget, cleanSelector, false, { stage: "spawn" });
  }
  if (processResult.status !== 0) {
    return resultBase("error", "helper_failed", cleanTarget, cleanSelector, false,
      { stage: "helper" });
  }
  let parsed;
  try {
    const output = typeof processResult.stdout === "string" ? processResult.stdout : "";
    if (Buffer.byteLength(output, "utf8") > 256 * 1024) throw new Error("oversized");
    parsed = JSON.parse(output.trim());
  } catch {
    return resultBase("error", "invalid_helper_result", cleanTarget, cleanSelector, false,
      { stage: "helper" });
  }
  return validateHelperResult(parsed, cleanTarget, cleanSelector, maxChars) ||
    resultBase("error", "invalid_helper_result", cleanTarget, cleanSelector, false,
      { stage: "helper" });
}

module.exports = { readControlValue };
