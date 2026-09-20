"use strict";
// Execute the real embedded C# with all P/Invokes replaced by a window graph.
// A virtual monotonic clock makes the 300ms deadline deterministic; no GUI APIs run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { windowsPowerShellHosts } = require("./powershell-hosts");
const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-send-key.ps1"), "utf8");
const scratch = process.env.PI_SCRATCH_DIR;
const quote = value => `'${value.replace(/'/g, "''")}'`;
const mocks = `
  class Window {
    public uint pid; public long root, owner; public bool valid = true;
    public Window(uint p, long r, long o) { pid = p; root = r; owner = o; }
  }
  static Dictionary<long, Window> windows = new Dictionary<long, Window>();
  static string scenario;
  static long foreground, destination, focus;
  static bool iconic, activationReturn;
  public static int Activations, Inputs, Restores, ForegroundReads, Sleeps;
  public static long Waited;
  class MockClock {
    public static MockClock StartNew() { return new MockClock(); }
    public long ElapsedMilliseconds { get { return Waited; } }
    public static void Sleep(int ms) {
      if (ms <= 0 || ms > 300) throw new Exception("invalid sleep");
      Waited += ms; Sleeps++;
    }
  }
  static uint SendInput(uint count, INPUT[] inputs, int size) {
    Inputs++;
    if (count != 4 || inputs.Length != 4 || inputs[0].U.ki.wVk != 0x11 ||
        inputs[1].U.ki.wVk != 0x44 || inputs[2].U.ki.wVk != 0x44 ||
        inputs[3].U.ki.wVk != 0x11 || inputs[0].U.ki.dwFlags != 0 ||
        inputs[1].U.ki.dwFlags != 0 || inputs[2].U.ki.dwFlags != 2 ||
        inputs[3].U.ki.dwFlags != 2) throw new Exception("invalid Ctrl+D batch");
    return count;
  }
  static uint MapVirtualKey(uint code, uint mapType) { return code; }
  static bool IsWindow(IntPtr hwnd) {
    Window w; return windows.TryGetValue(hwnd.ToInt64(), out w) && w.valid;
  }
  static IntPtr GetForegroundWindow() {
    ForegroundReads++;
    if (Activations > 0 && (scenario != "delayed" || Waited >= 40)) foreground = destination;
    if (scenario == "final-race" && ForegroundReads >= 3) foreground = 900;
    return new IntPtr(foreground);
  }
  static int GetClassName(IntPtr hwnd, System.Text.StringBuilder className, int maxCount) {
    if (maxCount != 129) throw new Exception("class name bound changed");
    if (!IsWindow(hwnd) || (scenario == "class-query-failed" && Activations > 0)) return 0;
    string value = scenario == "long-foreign-class" ? new string('X', 200) : "MockClass" + hwnd.ToInt64();
    value = value.Substring(0, Math.Min(value.Length, maxCount - 1));
    className.Append(value); return value.Length;
  }
  static bool IsIconic(IntPtr hwnd) { return iconic; }
  static bool ShowWindow(IntPtr hwnd, int command) {
    if (hwnd.ToInt64() != 100 || command != 9) throw new Exception("invalid restore");
    Restores++; if (scenario != "restore-incomplete") iconic = false; return true;
  }
  static bool SetForegroundWindow(IntPtr hwnd) {
    if (hwnd.ToInt64() != 100) throw new Exception("activated popup");
    Activations++; return activationReturn;
  }
  static uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid) {
    Window w; pid = windows.TryGetValue(hwnd.ToInt64(), out w) ? w.pid : 0;
    return pid == 0 ? 0u : 1u;
  }
  static bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info) {
    info.hwndFocus = new IntPtr(focus); return scenario != "focus-query-failed";
  }
  static IntPtr GetAncestor(IntPtr hwnd, uint flags) {
    Window w; return new IntPtr(windows.TryGetValue(hwnd.ToInt64(), out w) ? w.root : 0);
  }
  static IntPtr GetWindow(IntPtr hwnd, uint command) {
    Window w; return new IntPtr(windows.TryGetValue(hwnd.ToInt64(), out w) ? w.owner : 0);
  }
  static short GetAsyncKeyState(int key) {
    return (short)(((scenario == "modifier-held" && key == 0x11) ||
      (scenario == "key-held" && key == 0x44)) ? -32768 : 0);
  }
  static void SetLastError(uint error) { }
  public static Result MockRun(string name) {
    scenario = name; windows.Clear();
    windows[100] = new Window(42, 100, 0);
    windows[101] = new Window(42, 100, 0);
    windows[200] = new Window(42, 200, 100);
    windows[201] = new Window(42, 200, 0);
    windows[300] = new Window(42, 300, 0);
    windows[900] = new Window(77, 900, 0);
    foreground = 900; destination = 100; focus = 101;
    iconic = false; activationReturn = true;
    Activations = Inputs = Restores = ForegroundReads = Sleeps = 0; Waited = 0;
    switch (name) {
      case "false-but-correct": activationReturn = false; break;
      case "delayed": break;
      case "never-true": destination = 900; break;
      case "never-false": destination = 900; activationReturn = false; break;
      case "owned-already": foreground = 200; focus = 201; break;
      case "target-already": foreground = 100; break;
      case "activated-owned": destination = 200; focus = 201; break;
      case "foreign-owner": windows[900].owner = 100; destination = 900; break;
      case "long-foreign-class": case "class-query-failed": destination = 900; break;
      case "zero-foreground": destination = 0; break;
      case "unrelated-same-pid": destination = 300; break;
      case "cross-pid-ancestor":
        windows[300].root = 900; windows[900].owner = 100; destination = 300; break;
      case "invalid-ancestor":
        windows[300].root = 900; windows[900].pid = 42;
        windows[900].valid = false; windows[900].owner = 100; destination = 300; break;
      case "zero-ancestor": windows[300].root = 0; destination = 300; break;
      case "invalid-foreground": windows[200].valid = false; destination = 200; break;
      case "cross-pid-chain":
        windows[200].owner = 900; windows[900].owner = 100; destination = 200; break;
      case "owner-cycle": windows[200].owner = 300; windows[300].owner = 200; destination = 200; break;
      case "focus-cross-pid-ancestor": windows[201].root = 900; windows[900].owner = 100; focus = 201; break;
      case "target-pid-mismatch": windows[100].pid = 77; break;
      case "target-invalid": windows[100].valid = false; break;
      case "target-root-cross-pid": windows[100].root = 900; break;
      case "restore-success": case "restore-incomplete": iconic = true; break;
      case "restore-no-foreground": iconic = true; destination = 900; break;
    }
    return Send(100, 42, 0x44, false, true);
  }
`;
const cases = [
  ["false-but-correct", "transport_sent", 1, 0, false],
  ["delayed", "transport_sent", 1, 40],
  ["never-true", "foreground_mismatch", 1, 300],
  ["never-false", "foreground_mismatch", 1, 300, false],
  ...["long-foreign-class", "class-query-failed", "zero-foreground"].map(name => [name, "foreground_mismatch", 1, 300]),
  ["owned-already", "transport_sent", 0, 0, false],
  ["target-already", "transport_sent", 0, 0, false],
  ["activated-owned", "transport_sent", 1, 0],
  ...["foreign-owner", "unrelated-same-pid", "cross-pid-ancestor", "invalid-ancestor", "zero-ancestor",
    "invalid-foreground", "cross-pid-chain", "owner-cycle"].map(name => [name, "foreground_mismatch", 1, 300]),
  ["focus-cross-pid-ancestor", "focus_mismatch", 1, 0],
  ...["target-pid-mismatch", "target-invalid", "target-root-cross-pid"].map(name => [name, "target_pid_mismatch", 0, 0, false]),
  ["final-race", "foreground_mismatch", 1, 0],
  ["modifier-held", "modifier_held", 1, 0],
  ["key-held", "key_held", 1, 0],
  ["focus-query-failed", "focus_query_failed", 1, 0],
  ["restore-success", "transport_sent", 1, 300],
  ["restore-incomplete", "restore_incomplete", 1, 300],
  ["restore-no-foreground", "foreground_mismatch", 1, 300],
];

test("embedded activation is bounded, read-only after one activation, and never forces focus", () => {
  const activation = source.slice(source.indexOf("static bool EnsureForeground("), source.indexOf("static bool CheckTarget("));
  assert.equal((activation.match(/SetForegroundWindow\(root\)/g) || []).length, 1);
  assert.match(activation, /long remaining = 300 - result.activation_wait_ms/);
  assert.match(activation, /Thread.Sleep\(\(int\)Math.Min\(20, remaining\)\)/);
  assert.doesNotMatch(source, /AttachThreadInput|SetFocus|keybd_event|SendKeys/);
  const loop = activation.slice(activation.indexOf("while (true)"));
  assert.doesNotMatch(loop, /SetForegroundWindow|ShowWindow|SendInput/);
  assert.equal((source.match(/SendInput\(result.expected, inputs,/g) || []).length, 1);
  assert.doesNotMatch(source, /GetWindowText|WM_GETTEXT/);
  assert.equal((source.match(/result.foreground_hwnd =/g) || []).length, 1);
});

for (const host of windowsPowerShellHosts) {
test(`${host.name}: real embedded C# activation and final guards against mocked windows`, {
  skip: process.platform !== "win32" || !scratch ? "requires Windows PowerShell and PI_SCRATCH_DIR" : false,
}, async t => {
  const match = source.match(/Add-Type @"\r?\n([\s\S]*?)\r?\n"@/);
  assert.ok(match);
  const imports = /\[DllImport\([^\r\n]+\)\]\s*static extern [^;]+;/g;
  assert.equal((match[1].match(imports) || []).length, 14);
  let mocked = match[1].replace(imports, "");
  assert.equal((mocked.match(/System.Diagnostics.Stopwatch.StartNew\(\)/g) || []).length, 1);
  assert.equal((mocked.match(/System.Threading.Thread.Sleep/g) || []).length, 2);
  mocked = mocked.replace("System.Diagnostics.Stopwatch.StartNew()", "MockClock.StartNew()")
    .replaceAll("System.Threading.Thread.Sleep", "MockClock.Sleep")
    .replace("public static class WinSendKey {", `public static class WinSendKey {\n${mocks}`);
  assert.doesNotMatch(mocked, /DllImport|extern\s|user32\.dll|kernel32\.dll/);
  const command = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ${quote(mocked)}
${cases.map(([name]) => `$result = [WinSendKey]::MockRun(${quote(name)})
@{ name = ${quote(name)}; result = $result; activations = [WinSendKey]::Activations; inputs = [WinSendKey]::Inputs; restores = [WinSendKey]::Restores; waited = [WinSendKey]::Waited; sleeps = [WinSendKey]::Sleeps; reads = [WinSendKey]::ForegroundReads } | ConvertTo-Json -Compress`).join("\n")}
`;
  const run = spawnSync(host.executable, ["-NoProfile", "-NonInteractive", "-Command",
    "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))"], {
    input: command, encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const outputs = run.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(outputs.length, cases.length);
  for (const [i, [name, code, activations, waited, returned = true]] of cases.entries()) {
    await t.test(name, () => {
      const row = outputs[i], result = row.result, sent = code === "transport_sent";
      assert.equal(row.name, name);
      assert.equal(result.code, code);
      assert.equal(result.ok, sent);
      assert.equal(result.sent, sent ? 4 : 0);
      assert.equal(result.expected, 4);
      assert.equal(row.activations, activations);
      assert.equal(row.inputs, sent ? 1 : 0);
      assert.equal(result.activation_attempted, activations === 1);
      assert.equal(result.activation_returned, returned);
      assert.equal(result.activation_wait_ms, waited);
      assert.equal(row.waited, waited);
      assert.equal(row.restores, name.startsWith("restore-") ? 1 : 0);
      assert.equal(row.sleeps, name.startsWith("restore-") ? 1 : waited / 20);
      assert.ok(row.reads <= 18, "foreground polling must remain bounded");
      assert.ok(result.foreground_class.length <= 128);
      assert.equal(result.foreground_pid, result.foreground_hwnd === 0 ? 0 : result.foreground_hwnd === 900 ? 77 : 42);
      const expectedClass = name === "long-foreign-class" ? "X".repeat(128)
        : ["class-query-failed", "zero-foreground", "invalid-foreground"].includes(name) ? "" : `MockClass${result.foreground_hwnd}`;
      assert.equal(result.foreground_class, expectedClass);
      if (name === "owned-already" || name === "activated-owned") {
        assert.equal(result.foreground_hwnd, 200);
        assert.equal(result.focus_hwnd, 201);
      }
      if (["never-true", "never-false", "final-race", "foreign-owner", "long-foreign-class", "class-query-failed", "restore-no-foreground"].includes(name) || name.startsWith("target-" ) && name !== "target-already") {
        assert.equal(result.foreground_hwnd, 900);
        assert.equal(result.focus_hwnd, 0);
      }
    });
  }
});
}
