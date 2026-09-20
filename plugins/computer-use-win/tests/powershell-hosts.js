"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Explicit test matrix, independent of the production runtime selector.
const windowsPowerShellHosts = [{ name: "Windows PowerShell 5.1", executable: "powershell.exe" }];
if (process.platform === "win32") {
  const candidates = [
    ...String(process.env.PATH || "").split(path.delimiter)
      .map(dir => dir.replace(/^"|"$/g, ""))
      .filter(dir => path.isAbsolute(dir))
      .map(dir => path.join(dir, "pwsh.exe")),
    ...[process.env.ProgramW6432, process.env.ProgramFiles].filter(Boolean)
      .map(dir => path.join(dir, "PowerShell", "7", "pwsh.exe")),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, "Microsoft", "PowerShell", "7", "pwsh.exe")] : []),
  ];
  const executable = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  if (executable) windowsPowerShellHosts.push({ name: "PowerShell 7", executable });
}
module.exports = { windowsPowerShellHosts };
