"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const vendor = require("./vendor.json");
const ARCHIVE = path.join(__dirname, "vendor", "cua-macos.tar.gz");
let dataDir;
let runtimeDir;
let binary;
let socket;
let cached;
let verified = false;
let preparing;
let generation = 0;

function configure(dataPath) {
  dataDir = dataPath;
  runtimeDir = path.join(dataPath, "runtime");
  binary = path.join(runtimeDir, "CuaDriver.app", "Contents", "MacOS", "cua-driver");
  const key = crypto.createHash("sha256").update(dataPath).digest("hex").slice(0, 16);
  socket = path.join(os.tmpdir(), `pi-cu-${key}.sock`);
  cached = null;
  verified = false;
}
function childEnv() { return { ...process.env }; }
function digest(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function intact() {
  return runtimeDir && Object.entries(vendor.files).every(([name, hash]) => {
    try { return digest(path.join(runtimeDir, name)) === hash; } catch { return false; }
  });
}
function runCapture(exe, args, timeout = 15_000) {
  const result = spawnSync(exe, args, { env: childEnv(), encoding: "utf8", timeout, maxBuffer: 2_000_000 });
  return { status: result.status, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim(), error: result.error?.message || "" };
}
function materialize() {
  if (intact()) return;
  if (digest(ARCHIVE) !== vendor.archiveSha256) throw new Error("包内运行环境损坏，请重新导入 Mac 版插件包。");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const extracted = runCapture("/usr/bin/tar", ["-xzf", ARCHIVE, "-C", runtimeDir], 60_000);
  if (extracted.status !== 0 || extracted.error) throw new Error(extracted.error || extracted.stderr || "运行环境解压失败。");
  for (const name of ["cua-driver", "cua-cursor-theme"]) {
    fs.chmodSync(path.join(runtimeDir, "CuaDriver.app", "Contents", "MacOS", name), 0o755);
  }
  if (!intact()) throw new Error("运行环境校验失败，请重新导入 Mac 版插件包。");
  // 保留官方应用签名，辅助功能和屏幕录制授权绑定到这份稳定路径的应用。
  const signed = runCapture("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(runtimeDir, "CuaDriver.app")]);
  if (signed.status !== 0 || signed.error) throw new Error(signed.error || signed.stderr || "Mac 驱动签名校验失败。");
}
function probe({ refresh = false, verify = false } = {}) {
  if (refresh) { cached = null; verified = false; }
  if (!cached) {
    let error = null;
    if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) error = "此插件包仅适用于 Apple Silicon 或 Intel Mac。";
    else if (!dataDir) error = "插件数据目录不可用，请重新加载插件。";
    else if (!fs.existsSync(ARCHIVE)) error = "包内运行环境缺失，请重新导入 Mac 版插件包。";
    cached = { installed: !error, bundled: true, path: binary, version: vendor.version, mcpCommand: binary, mcpArgs: ["mcp", "--socket", socket], error };
  }
  if (verify && cached.installed && !verified) {
    try {
      materialize();
      const result = runCapture(binary, ["manifest"]);
      if (result.status !== 0 || result.error) throw new Error(result.error || result.stderr || "驱动检查失败。");
      if (JSON.parse(result.stdout).binary_version !== vendor.version) throw new Error("驱动版本不一致，请重新导入插件包。");
      verified = true;
    } catch (error) { cached = { ...cached, installed: false, error: error.message || String(error) }; }
  }
  return { ...cached, mcpArgs: [...cached.mcpArgs] };
}
function captureAsync(exe, args, timeout = 5000) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (status, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim(), error });
    };
    const timer = setTimeout(() => { child.kill(); finish(null, "驱动响应超时"); }, timeout);
    child.stdout.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-20000); });
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-20000); });
    child.on("error", error => finish(null, error.message));
    child.on("close", status => finish(status));
  });
}
async function prepareService() {
  if (preparing) return preparing;
  const epoch = generation;
  const task = (async () => {
    const info = probe({ verify: true });
    if (!info.installed || info.error) throw new Error(info.error);
    const status = await captureAsync(binary, ["status", "--socket", socket]);
    if (epoch !== generation) throw new Error("启动已取消。");
    if (status.status === 0) return;
    // 独立 socket 隔离系统已有 Cua Driver；驱动审批由宿主已有工具权限承担。
    const opened = await captureAsync("/usr/bin/open", ["-n", "-g", "-a", path.join(runtimeDir, "CuaDriver.app"), "--args", "serve", "--socket", socket, "--permission-mode", "unrestricted", "--dangerously-bypass-approvals", "--no-permissions-gate"]);
    if (opened.status !== 0 || opened.error) throw new Error(opened.error || opened.stderr || "无法启动 Mac 驱动。");
    for (let attempt = 0; attempt < 40; attempt++) {
      if (epoch !== generation) throw new Error("启动已取消。");
      const ready = await captureAsync(binary, ["status", "--socket", socket], 2000);
      if (epoch !== generation) throw new Error("启动已取消。");
      if (ready.status === 0) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Mac 驱动启动超时，请打开插件面板查看权限和诊断信息。");
  })().finally(() => { if (preparing === task) preparing = null; });
  preparing = task;
  return task;
}
function stopService() {
  generation++;
  if (binary && fs.existsSync(binary)) return runCapture(binary, ["stop", "--socket", socket], 5000);
}
function doctor() {
  const info = probe({ refresh: true, verify: true });
  if (!info.installed || info.error) return { code: 1, text: info.error };
  const result = runCapture(binary, ["status", "--socket", socket], 5000);
  return { code: result.status ?? 1, text: [`驱动 ${vendor.version} · ${process.arch}`, `应用：${path.join(runtimeDir, "CuaDriver.app")}`, `私有服务：${result.stdout || result.stderr || result.error}`].join("\n") };
}
module.exports = { configure, probe, doctor, childEnv, prepareService, stopService };
