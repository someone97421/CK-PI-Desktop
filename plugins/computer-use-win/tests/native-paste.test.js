"use strict";
// Static checks and mocked transports only: never invoke a native key/focus API.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const scripts = path.join(__dirname, "..", "scripts");
const keySource = fs.readFileSync(path.join(scripts, "windows-send-key.ps1"), "utf8");
const pasteSource = fs.readFileSync(path.join(scripts, "windows-paste.ps1"), "utf8");
const nativeBlock = /Add-Type @"\r?\n([\s\S]*?)\r?\n"@/;
const windows = process.platform === "win32";
const scratch = process.env.PI_SCRATCH_DIR;
const quote = (value) => `'${value.replace(/'/g, "''")}'`;
function powershell(source) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, ...(scratch ? { TEMP: scratch, TMP: scratch } : {}) },
  });
  assert.ifError(result.error);
  return result;
}

test("paste chord builds Control/V down then reverse key-ups; menu flags stay intact", () => {
  assert.match(keySource, /\[switch\]\$Shift,\s*\[switch\]\$Control/);
  assert.match(keySource, /v = 0x56/);
  assert.match(keySource, /ushort\[\] downs = control \? new ushort\[\] \{ 0x11, vk \} : shift \? new ushort\[\] \{ 0x10, vk \} : new ushort\[\] \{ vk \}/);
  assert.match(keySource, /new INPUT\[downs.Length \* 2\]/);
  assert.match(keySource, /inputs\[i\] = Key\(downs\[i\], false\)/);
  assert.match(keySource, /Key\(downs\[downs.Length - 1 - i\], true\)/);
  assert.match(keySource, /result.expected = \(uint\)inputs.Length/);
  assert.match(keySource, /\(vk >= 0x21 && vk <= 0x28\) \|\| vk == 0x2D \|\| vk == 0x2E \|\| vk == 0x5D/);
  assert.match(keySource, /\(Extended\(vk\) \? 1u : 0u\) \| \(up \? 2u : 0u\)/);
});

test("allowlist executes with a mocked native call for every key/modifier combination", { skip: !windows }, () => {
  assert.match(keySource, nativeBlock);
  const call = /\[WinSendKey\]::Send\(\$Hwnd, \$TargetPid, \[uint16\]\$vkMap\[\$name\], \$Shift.IsPresent, \$Control.IsPresent\)/;
  assert.match(keySource, call);
  const mocked = keySource.replace(nativeBlock, "").replace(call,
    "New-MockDelivery $Hwnd $TargetPid $vkMap[$name] $Shift.IsPresent $Control.IsPresent")
    .replace("if (-not $result.ok) { exit 1 }", "");
  assert.doesNotMatch(mocked, /WinSendKey|Add-Type|DllImport/);
  const keys = ["escape", "return", "tab", "down", "up", "left", "right", "delete", "insert",
    "backspace", "end", "home", "pageup", "pagedown", "space", "menu", "f10", "v", "a", "ctrl+v"];
  const cases = keys.flatMap((key) => [false, true].flatMap((shift) =>
    [false, true].map((control) => ({ key, shift, control }))));
  const result = powershell(`
$ErrorActionPreference = 'Stop'
function New-MockDelivery($hwndValue, $target, $vk, $shift, $control) {
  $count = 2; if ($shift -or $control) { $count = 4 }
  @{ ok = $true; code = 'transport_sent'; sent = $count; expected = $count; vk = $vk
     target_hwnd = $hwndValue; target_pid = $target; shift = $shift; control = $control }
}
$script = [ScriptBlock]::Create(${quote(mocked)})
${cases.map(({ key, shift, control }) => `& $script -Hwnd 100 -TargetPid 42 -Key ${quote(key)} -Shift:$${shift} -Control:$${control}`).join("\n")}
`);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(outputs.length, cases.length);
  cases.forEach(({ key, shift, control }, i) => {
    const allowed = control ? key === "v" && !shift
      : key !== "v" && keys.indexOf(key) < 17 && (!shift || ["f10", "tab"].includes(key));
    const output = outputs[i];
    assert.equal(output.ok, allowed, JSON.stringify(cases[i]));
    assert.equal(output.code, allowed ? "transport_sent" : "unsupported_key_chord");
    assert.equal(output.sent, allowed ? (shift || control ? 4 : 2) : 0);
    if (allowed) {
      assert.equal(output.target_hwnd, 100);
      assert.equal(output.target_pid, 42);
      assert.equal(output.shift, shift);
      assert.equal(output.control, control);
      if (control) assert.equal(output.vk, 0x56);
    }
  });
});

test("PID, owned-popup, foreground, focus and held-key guards precede delivery", () => {
  const activation = keySource.slice(keySource.indexOf("static bool EnsureForeground("), keySource.indexOf("static bool CheckTarget("));
  const check = keySource.slice(keySource.indexOf("static bool CheckTarget("), keySource.indexOf("public static Result Send("));
  assert.match(activation, /!IsWindow\(hwnd\).*actualPid != pid \|\| pid == 0/);
  assert.match(activation, /!IsWindow\(root\).*actualPid != pid/);
  assert.ok(activation.indexOf("if (BelongsTo(") < activation.indexOf("SetForegroundWindow(root)"));
  assert.equal((activation.match(/SetForegroundWindow\(root\)/g) || []).length, 1);
  assert.match(keySource, /i < 32/);
  assert.match(keySource, /hwnd = GetAncestor\(hwnd, 2\)/);
  assert.match(keySource, /hwnd = GetWindow\(hwnd, 4\)/);
  assert.match(check, /!BelongsTo\(foreground, root, pid\)/);
  assert.match(check, /GetGUIThreadInfo\(thread, ref info\)/);
  assert.match(check, /!BelongsTo\(info.hwndFocus, root, pid\)/);
  assert.match(keySource, /int\[\] modifiers = \{ 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 \}/);
  assert.match(keySource, /if \(Held\(modifier\)\) \{ result.code = "modifier_held"; return result; \}/);
  assert.match(keySource, /if \(Held\(vk\)\) \{ result.code = "key_held"; return result; \}/);
  assert.match(keySource, /if \(!CheckTarget\(hwnd, pid, result\)\) return result;\s*SetLastError\(0\);\s*result.sent = SendInput/);
  assert.doesNotMatch(keySource.replace("System.Threading.Thread.Sleep(300);", ""), /AttachThreadInput|keybd_event|SetFocus|SetCaretPos|SendKeys|windows-uia-focus|Thread\.Sleep/);
});

test("partial delivery never replays: one full batch, cleanup only releases the inserted prefix", () => {
  const send = keySource.slice(keySource.indexOf("public static Result Send("));
  assert.equal((send.match(/SendInput\(/g) || []).length, 2);
  assert.equal((send.match(/SendInput\(result.expected, inputs,/g) || []).length, 1);
  assert.match(send, /if \(result.sent == result.expected\) \{\s*result.ok = true; result.code = "transport_sent"; return result;/);
  const partial = send.slice(send.indexOf('result.code = result.sent == 0'));
  assert.match(partial, /"send_input_failed" : "send_input_partial"/);
  assert.match(partial, /i < result.sent && i < inputs.Length/);
  assert.match(partial, /if \(\(inputs\[i\].U.ki.dwFlags & 2\) == 0\) pending.Add\(key\);\s*else pending.Remove\(key\)/);
  assert.match(partial, /if \(pending.Count > 0\)/);
  assert.match(partial, /cleanup\[i\] = Key\(pending\[pending.Count - 1 - i\], true\)/);
  assert.match(partial, /SendInput\(\(uint\)cleanup.Length, cleanup,/);
  assert.match(partial, /send_input_partial_cleanup_failed/);
  assert.doesNotMatch(partial, /Key\([^\n]*false\)|result.ok = true|EnsureForeground\(|CheckTarget\(/);
});

test("legacy wrapper has a single guarded helper call, no native or focus fallback", () => {
  assert.equal((pasteSource.match(/& \$helper\b/g) || []).length, 1);
  assert.match(pasteSource, /& \$helper -Hwnd \$Hwnd -TargetPid \$TargetPid -Key v -Control/);
  assert.match(pasteSource, /\$PSBoundParameters.ContainsKey\('TargetPid'\)/);
  assert.match(pasteSource, /\$PSBoundParameters.ContainsKey\('Hwnd'\)/);
  assert.ok(pasteSource.indexOf("'target_required'") < pasteSource.indexOf("Set-Clipboard"));
  assert.doesNotMatch(pasteSource, /keybd_event|SendInput|Add-Type|AttachThreadInput|SetForegroundWindow|SetFocus|windows-uia-focus|Start-Sleep|while\s*\(|foreach\s*\(/);
  assert.match(pasteSource, /if \(-not \$result.ok\) \{ exit 1 \}/);
});

const delivery = (fields = {}) => ({ ok: true, code: "transport_sent", sent: 4, expected: 4,
  foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 0, ...fields });
const wrapperCases = [
  { name: "success", value: delivery(), status: 0 },
  ...[0, 1, 2, 3].map((sent) => ({ name: `partial/failed ${sent}`, value: delivery({ ok: false,
    code: sent ? "send_input_partial" : "send_input_failed", sent }), exit: 1, status: 1 })),
  { name: "cleanup failure", value: delivery({ ok: false, sent: 2, code: "send_input_partial_cleanup_failed" }), exit: 1, status: 1 },
  { name: "bad counts", value: delivery({ sent: 2 }), status: 1 },
  { name: "wrong expected count", value: delivery({ expected: 2 }), status: 1 },
  { name: "nonzero exit despite success", value: delivery(), exit: 1, status: 1 },
  { name: "malformed JSON", raw: "not json", status: 1 },
  { name: "null JSON", raw: "null", status: 1 },
  { name: "exception", throws: true, status: 1 },
  { name: "missing PID", args: "-Hwnd 100", calls: 0, status: 1 },
  { name: "zero PID", args: "-Hwnd 100 -TargetPid 0", calls: 0, status: 1 },
  { name: "missing HWND", args: "-TargetPid 42", calls: 0, status: 1 },
  { name: "zero HWND", args: "-Hwnd 0 -TargetPid 42", calls: 0, status: 1 },
  { name: "clipboard then send", value: delivery(), clipboard: true, status: 0 },
  { name: "clipboard failure", clipboard: true, clipThrows: true, calls: 0, status: 1 },
];
for (const scenario of wrapperCases) {
  test(`legacy ${scenario.name}: JSON and exit status, no replay`, { skip: !windows }, () => {
    const helperPath = "Join-Path $PSScriptRoot 'windows-send-key.ps1'";
    assert.ok(pasteSource.includes(helperPath));
    const mocked = pasteSource.replace(helperPath, "'Invoke-MockDelivery'");
    const result = powershell(`
function Invoke-MockDelivery {
  param([int64]$Hwnd, [uint32]$TargetPid, [string]$Key, [switch]$Control)
  [Console]::Error.WriteLine('MOCK_SEND')
  if ($Hwnd -ne 100 -or $TargetPid -ne 42 -or $Key -ne 'v' -or -not $Control) { throw 'bad arguments' }
  ${scenario.throws ? "throw 'mock transport exception'" : ""}
  Set-Variable -Name LASTEXITCODE -Value ${scenario.exit || 0} -Scope 1
  ${quote(scenario.raw ?? JSON.stringify(scenario.value ?? delivery()))}
}
function Set-Clipboard {
  param($Value)
  [Console]::Error.WriteLine('MOCK_CLIPBOARD')
  ${scenario.clipThrows ? "throw 'mock clipboard exception'" : ""}
}
& {
${mocked}
} ${scenario.args ?? "-Hwnd 100 -TargetPid 42"} ${scenario.clipboard ? `-ClipFile ${quote(path.join(scripts, "windows-paste.ps1"))}` : ""}
`);
    assert.equal(result.status, scenario.status, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.ok, scenario.status === 0);
    assert.equal((result.stderr.match(/MOCK_SEND/g) || []).length, scenario.calls ?? 1);
    if (scenario.value?.ok === false) {
      assert.equal(output.sent, scenario.value.sent);
      assert.equal(output.code, scenario.value.code);
    }
    if (scenario.args) assert.equal(output.code, "target_required");
    if (scenario.clipboard) {
      assert.equal((result.stderr.match(/MOCK_CLIPBOARD/g) || []).length, 1);
      if (!scenario.clipThrows) assert.ok(result.stderr.indexOf("MOCK_CLIPBOARD") < result.stderr.indexOf("MOCK_SEND"));
    }
  });
}

test("original embedded C# compiles in Windows PowerShell 5.1 without executing it", {
  skip: !windows || !scratch ? "requires Windows and PI_SCRATCH_DIR for compiler temporary files" : false,
}, () => {
  const match = keySource.match(nativeBlock);
  assert.ok(match);
  const result = powershell(`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'requires Windows PowerShell 5.1' }
Add-Type -TypeDefinition ${quote(match[1])}
'compiled-only'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "compiled-only");
});
