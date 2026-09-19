"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vendor = require("./vendor.json");
const ARCHIVE = path.join(__dirname, "vendor", "cua-windows-x64.zip");
let runtimeDir = null;
let driverHome = null;
let cached = null;
let verified = false;

function configure(dataPath) {
  runtimeDir = path.join(dataPath, "runtime", `windows-x64-${vendor.version}`);
  driverHome = path.join(dataPath, "driver-home");
  fs.mkdirSync(driverHome, { recursive: true });
  cached = null;
  verified = false;
}
function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function intact() {
  return runtimeDir && Object.entries(vendor.files).every(([name, expected]) => {
    try { return digest(path.join(runtimeDir, name)) === expected; } catch { return false; }
  });
}
function materialize() {
  if (intact()) return;
  if (digest(ARCHIVE) !== vendor.archiveSha256) throw new Error("包内运行文件损坏，请重新导入 Win 版插件包。");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const result = runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "scripts", "extract-runtime.ps1"), "-Archive", ARCHIVE, "-Destination", runtimeDir], 60_000);
  if (result.status !== 0 || result.error) throw new Error(result.error || result.stderr || "运行文件解压失败。");
  if (!intact()) throw new Error("运行文件校验失败，请重新导入 Win 版插件包。");
}

/** 普通状态读取使用缓存；启动和修复时才准备并验证运行环境。 */
function probe({ refresh = false, verify = false } = {}) {
  if (refresh) { cached = null; verified = false; }
  const binary = runtimeDir ? path.join(runtimeDir, "cua-driver.exe") : "";
  if (!cached) {
    let error = null;
    if (process.platform !== "win32" || process.arch !== "x64") error = "此插件包仅适用于 Windows x64。";
    else if (!runtimeDir) error = "插件数据目录不可用，请重新加载插件。";
    else if (!fs.existsSync(ARCHIVE)) error = "包内运行文件缺失，请重新导入 Win 版插件包。";
    cached = { installed: !error, bundled: true, path: binary, version: vendor.version, mcpCommand: binary, mcpArgs: ["mcp"], error };
  }
  if (verify && cached.installed && !verified) {
    try {
      materialize();
      const result = runCapture(binary, ["manifest"], 15_000);
      if (result.status !== 0 || result.error) throw new Error(result.error || result.stderr || `驱动检查退出：${result.status}`);
      if (JSON.parse(result.stdout).binary_version !== vendor.version) throw new Error("驱动版本不一致，请重新导入插件包。");
      verified = true;
    } catch (error) {
      cached = { ...cached, installed: false, error: error.message || String(error) };
    }
  }
  return { ...cached, mcpArgs: [...cached.mcpArgs] };
}
/** 驱动配置需持久保存；宿主精简环境时使用插件自己的用户目录。 */
function childEnv() {
  const env = { ...process.env };
  const home = env.HOME || env.USERPROFILE || driverHome;
  if (home) {
    env.HOME = env.HOME || home;
    env.USERPROFILE = env.USERPROFILE || home;
  }
  return env;
}
function runCapture(exe, args, timeout) {
  const result = spawnSync(exe, args, { env: childEnv(), encoding: "utf8", timeout, windowsHide: true, maxBuffer: 2_000_000 });
  return { status: result.status, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim(), error: result.error?.message || "" };
}
function doctor() {
  const info = probe({ refresh: true, verify: true });
  if (!info.installed || info.error) return { code: 1, text: info.error };
  const result = runCapture(info.mcpCommand, ["doctor"], 20_000);
  return { code: result.status ?? 1, text: `${result.stdout}\n${result.stderr}`.trim() || result.error || `doctor exited ${result.status}` };
}
module.exports = { configure, probe, doctor, childEnv };
