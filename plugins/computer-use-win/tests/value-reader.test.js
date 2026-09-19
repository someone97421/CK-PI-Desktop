"use strict";
// Mocked process boundaries and static checks only; these tests never query UI Automation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readControlValue } = require("../value-reader");

const target = { pid: 42, window_id: 100 };
const selector = { automation_id: "number-editor-input-fldLZZcp9p", role: "Edit" };
const scriptPath = path.join(__dirname, "..", "scripts", "windows-read-value.ps1");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

function nativeResult(fields = {}) {
  return {
    status: "read",
    source: "uia_value_pattern",
    value: "123.00",
    code: "value_read",
    match_count: 1,
    target,
    selector,
    complete: true,
    diagnostics: { stage: "search", nodes_visited: 20, elapsed_ms: 5, limit: 2000,
      deadline_ms: 4500, provider: "uia_value_pattern", is_password: false },
    ...fields,
  };
}

function mockSpawn(output, calls = []) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    if (output instanceof Error) throw output;
    return { status: 0, stdout: JSON.stringify(output), stderr: "" };
  };
}

function invoke(output, extra = {}) {
  return readControlValue(target, selector, { platform: "win32", spawnSync: mockSpawn(output), ...extra });
}

test("serializes a bounded JSON stdin request without selector interpolation", () => {
  const calls = [];
  const tricky = { name: "quote'\"; $(bad)", automation_id: "id", role: "ControlType.Edit" };
  const echoed = { name: tricky.name, automation_id: "id", role: "Edit" };
  const result = readControlValue(target, tricky, {
    platform: "win32",
    maxChars: 17,
    maxNodes: 50,
    deadlineMs: 700,
    tempDir: "C:\\scratch",
    spawnSync: mockSpawn(nativeResult({ selector: echoed, value: "x" }), calls),
  });
  assert.equal(result.status, "read");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(calls[0].args.includes("-Sta"));
  assert.ok(calls[0].args.includes(scriptPath));
  assert.ok(!calls[0].args.some(arg => arg.includes(tricky.name)));
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    target,
    selector: echoed,
    limits: { max_chars: 17, max_nodes: 50, deadline_ms: 700 },
  });
  assert.equal(calls[0].options.timeout, 8000);
  assert.equal(calls[0].options.env.TEMP, "C:\\scratch");
  assert.equal(calls[0].options.env.TMP, "C:\\scratch");
});

test("preserves an empty UIA value as a successful read", () => {
  const result = invoke(nativeResult({ value: "", source: "uia_text_pattern",
    diagnostics: { is_password: false, provider: "uia_text_pattern" } }));
  assert.equal(result.status, "read");
  assert.equal(result.value, "");
  assert.equal(result.source, "uia_text_pattern");
});

test("rejects read claims with missing values or invalid count/completeness/source", () => {
  const missing = nativeResult();
  delete missing.value;
  for (const candidate of [missing, nativeResult({ match_count: 2 }), nativeResult({ complete: false }),
    nativeResult({ source: "name_property" })]) {
    const result = invoke(candidate);
    assert.equal(result.status, "error");
    assert.equal(result.code, "invalid_helper_result");
    assert.ok(!Object.hasOwn(result, "value"));
  }
});

test("partial and ambiguous searches remain unavailable and never expose attached text", () => {
  for (const candidate of [
    nativeResult({ status: "unavailable", source: null, code: "partial_search", complete: false,
      match_count: 1, value: "secret", diagnostics: { stage: "search", nodes_visited: 2000 } }),
    nativeResult({ status: "unavailable", source: null, code: "ambiguous_match", complete: true,
      match_count: 2, value: "secret", diagnostics: { stage: "search", nodes_visited: 30 } }),
  ]) {
    const result = invoke(candidate);
    assert.equal(result.status, "unavailable");
    assert.ok(!Object.hasOwn(result, "value"));
  }
});

test("unsupported patterns and non-Windows platforms return unavailable", () => {
  const unsupported = invoke(nativeResult({ status: "unavailable", source: null, code: "pattern_unavailable",
    match_count: 1, value: undefined }));
  assert.equal(unsupported.status, "unavailable");
  assert.equal(unsupported.code, "pattern_unavailable");

  let calls = 0;
  const platform = readControlValue(target, selector, { platform: "linux", spawnSync() { calls++; } });
  assert.equal(platform.status, "unavailable");
  assert.equal(platform.code, "unsupported_platform");
  assert.equal(calls, 0);
});

test("invalid inputs and helper failures are bounded structured errors", () => {
  assert.equal(readControlValue(target, {}, { platform: "win32" }).code, "invalid_selector");
  assert.equal(readControlValue({ pid: 0, window_id: 1 }, selector, { platform: "win32" }).code, "invalid_target");
  assert.equal(invoke(new Error("contains sensitive provider text")).code, "helper_spawn_error");
  const malformed = readControlValue(target, selector, { platform: "win32",
    spawnSync: () => ({ status: 0, stdout: "not-json", stderr: "secret" }) });
  assert.deepEqual(malformed.diagnostics, { stage: "helper" });
  assert.equal(malformed.code, "invalid_helper_result");
  const failed = readControlValue(target, selector, { platform: "win32",
    spawnSync: () => ({ status: 1, stdout: "", stderr: "secret" }) });
  assert.equal(failed.code, "helper_failed");
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test("PID/HWND echo mismatch invalidates the helper result", () => {
  const wrongTarget = invoke(nativeResult({ target: { pid: 43, window_id: 100 } }));
  assert.equal(wrongTarget.status, "error");
  assert.equal(wrongTarget.code, "invalid_helper_result");
  const changed = invoke(nativeResult({ status: "unavailable", source: null, code: "target_pid_changed",
    match_count: 0, complete: false, value: undefined }));
  assert.equal(changed.status, "unavailable");
  assert.equal(changed.code, "target_pid_changed");
});

test("password and diagnostic guards cannot leak mocked secret content", () => {
  const falseRead = invoke(nativeResult({ value: "hunter2", diagnostics: { is_password: true,
    exception: "hunter2", provider: "uia_value_pattern" } }));
  assert.equal(falseRead.status, "error");
  assert.ok(!Object.hasOwn(falseRead, "value"));
  assert.doesNotMatch(JSON.stringify(falseRead), /hunter2/);

  const blocked = invoke(nativeResult({ status: "unavailable", source: null, code: "password_blocked",
    value: "hunter2", diagnostics: { is_password: true, exception: "hunter2" } }));
  assert.equal(blocked.status, "unavailable");
  assert.equal(blocked.diagnostics.is_password, true);
  assert.ok(!Object.hasOwn(blocked, "value"));
  assert.doesNotMatch(JSON.stringify(blocked), /hunter2/);
});

test("native helper is read-only, window scoped, bounded, and does not use property fallbacks", () => {
  assert.match(scriptSource, /\[Console\]::In\.ReadToEnd\(\)/);
  assert.match(scriptSource, /GetWindowThreadProcessId/);
  assert.equal((scriptSource.match(/Get-WindowProcessId \$handle/g) || []).length, 2);
  assert.match(scriptSource, /TreeWalker\]::RawViewWalker/);
  assert.match(scriptSource, /maxNodes -gt 2000/);
  assert.match(scriptSource, /deadlineMs -gt 5000/);
  assert.match(scriptSource, /\.GetText\(\$maxChars \+ 1\)/);
  assert.match(scriptSource, /Current\.IsPassword/);
  assert.match(scriptSource, /\$current\.IsEnabled/);
  assert.match(scriptSource, /\$current\.IsOffscreen/);
  assert.doesNotMatch(scriptSource, /FindAll|RootElement|FocusedElement|GetFocusedElement|HelpText|LegacyIAccessible|\.SetFocus|SetForegroundWindow|SendInput|SendKeys|keybd_event|Set-Clipboard|Get-Clipboard|Clipboard|mouse_event|Click\s*\(/i);
  const imports = [...scriptSource.matchAll(/public static extern\s+\w+\s+(\w+)\s*\(/g)].map(match => match[1]);
  assert.deepEqual(imports, ["IsWindow", "GetWindowThreadProcessId", "GetClassName", "EnumChildWindows", "SendMessageTimeout"]);
  assert.match(scriptSource, /\$WM_GETOBJECT = 0x003D/);
  assert.match(scriptSource, /RenderWidgetHost/);
  assert.match(scriptSource, /FindRenderWidget/);
  assert.match(scriptSource, /EnumChildWindows/);
  assert.match(scriptSource, /\[IntPtr\]\(-4\)/);
  assert.match(scriptSource, /uia_activation/);
  assert.doesNotMatch(scriptSource, /0x0010|0x0100|0x0101/);
});

test("PowerShell 5.1 parses helper and compiles embedded C# without querying a GUI", {
  skip: process.platform !== "win32" || !process.env.PI_SCRATCH_DIR
    ? "requires Windows and PI_SCRATCH_DIR for compiler temporary files" : false,
}, () => {
  const nativeBlock = scriptSource.match(/Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@ \| Out-Null/);
  assert.ok(nativeBlock);
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const command = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'requires Windows PowerShell 5.1' }
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${quote(scriptPath)}, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw ($errors | ForEach-Object Message | Out-String) }
Add-Type -TypeDefinition ${quote(nativeBlock[1])}
'compiled-only'
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, TEMP: process.env.PI_SCRATCH_DIR, TMP: process.env.PI_SCRATCH_DIR },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "compiled-only");
});
