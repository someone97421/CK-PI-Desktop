"use strict";
// Explicit opt-in: creates only its own empty form and standard save dialog.
// No Save click, keyboard/mouse input, or document write is performed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { readControlValue } = require("../value-reader");
const { windowsPowerShellHosts } = require("./powershell-hosts");

const skip = process.env.COMPUTER_USE_NATIVE_DIALOG_TEST !== "1"
  ? "set COMPUTER_USE_NATIVE_DIALOG_TEST=1 to open an isolated standard save dialog"
  : process.platform !== "win32" || !process.env.PI_SCRATCH_DIR
    ? "requires Windows desktop and PI_SCRATCH_DIR" : false;

for (const host of windowsPowerShellHosts) {
test(`${host.name}: standard SaveFileDialog filename is an Edit with a Unicode UIA value`, { skip, timeout: 35000 }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, "value-standard-dialog-"));
  const ready = path.join(dir, "ready.json");
  const filename = "PI-value-文件名-é-😀.docx";
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DialogFixtureNative {
    public static System.Threading.Timer Watchdog;
    public static void StartWatchdog() {
        Watchdog = new System.Threading.Timer(delegate(object state) {
            System.Diagnostics.Process.GetCurrentProcess().Kill();
        }, null, 30000, System.Threading.Timeout.Infinite);
    }
    public delegate bool Callback(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    public static bool Ready(IntPtr owner, uint pid) {
        bool ready = false;
        EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
            uint actual; GetWindowThreadProcessId(hwnd, out actual);
            if (actual != pid || GetWindow(hwnd, 4) != owner || !IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(64); GetClassName(hwnd, name, name.Capacity);
            if (name.ToString() == "#32770") { ready = true; return false; }
            return true;
        }, IntPtr.Zero);
        return ready;
    }
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = 'PI isolated value reader regression'
$form.Width = 320
$form.Height = 180
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.InitialDirectory = ${quote(dir)}
$dialog.FileName = ${quote(filename)}
$dialog.Filter = 'Word document (*.docx)|*.docx'
$dialog.AddExtension = $false
$dialog.AutoUpgradeEnabled = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
    if ([DialogFixtureNative]::Ready($form.Handle, [uint32]$PID)) {
        $timer.Stop()
        $json = @{ pid = $PID; window_id = $form.Handle.ToInt64() } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText(${quote(ready)}, $json, (New-Object System.Text.UTF8Encoding $false))
    }
})
# A process-local watchdog also bounds fixture lifetime if its Node parent fails.
[DialogFixtureNative]::StartWatchdog()
$form.Add_Shown({ $timer.Start(); [void]$dialog.ShowDialog($form); $form.Close() })
try { [System.Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); [DialogFixtureNative]::Watchdog.Dispose(); $dialog.Dispose(); $form.Dispose() }
`;
  let child;
  let closed;
  let watchdog;
  let failure;
  let stderr = "";
  try {
    const scriptPath = path.join(dir, "dialog.ps1");
    fs.writeFileSync(scriptPath, `\ufeff${script}`);
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir },
    });
    closed = new Promise(resolve => child.once("close", resolve));
    child.on("error", error => { failure = error; });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-8192); });
    watchdog = setTimeout(() => child.kill(), 30000);
    const deadline = Date.now() + 15000;
    let target;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, stderr || "fixture exited before readiness");
      if (fs.existsSync(ready)) {
        try { target = JSON.parse(fs.readFileSync(ready, "utf8")); } catch { /* file may still be writing */ }
        if (target) break;
      }
      await delay(100);
    }
    assert.ok(target, `dialog readiness timed out: ${stderr}`);
    assert.equal(target.pid, child.pid, "only query the process spawned by this test");
    assert.ok(Number.isSafeInteger(target.window_id) && target.window_id > 0);
    await delay(500);
    // The automation ID is stable; the accessible name depends on the OS locale.
    const result = readControlValue(target, { automation_id: "1001", role: "Edit" }, {
      tempDir: dir, powershellPath: host.executable,
    });
    assert.equal(result.status, "read", JSON.stringify(result));
    assert.equal(result.source, "uia_value_pattern");
    assert.equal(result.value, filename);
    assert.equal(result.match_count, 1);
    assert.equal(result.complete, true);
    assert.ok(result.diagnostics.owned_roots >= 1);
    assert.ok(result.diagnostics.roots_scanned >= 2);
    assert.equal(fs.existsSync(path.join(dir, filename)), false, "fixture must never save a document");
    assert.equal(stderr, "");
  } finally {
    clearTimeout(watchdog);
    if (child && child.pid) {
      child.kill();
      const cleanupTimeout = new AbortController();
      try {
        await Promise.race([closed, delay(5000, null, { signal: cleanupTimeout.signal })
          .then(() => { throw new Error("fixture termination timed out"); })]);
      } finally { cleanupTimeout.abort(); }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}
