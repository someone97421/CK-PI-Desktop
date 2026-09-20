"use strict";
// Mocked runtime and native transports only. No real windows or input APIs run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { windowsPowerShellHosts } = require("./powershell-hosts");
const runtimePath = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(runtimePath, "utf8");
const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-send-key.ps1"), "utf8");
const nativeBlock = /Add-Type @"\r?\n([\s\S]*?)\r?\n"@/;
const chords = [
  ...["n", "o", "s", "g", "f", "a", "z", "y", "b", "i", "u", "Home", "End", "Return", "m", "d", "1"].map(key => `Control_L+${key}`),
  "Ctrl+Shift+n", "Ctrl+Shift+l", "Ctrl+Alt+1", "Ctrl+Alt+2", "Ctrl+Alt+3",
  "F2", "F5", "F9", "F12", "Shift+F5", "Delete", "Backspace", "Space",
  "Ctrl+Shift+s", "Ctrl+w", "Alt+F4",
  ...["Home", "End", "Left", "Right", "Up", "Down", "PageUp", "PageDown", "Tab"].map(key => `Shift+${key}`),
  ...["Home", "End", "Left", "Right", "Up", "Down"].map(key => `Ctrl+Shift+${key}`),
];
const unsupported = ["Ctrl+Hyper+n", "Ctrl+Win+n", "Ctrl+Alt+Shift+1", "Ctrl+Shift+o", "Ctrl+Ctrl+n", "Ctrl+q", "Alt+F12", "Shift+F2"];
function fixture({ platform = "win32", identity = { app_name: "WINWORD" }, app = "document-alias", native, afterResolve, resolve = false } = {}) {
  const calls = { native: [], focus: [], cua: [], actions: [] };
  const target = { app: "WINWORD", pid: 42, window_id: 100, ...identity };
  const sandbox = {
    module: { exports: {} }, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.dirname(runtimePath), process: { platform, env: {} },
    require(name) {
      if (name === "./powershell") return { resolvePowerShell: () => "powershell.exe" };
      if (name === "node:child_process") return {
        spawn() { throw new Error("Unexpected spawn"); },
        spawnSync(exe, args) {
          if (args.some(arg => arg.endsWith("windows-uia-focus.ps1"))) {
            calls.focus.push(args); return { status: 0 };
          }
          assert.ok(args.some(arg => arg.endsWith("windows-send-key.ps1")));
          calls.native.push(args);
          if (native instanceof Error) throw native;
          if (native) return native;
          const expected = 2 * (1 + ["-Shift", "-Control", "-Alt"].filter(flag => args.includes(flag)).length);
          return { status: 0, stdout: JSON.stringify({ ok: true, code: "transport_sent", sent: expected, expected,
            foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 0 }) };
        },
      };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: runtimePath });
  const runtime = Object.create(sandbox.module.exports.ComputerUseRuntime.prototype);
  runtime.settings = {};
  runtime.targets = new Map(resolve ? [] : [[app.toLowerCase(), { ...target, tree_actionable: true, elements: [
    { role: "Edit", label: "Microsoft Search", element_index: 1 },
  ] }]]);
  if (!resolve) runtime._resolveTarget = async () => { if (afterResolve) afterResolve(runtime); return target; };
  runtime._childEnv = () => ({});
  runtime._cua = async (name, payload) => {
    calls.cua.push({ name, payload });
    if (name === "list_windows") return { structuredContent: { windows: [{ ...target, title: app }] } };
    if (name === "get_window_state") return { structuredContent: { elements: [], snapshot_id: "live" } };
    return { structuredContent: {} };
  };
  runtime._cuaAction = async (name, payload, observe, opts) => {
    calls.actions.push({ name, payload, observe, opts }); return { structuredContent: { effect: "unverifiable" } };
  };
  return { runtime, calls, parse: sandbox.module.exports.parseKeyChord,
    press: (key, args = {}) => runtime._dispatch("press_key", { app, key, ...args }, false) };
}

for (const key of chords) {
  test(`${key}: Office chord reaches one native batch with every modifier and no Edit refocus`, async () => {
    const f = fixture();
    const result = await f.press(key, { delivery_mode: "background" });
    const parsed = f.parse(key);
    const keys = parsed.keys || [parsed.key];
    assert.equal(f.calls.native.length, 1);
    const args = f.calls.native[0];
    assert.equal(args[args.indexOf("-Hwnd") + 1], "100");
    assert.equal(args[args.indexOf("-TargetPid") + 1], "42");
    assert.equal(args[args.indexOf("-Key") + 1], keys.find(item => !["ctrl", "shift", "alt"].includes(item)));
    for (const [modifier, flag] of [["ctrl", "-Control"], ["shift", "-Shift"], ["alt", "-Alt"]]) {
      assert.equal(args.includes(flag), keys.includes(modifier));
    }
    assert.ok(args.includes("-Office"));
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.effect, "unverifiable");
    assert.equal(result.structuredContent.path, "win32-hwnd");
    assert.equal(f.calls.focus.length, 0);
    assert.equal(f.calls.actions.length, 0);
    assert.deepEqual(f.calls.cua.map(call => call.name), []);
    assert.equal(f.runtime.targets.get("document-alias").tree_actionable, false);
  });
}

for (const identity of [
  { app_name: "WINWORD.EXE" }, { app_name: "Microsoft Word" }, { app_name: "Microsoft Excel" },
  { app_name: "POWERPNT" }, { app_name: "Microsoft PowerPoint" }, { app_name: "wps" }, { app_name: "et.exe" }, { app_name: "wpp" },
  { app_name: "Office host", process_name: "EXCEL.EXE" }, { app_name: "Office host", executable_path: "C:\\Office\\WINWORD.EXE" },
  { window_class: "OpusApp" }, { class_name: "XLMAIN" },
]) {
  test(`resolved identity ${JSON.stringify(identity)} works through a document alias and cached target`, async () => {
    const f = fixture({ identity, resolve: !!identity.app_name });
    await f.press("Ctrl+n");
    await f.press("Ctrl+Alt+1", { delivery_mode: "foreground" });
    assert.equal(f.calls.native.length, 2);
    assert.equal(f.calls.focus.length, 0);
    assert.equal(f.calls.cua.filter(call => call.name === "list_windows").length, identity.app_name ? 1 : 0);
  });
}

for (const identity of [
  { app_name: "notepad", title: "Microsoft Word" },
  { app_name: "msedge", window_class: "OpusApp" },
  { app_name: "Microsoft Word", process_name: "msedgewebview2.exe" },
  { app_name: "wordpad" }, { app_name: "officeplus" }, {},
]) {
  test(`caller Office alias/title does not authorize identity ${JSON.stringify(identity)}`, async () => {
    const f = fixture({ identity, app: "Microsoft Word" });
    await f.press("Ctrl+n");
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.actions.length, 1);
    assert.deepEqual(Array.from(f.calls.actions[0].payload.keys), ["ctrl", "n"]);
  });
}

for (const key of unsupported) {
  test(`${key}: unsupported Office modifier sets fail closed without downgrading`, async () => {
    const f = fixture();
    const result = await f.press(key);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "unsupported_key_chord");
    assert.equal(result.structuredContent.sent, 0);
    assert.equal(f.calls.native.length + f.calls.focus.length + f.calls.actions.length + f.calls.cua.length, 0);
  });
}

for (const [code, sent] of [["focus_mismatch", 0], ["target_pid_mismatch", 0], ["send_input_partial", 3], ["modifier_held", 0]]) {
  test(`Office ${code}: preserve failure and never replay or refocus`, async () => {
    const f = fixture({ native: { status: 1, stdout: JSON.stringify({ ok: false, code, sent, expected: 6,
      foreground_hwnd: 100, focus_hwnd: 900, target_hwnd: 100, target_pid: 42, last_error: 0 }) } });
    const result = await f.press("Ctrl+Alt+1");
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, code);
    assert.equal(result.structuredContent.sent, sent);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.focus.length + f.calls.actions.length, 0);
  });
}
for (const native of [{ status: 0, stdout: "unknown" }, new Error("timeout"),
  { status: 0, stdout: JSON.stringify({ ok: true, code: "transport_sent", sent: 4, expected: 4,
    foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 0 }) }]) {
  test("unknown delivery or lost multi-modifier count never falls back", async () => {
    const f = fixture({ native });
    const result = await f.press("Ctrl+Shift+n");
    assert.equal(result.isError, true);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.focus.length + f.calls.actions.length, 0);
  });
}

for (const afterResolve of [runtime => { runtime.stoppedByUser = true; }, runtime => { runtime._sessionEpoch = 1; }]) {
  test("Office delivery stops if session changes during target resolution", async () => {
    const f = fixture({ afterResolve });
    assert.equal((await f.press("Ctrl+n")).isError, true);
    assert.equal(f.calls.native.length + f.calls.focus.length + f.calls.actions.length, 0);
  });
}

test("native menu context preserves popup focus without another activation", async () => {
  const f = fixture();
  f.runtime._nativeMenuContext = { pid: 42, window_id: 100, expiresAt: Date.now() + 30000 };
  await f.press("Ctrl+n");
  assert.equal(f.calls.cua.length, 0);
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.runtime._nativeMenuContext, null);
});

for (const key of chords) {
  test(`macOS Office ${key}: existing CUA route is unchanged`, async () => {
    const f = fixture({ platform: "darwin" });
    await f.press(key);
    assert.equal(f.calls.native.length + f.calls.focus.length, 0);
    assert.equal(f.calls.actions.length, 1);
    const parsed = f.parse(key), payload = f.calls.actions[0].payload;
    if (parsed.keys) assert.deepEqual(Array.from(payload.keys), Array.from(parsed.keys));
    else assert.equal(payload.key, parsed.key);
  });
}

test("Office Ctrl+V remains paste_text with no Office mapping or focus search", async () => {
  const f = fixture();
  let paste;
  const pasteText = f.runtime._pasteText.bind(f.runtime);
  f.runtime._pasteText = (args, observe) => { paste = args; return pasteText(args, observe); };
  await f.press("Control_L+v");
  assert.equal(paste.pasteOnly, true);
  assert.equal(f.calls.native.length, 1);
  assert.ok(f.calls.native[0].includes("-Control"));
  assert.ok(!f.calls.native[0].includes("-Office"));
  assert.equal(f.calls.focus.length, 0);
});

for (const key of ["Menu", "Escape", "Shift+F10"]) {
  test(`Office ${key} retains the live cancellation guard`, async () => {
    const f = fixture();
    f.runtime._getAppState = async () => { throw new Error("untrusted tree"); };
    assert.equal((await f.press(key)).isError, true);
    assert.equal(f.calls.native.length + f.calls.focus.length + f.calls.actions.length, 0);
  });
}

const quote = value => `'${value.replace(/'/g, "''")}'`;
for (const host of windowsPowerShellHosts) {
test(`${host.name}: Office and legacy allowlists preserve modifiers without native APIs`, { skip: process.platform !== "win32" }, () => {
  const call = /\[WinSendKey\]::Send\(\$Hwnd, \$TargetPid, \[uint16\]\$vkMap\[\$name\], \$Shift.IsPresent, \$Control.IsPresent(?:, \$Alt.IsPresent)?\)/g;
  const mocked = script.replace(nativeBlock, "").replace(call, "New-MockDelivery $Hwnd $TargetPid $vkMap[$name] $Shift.IsPresent $Control.IsPresent $Alt.IsPresent")
    .replace("if (-not $result.ok) { exit 1 }", "");
  assert.doesNotMatch(mocked, /WinSendKey|Add-Type|DllImport/);
  const parse = fixture().parse;
  const cases = [...chords.map(key => ({ key, allowed: true })),
    ...unsupported.filter(key => !/Hyper|Win|Ctrl\+Ctrl/.test(key)).map(key => ({ key, allowed: false })),
    ...["n", "1", "Ctrl+v", "Ctrl+F5", "Alt+1"].map(key => ({ key, allowed: false }))];
  const legacyKeys = ["escape", "return", "tab", "down", "up", "left", "right", "delete", "insert", "backspace", "end", "home", "pageup", "pagedown", "space", "menu", "f10", "v", "n", "f12"];
  for (const key of legacyKeys) for (const control of [false, true]) for (const shift of [false, true]) for (const alt of [false, true]) {
    const allowed = !alt && (control ? key === "v" && !shift : legacyKeys.indexOf(key) < 17 && (!shift || ["tab", "f10"].includes(key)));
    cases.push({ key: [control && "Ctrl", shift && "Shift", alt && "Alt", key].filter(Boolean).join("+"), office: false, allowed });
  }
  const command = `
$ErrorActionPreference = 'Stop'
function New-MockDelivery($hwndValue, $target, $vk, $shift, $control, $alt) {
  @{ ok = $true; code = 'transport_sent'; vk = $vk; shift = $shift; control = $control; alt = $alt }
}
$script = [ScriptBlock]::Create(${quote(mocked)})
${cases.map(({ key, office = true }) => {
  const parsed = parse(key), keys = parsed.keys || [parsed.key];
  return `& $script -Hwnd 100 -TargetPid 42 -Office:$${office} -Key ${quote(keys.find(item => !["ctrl", "shift", "alt"].includes(item)))} -Control:$${keys.includes("ctrl")} -Shift:$${keys.includes("shift")} -Alt:$${keys.includes("alt")}`;
}).join("\n")}
`;
  const result = spawnSync(host.executable, ["-NoProfile", "-NonInteractive", "-Command", "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))"], {
    input: command, encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, TEMP: process.env.PI_SCRATCH_DIR, TMP: process.env.PI_SCRATCH_DIR },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(outputs.length, cases.length);
  cases.forEach(({ key, allowed }, i) => {
    assert.equal(outputs[i].ok, allowed, key);
    if (allowed) {
      const parsed = parse(key), keys = parsed.keys || [parsed.key];
      for (const [name, modifier] of [["control", "ctrl"], ["shift", "shift"], ["alt", "alt"]]) assert.equal(outputs[i][name], keys.includes(modifier), key);
    } else assert.equal(outputs[i].code, "unsupported_key_chord", key);
  });
});
}

test("foreground refusal exposes blocking identity and activation outcome without input replay", async () => {
  const f = fixture({ native: { status: 1, stdout: JSON.stringify({ ok: false, code: "foreground_mismatch",
    sent: 0, expected: 4, target_hwnd: 100, target_pid: 42, foreground_hwnd: 900,
    foreground_pid: 99, foreground_class: "BlockingDialog", focus_hwnd: 0,
    activation_attempted: true, activation_returned: false, activation_wait_ms: 300, last_error: 0 }) } });
  const result = await f.press("Ctrl+d");
  const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /foreground_hwnd=900 foreground_pid=99 foreground_class="BlockingDialog"/);
  assert.match(text, /activation_returned=false activation_wait_ms=300/);
  assert.equal(result.structuredContent.sent, 0);
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.actions.length + f.calls.focus.length, 0);
});
