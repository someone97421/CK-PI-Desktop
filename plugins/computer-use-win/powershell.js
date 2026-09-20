"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const PROBE_TIMEOUT_MS = 2500;
const TOTAL_PROBE_BUDGET_MS = 5000;
const MAX_EXISTING_PROBES = 8;
const PROBE_COMMAND = "[Console]::Out.Write(($PSVersionTable.PSVersion.Major.ToString() + '|' + $PSVersionTable.PSEdition + '|' + [System.Environment]::OSVersion.Platform.ToString()))";

let cachedPowerShell;

function envValue(env, name) {
  const key = Object.keys(env || {}).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function defaultCandidates(env = process.env) {
  const candidates = [];
  const pathValue = envValue(env, "PATH");
  for (let dir of String(pathValue || "").split(path.win32.delimiter)) {
    dir = dir.trim().replace(/^"(.*)"$/, "$1");
    if (dir && path.win32.isAbsolute(dir)) candidates.push(path.win32.join(dir, "pwsh.exe"));
  }
  for (const root of [envValue(env, "ProgramW6432"), envValue(env, "ProgramFiles")]) {
    if (root && path.win32.isAbsolute(root)) {
      candidates.push(path.win32.join(root, "PowerShell", "7", "pwsh.exe"));
    }
  }
  const local = envValue(env, "LOCALAPPDATA");
  if (local && path.win32.isAbsolute(local)) {
    candidates.push(path.win32.join(local, "Microsoft", "PowerShell", "7", "pwsh.exe"));
    candidates.push(path.win32.join(local, "Programs", "PowerShell", "7", "pwsh.exe"));
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function probePowerShell(candidate, options = {}) {
  const run = options.spawnSync || spawnSync;
  try {
    const result = run(candidate, ["-NoProfile", "-NonInteractive", "-Command", PROBE_COMMAND], {
      encoding: "utf8",
      timeout: options.timeoutMs || PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4096,
    });
    if (!result || result.error || result.status !== 0) return false;
    const match = /^(\d+)\|Core\|Win32NT$/.exec(String(result.stdout || "").trim());
    return Boolean(match && Number(match[1]) >= 7);
  } catch {
    return false;
  }
}

function windowsPowerShellFallback(env) {
  const root = envValue(env, "SystemRoot");
  return root && path.win32.isAbsolute(root)
    ? path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function resolvePowerShell(options = {}) {
  const explicit = options.powershellPath || options.powershellExe;
  if (explicit) return explicit;
  if (cachedPowerShell !== undefined) return cachedPowerShell;

  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const now = options.now || (() => performance.now());
  const totalBudgetMs = Number.isFinite(options.totalBudgetMs)
    ? Math.max(1, options.totalBudgetMs) : TOTAL_PROBE_BUDGET_MS;
  const singleProbeTimeoutMs = Number.isFinite(options.probeTimeoutMs)
    ? Math.max(1, options.probeTimeoutMs)
    : Number.isFinite(options.probeOptions && options.probeOptions.timeoutMs)
      ? Math.max(1, options.probeOptions.timeoutMs) : PROBE_TIMEOUT_MS;
  const maxProbes = Number.isInteger(options.maxProbes) && options.maxProbes > 0
    ? options.maxProbes : MAX_EXISTING_PROBES;
  const probe = options.probe || ((candidate, probeOptions) =>
    probePowerShell(candidate, { ...options.probeOptions, ...probeOptions }));
  const candidates = options.candidates || defaultCandidates(env);
  const startedAt = now();
  let probes = 0;
  for (const candidate of candidates) {
    if (probes >= maxProbes) break;
    if (!path.win32.isAbsolute(candidate)) continue;
    try {
      if (totalBudgetMs - Math.max(0, now() - startedAt) <= 0) break;
      if (!existsSync(candidate)) continue;
      const remainingMs = totalBudgetMs - Math.max(0, now() - startedAt);
      if (remainingMs <= 0) break;
      probes += 1;
      const timeoutMs = Math.max(1, Math.min(singleProbeTimeoutMs, Math.floor(remainingMs)));
      if (probe(candidate, { timeoutMs })) {
        cachedPowerShell = candidate;
        return cachedPowerShell;
      }
    } catch {
      // A broken candidate is equivalent to an unavailable one.
    }
  }
  cachedPowerShell = windowsPowerShellFallback(env);
  return cachedPowerShell;
}

function clearPowerShellCache() {
  cachedPowerShell = undefined;
}

module.exports = {
  resolvePowerShell,
  clearPowerShellCache,
  defaultCandidates,
  probePowerShell,
};
