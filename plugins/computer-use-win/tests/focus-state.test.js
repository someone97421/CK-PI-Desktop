"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { windowsPowerShellHosts } = require("./powershell-hosts");
const source = fs.readFileSync(path.join(__dirname, "../scripts/windows-focus-state.ps1"), "utf8");

for (const host of windowsPowerShellHosts) {
test(`${host.name}: focus probe accepts only the target's same-process child/owner chain`, {
  skip: process.platform !== "win32" || !process.env.PI_SCRATCH_DIR,
}, () => {
  const native = source.match(/Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@/)[1];
  // Compile the real ownership algorithm against a fake HWND graph. No user32 calls.
  const mocked = native.replace(/\s*\[DllImport\("user32\.dll"\)\] public static extern[^;]+;/g, "")
    .replace("public static class FocusProbe {", `public static class FocusProbe {
      public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid) {
        long id = hwnd.ToInt64(); pid = id == 400 || id == 401 ? 99u : 42u;
        return id == 0 || id == 999 ? 0u : 1u;
      }
      public static IntPtr GetAncestor(IntPtr hwnd, uint flags) {
        long id = hwnd.ToInt64();
        return new IntPtr(id == 101 ? 100 : id == 201 ? 200 : id == 401 ? 400 : id);
      }
      public static IntPtr GetWindow(IntPtr hwnd, uint command) {
        long id = hwnd.ToInt64();
        return new IntPtr(id == 200 ? 100 : id == 400 ? 100 : id == 500 ? 501 : id == 501 ? 500 : 0);
      }
    `);
  assert.doesNotMatch(mocked, /DllImport|extern/);
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ${quote(mocked)}
@(100,101,200,201,300,400,401,500,999,0) | ForEach-Object { [FocusProbe]::BelongsTo([IntPtr]$_, [IntPtr]100, 42) }
[FocusProbe]::BelongsTo([IntPtr]200, [IntPtr]100, 99)
`;
  const result = spawnSync(host.executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, TEMP: process.env.PI_SCRATCH_DIR, TMP: process.env.PI_SCRATCH_DIR },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).map(x => x === "True"),
    [true, true, true, true, false, false, false, false, false, false, false]);
  assert.match(source, /if \(\$foregroundBelongs\)/);
  assert.match(source, /GetWindowThreadProcessId\(\$foreground/);
  assert.doesNotMatch(source, /SetFocus|SetForegroundWindow|SendInput|SendKeys/);
});
}
