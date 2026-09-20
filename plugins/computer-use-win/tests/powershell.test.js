"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolvePowerShell,
  clearPowerShellCache,
  defaultCandidates,
  probePowerShell,
} = require("../powershell");

const SYSTEM_FALLBACK = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test.afterEach(() => clearPowerShellCache());

test("builds absolute pwsh candidates without resolving relative PATH entries", () => {
  const candidates = defaultCandidates({
    Path: ".;tools;\"C:\\Tools With Spaces\";D:\\Bin",
    ProgramW6432: "C:\\Program Files",
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  });
  assert.deepEqual(candidates, [
    "C:\\Tools With Spaces\\pwsh.exe",
    "D:\\Bin\\pwsh.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Users\\tester\\AppData\\Local\\Microsoft\\PowerShell\\7\\pwsh.exe",
    "C:\\Users\\tester\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe",
  ]);
  assert.ok(candidates.every((candidate) => /^[A-Za-z]:\\/.test(candidate)));
});

test("selects the first existing candidate that passes the version probe", () => {
  const checked = [];
  const result = resolvePowerShell({
    env: { SystemRoot: "C:\\Windows" },
    candidates: ["C:\\broken\\pwsh.exe", "D:\\PowerShell 7\\pwsh.exe"],
    existsSync: () => true,
    probe(candidate) {
      checked.push(candidate);
      return candidate.startsWith("D:");
    },
  });
  assert.equal(result, "D:\\PowerShell 7\\pwsh.exe");
  assert.deepEqual(checked, ["C:\\broken\\pwsh.exe", "D:\\PowerShell 7\\pwsh.exe"]);
});

test("falls back to absolute Windows PowerShell when pwsh is absent or broken", () => {
  const missing = resolvePowerShell({
    env: { SystemRoot: "C:\\Windows" },
    candidates: ["C:\\missing\\pwsh.exe"],
    existsSync: () => false,
    probe() { throw new Error("must not probe a missing file"); },
  });
  assert.equal(missing, SYSTEM_FALLBACK);

  clearPowerShellCache();
  const broken = resolvePowerShell({
    env: { SystemRoot: "C:\\Windows" },
    candidates: ["C:\\bad\\pwsh.exe"],
    existsSync: () => true,
    probe() { throw new Error("damaged executable"); },
  });
  assert.equal(broken, SYSTEM_FALLBACK);
});

test("uses the command-name fallback only when SystemRoot is unavailable", () => {
  assert.equal(resolvePowerShell({ env: {}, candidates: [] }), "powershell.exe");
});

test("probe accepts only PowerShell 7+ Core on Windows and is bounded", () => {
  const calls = [];
  const valid = probePowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe", {
    timeoutMs: 37,
    spawnSync(exe, args, options) {
      calls.push({ exe, args, options });
      return { status: 0, stdout: "7|Core|Win32NT", stderr: "" };
    },
  });
  assert.equal(valid, true);
  assert.equal(calls[0].exe, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-NoProfile", "-NonInteractive"]);
  assert.equal(calls[0].options.timeout, 37);
  assert.equal(calls[0].options.maxBuffer, 4096);

  for (const stdout of ["6|Core|Win32NT", "7|Desktop|Win32NT", "7|Core|Unix", "garbage"]) {
    assert.equal(probePowerShell("C:\\pwsh.exe", {
      spawnSync: () => ({ status: 0, stdout, stderr: "" }),
    }), false);
  }
});

test("probe rejects timed out and damaged candidates", () => {
  const timeout = new Error("timed out");
  timeout.code = "ETIMEDOUT";
  assert.equal(probePowerShell("C:\\timeout\\pwsh.exe", {
    spawnSync: () => ({ status: null, stdout: "", error: timeout }),
  }), false);
  assert.equal(probePowerShell("C:\\damaged\\pwsh.exe", {
    spawnSync() { throw new Error("not executable"); },
  }), false);
});

test("caches automatic selection without re-probing", () => {
  let probes = 0;
  const options = {
    env: { SystemRoot: "C:\\Windows" },
    candidates: ["C:\\PowerShell\\7\\pwsh.exe"],
    existsSync: () => true,
    probe() { probes += 1; return true; },
  };
  assert.equal(resolvePowerShell(options), "C:\\PowerShell\\7\\pwsh.exe");
  assert.equal(resolvePowerShell({ ...options, probe() { throw new Error("must use cache"); } }),
    "C:\\PowerShell\\7\\pwsh.exe");
  assert.equal(probes, 1);
});

test("bounds total probe time, narrows timeout to the remaining budget, and caches fallback", () => {
  let elapsed = 0;
  let existenceChecks = 0;
  const timeouts = [];
  const options = {
    env: { SystemRoot: "C:\\Windows" },
    candidates: ["C:\\one\\pwsh.exe", "C:\\two\\pwsh.exe", "C:\\three\\pwsh.exe"],
    existsSync() { existenceChecks += 1; return true; },
    now: () => elapsed,
    probe(candidate, { timeoutMs }) {
      timeouts.push({ candidate, timeoutMs });
      elapsed += timeouts.length === 1 ? 3200 : timeoutMs;
      return false;
    },
  };
  assert.equal(resolvePowerShell(options), SYSTEM_FALLBACK);
  assert.deepEqual(timeouts.map((item) => item.timeoutMs), [2500, 1800]);
  assert.equal(existenceChecks, 2);
  assert.equal(resolvePowerShell({
    ...options,
    existsSync() { throw new Error("cached fallback must skip candidates"); },
  }), SYSTEM_FALLBACK);
});

test("probes at most eight existing candidates", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => `C:\\candidate-${index}\\pwsh.exe`);
  const probed = [];
  assert.equal(resolvePowerShell({
    env: { SystemRoot: "C:\\Windows" },
    candidates,
    existsSync: () => true,
    now: () => 0,
    probe(candidate) { probed.push(candidate); return false; },
  }), SYSTEM_FALLBACK);
  assert.deepEqual(probed, candidates.slice(0, 8));
});

test("explicit overrides bypass candidates and preserve paths with spaces", () => {
  const explicit = "C:\\Custom PowerShell\\pwsh.exe";
  assert.equal(resolvePowerShell({
    powershellPath: explicit,
    candidates: ["C:\\other\\pwsh.exe"],
    existsSync() { throw new Error("must not inspect candidates"); },
  }), explicit);
  assert.equal(resolvePowerShell({ powershellExe: "D:\\Pinned\\powershell.exe" }),
    "D:\\Pinned\\powershell.exe");
});

