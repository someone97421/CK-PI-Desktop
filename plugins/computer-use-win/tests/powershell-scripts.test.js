"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { windowsPowerShellHosts } = require("./powershell-hosts");

const scriptsDir = path.join(__dirname, "..", "scripts");
const scriptNames = fs.readdirSync(scriptsDir).filter(name => name.endsWith(".ps1")).sort();
const sources = Object.fromEntries(scriptNames.map(name => [name,
  fs.readFileSync(path.join(scriptsDir, name), "utf8")]));
const scratch = process.env.PI_SCRATCH_DIR;
const canRun = process.platform === "win32" && Boolean(scratch);
const helperEnv = scratch ? { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch } : process.env;

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodedCommand(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function run(host, args, input) {
  return spawnSync(host.executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
      encoding: "utf8", input, timeout: 60000, windowsHide: true, env: helperEnv,
    });
}

function extract(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing embedded C# block: ${label}`);
  return match[1];
}

function temporaryCSharpFiles() {
  const blocks = [
    ["read-native", extract(sources["windows-read-value.ps1"],
      /Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@ \| Out-Null/, "read native")],
    ["send-key", extract(sources["windows-send-key.ps1"],
      /Add-Type @"\r?\n([\s\S]*?)\r?\n"@/, "send key")],
    ["focus-state", extract(sources["windows-focus-state.ps1"],
      /Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@/, "focus state")],
    ["capture", extract(sources["windows-capture.ps1"],
      /Add-Type @"\r?\n([\s\S]*?)\r?\n"@/, "capture")],
    ["foreground", extract(sources["windows-foreground.ps1"],
      /Add-Type @"\r?\n([\s\S]*?)\r?\n"@/, "foreground")],
    ["read-bootstrap", extract(sources["windows-read-value.ps1"],
      /Add-Type -ReferencedAssemblies [^\r\n]+ -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@ \| Out-Null/,
      "read provider bootstrap")],
    ["banner", extract(sources["windows-banner.ps1"],
      /Add-Type -ReferencedAssemblies \$bannerReferences @"\r?\n([\s\S]*?)\r?\n"@/,
      "banner")],
  ];
  return blocks.map(([label, code], index) => {
    const file = path.join(scratch, `pi-computer-use-${process.pid}-${index}-${label}.cs`);
    fs.writeFileSync(file, code, "utf8");
    return { label, file };
  });
}

function compileCommand(files) {
  const byLabel = Object.fromEntries(files.map(item => [item.label, item.file]));
  const ordinary = ["read-native", "send-key", "focus-state", "capture", "foreground"];
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${ordinary.map(label => `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${psQuote(byLabel[label])}))`).join("\n")}
$uiaReference = [System.Windows.Automation.AutomationElement].Assembly.Location
Add-Type -ReferencedAssemblies $uiaReference -TypeDefinition ([IO.File]::ReadAllText(${psQuote(byLabel["read-bootstrap"])}))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bannerReferences = if ($PSVersionTable.PSEdition -eq 'Core') {
  @([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.Location } |
    ForEach-Object { $_.Location } | Sort-Object -Unique)
} else {
  @('System.Windows.Forms', 'System.Drawing')
}
Add-Type -ReferencedAssemblies $bannerReferences -TypeDefinition ([IO.File]::ReadAllText(${psQuote(byLabel.banner)}))
'compiled-only'
`;
}

test("PowerShell compatibility guards and UIA bootstrap remain intact", () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /\[Console\]::InputEncoding = New-Object System\.Text\.UTF8Encoding \$false/,
      `${name} input encoding`);
    assert.match(source, /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding \$false/,
      `${name} output encoding`);
  }
  const reader = sources["windows-read-value.ps1"];
  assert.match(reader, /MethodImplOptions\.NoInlining/);
  assert.match(reader, /RegisterClientSideProviders\(new ClientSideProviderDescription\[0\]\)/);
  assert.ok(reader.indexOf("[ValueReaderProviderBootstrap]::Initialize()") <
    reader.indexOf("[System.Windows.Automation.TreeWalker]::RawViewWalker"));
  assert.match(reader, /OwnerPath\(\$rootHandle, \$handle, \$targetPid\)/);
  assert.match(reader, /Current\.IsPassword/);
  assert.match(reader, /\$maxNodes -gt 2000/);
  assert.match(reader, /\$deadlineMs -gt 5000/);
  assert.match(sources["windows-banner.ps1"], /\[AppDomain\]::CurrentDomain\.GetAssemblies\(\)/);
});

test("all production scripts parse in each installed Windows PowerShell host", {
  skip: canRun ? false : "requires Windows and PI_SCRATCH_DIR",
}, () => {
  assert.ok(windowsPowerShellHosts.some(host => host.name === "Windows PowerShell 5.1"));
  const command = `
$ErrorActionPreference = 'Stop'
${scriptNames.map(name => `$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(path.join(scriptsDir, name))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw (${psQuote(name)} + ': ' + ($errors | ForEach-Object Message | Out-String)) }`).join("\n")}
'parsed-only'
`;
  for (const host of windowsPowerShellHosts) {
    const result = run(host, ["-EncodedCommand", encodedCommand(command)]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${host.name}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "parsed-only");
  }
});

test("embedded C# compiles in installed hosts without starting UI or sending input", {
  skip: canRun ? false : "requires Windows and PI_SCRATCH_DIR",
}, () => {
  const files = temporaryCSharpFiles();
  try {
    const command = compileCommand(files);
    for (const host of windowsPowerShellHosts) {
      const result = run(host, ["-Sta", "-EncodedCommand", encodedCommand(command)]);
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${host.name}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), "compiled-only");
    }
  } finally {
    for (const { file } of files) fs.rmSync(file, { force: true });
  }
});

test("installed hosts preserve UTF-8 and stop at read-only or mocked boundaries", {
  skip: canRun ? false : "requires Windows and PI_SCRATCH_DIR",
}, () => {
  const invalidHwnd = "2147483647";
  const invalidPid = "2147483647";
  const selectorName = "文件名 😀";
  const request = JSON.stringify({
    target: { pid: 1, window_id: Number(invalidHwnd) },
    selector: { name: selectorName, role: "Edit" },
    limits: { max_chars: 10, max_nodes: 10, deadline_ms: 100 },
  });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

  for (const host of windowsPowerShellHosts) {
    const invoke = (name, args = [], input) => run(host,
      ["-Sta", "-File", path.join(scriptsDir, name), ...args], input);

    const reader = invoke("windows-read-value.ps1", [], request);
    assert.equal(reader.status, 0, `${host.name} reader: ${reader.stderr}`);
    const readResult = JSON.parse(reader.stdout);
    assert.equal(readResult.code, "target_pid_mismatch");
    assert.equal(readResult.selector.name, selectorName);

    const paste = invoke("windows-paste.ps1");
    assert.equal(paste.status, 1);
    assert.equal(JSON.parse(paste.stdout).code, "target_required");

    const send = invoke("windows-send-key.ps1",
      ["-Hwnd", invalidHwnd, "-TargetPid", "1", "-Key", "escape"]);
    assert.equal(send.status, 1);
    assert.equal(JSON.parse(send.stdout).code, "target_pid_mismatch");

    const focus = invoke("windows-focus-state.ps1",
      ["-Hwnd", invalidHwnd, "-TargetPid", "1"]);
    assert.equal(focus.status, 1);
    assert.equal(JSON.parse(focus.stdout).error, "no-thread");

    const uiaFocus = invoke("windows-uia-focus.ps1", ["-Hwnd", "0"]);
    assert.equal(uiaFocus.status, 1);
    assert.equal(JSON.parse(uiaFocus.stdout).error, "no-hwnd");

    const capture = invoke("windows-capture.ps1", ["-ProcessId", invalidPid]);
    assert.equal(capture.status, 0, `${host.name} capture: ${capture.stderr}`);
    assert.equal(JSON.parse(capture.stdout).error, "no visible window");

    const foreground = invoke("windows-foreground.ps1", ["-ProcessId", invalidPid]);
    assert.equal(foreground.status, 0, `${host.name} foreground: ${foreground.stderr}`);
    assert.equal(JSON.parse(foreground.stdout).error, "no window");

    const crop = invoke("windows-crop.ps1",
      ["-X", "0", "-Y", "0", "-Width", "1", "-Height", "1"], png);
    assert.equal(crop.status, 0, `${host.name} crop: ${crop.stderr}`);
    const cropResult = JSON.parse(crop.stdout);
    assert.equal(cropResult.ok, true);
    assert.equal(cropResult.width, 1);

    const jpeg = invoke("windows-jpeg.ps1", [], cropResult.png);
    assert.equal(jpeg.status, 0, `${host.name} jpeg: ${jpeg.stderr}`);
    assert.equal(JSON.parse(jpeg.stdout).ok, true);
  }
});
