"use strict";

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENDPOINT = "http://127.0.0.1:19988";
const PORT = 19988;
const OPERATION_META = Object.freeze({
  "browse.status": { mutation: false, sessionScoped: false },
  "browse.ensureRelay": { mutation: true, sessionScoped: false },
  "browse.mintPairingCode": { mutation: true, sessionScoped: false },
});

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function resolveCommand() {
  const bundled = process.env.THIS_IS_A_AGENT_BROWSE_EXECUTABLE;
  if (bundled && path.isAbsolute(bundled)) {
    try { fs.accessSync(bundled, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return bundled; } catch {}
  }
  const name = process.platform === "win32" ? "browse.exe" : "browse";
  const directories = [...(process.env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}
function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, OPENCODE_BROWSER_TOOLS: "all", OPENCODE_BROWSER_PORT: String(PORT) } }, (error, stdout) => {
      if (error) return reject(failure(error.killed ? "TIMEOUT" : "UNAVAILABLE", `Browse 命令失败：${args.join(" ")}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(failure("UNAVAILABLE", "Browse CLI 未返回有效 JSON，请更新 browse")); }
    });
  });
}
async function probeRelay() {
  try {
    const response = await fetch(`${ENDPOINT}/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const value = await response.json();
    return typeof value?.version === "string" && typeof value?.instanceId === "string" ? value : null;
  } catch { return null; }
}

function createBrowseBridge({ resolveExecutable = resolveCommand, run = runCommand, probe = probeRelay, spawnRelay = spawn } = {}) {
  let starting = null;
  let child = null;
  let closed = false;
  async function status() {
    const command = resolveExecutable();
    const version = await probe();
    let detail = null, error = null;
    if (command) {
      try { detail = await run(command, ["status", "--json"]); }
      catch (cause) { error = { code: cause.code || "UNAVAILABLE", message: cause.message }; }
    }
    return {
      running: Boolean(version), endpoint: ENDPOINT, port: PORT, cliAvailable: Boolean(command),
      browsers: Array.isArray(detail?.extension?.browsers) ? detail.extension.browsers : Array.isArray(detail?.browsers) ? detail.browsers : [],
      tabs: Array.isArray(detail?.tabs) ? detail.tabs : Array.isArray(detail?.targets) ? detail.targets : [],
      relay: detail?.relay ?? { running: Boolean(version), endpoint: ENDPOINT },
      version, setup: detail?.setup ?? null, error,
      connected: detail?.connected === true, pairingState: detail?.pairingState ?? null, extension: detail?.extension ?? null,
    };
  }
  async function start() {
    if (closed) throw failure("NOT_READY", "连接器已停止");
    if (await probe()) return status();
    if (closed) throw failure("NOT_READY", "连接器已停止");
    const command = resolveExecutable();
    if (!command) throw failure("UNAVAILABLE", "内置 Browse 不可用，请重新构建或更新主程序");
    let spawnError = null;
    child = spawnRelay(command, ["serve"], {
      stdio: "ignore", windowsHide: true,
      env: { ...process.env, OPENCODE_BROWSER_TOOLS: "all", OPENCODE_BROWSER_PORT: String(PORT) },
    });
    const launched = child;
    child.once("error", (error) => { spawnError = error; });
    child.once("exit", () => { if (child === launched) child = null; });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (closed) throw failure("NOT_READY", "连接器已停止");
      if (spawnError) throw failure("UNAVAILABLE", "无法启动 Browse Relay");
      if (await probe()) return status();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    launched.kill();
    throw failure("TIMEOUT", "Browse Relay 启动超时");
  }
  async function ensureRelay() {
    if (!starting) starting = start().finally(() => { starting = null; });
    return starting;
  }
  async function mintPairingCode() {
    await ensureRelay();
    if (closed) throw failure("NOT_READY", "连接器已停止");
    const command = resolveExecutable();
    if (!command) throw failure("UNAVAILABLE", "未找到 browse");
    const result = await run(command, ["pair", "--mint-json"]);
    if (typeof result?.code !== "string" || !/^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/.test(result.code) || result.port !== PORT || result.endpoint !== ENDPOINT) {
      throw failure("UNAVAILABLE", "Browse 配对结果无效，请更新 browse 以支持 pair --mint-json");
    }
    return { code: result.code, port: PORT, endpoint: ENDPOINT };
  }
  async function stop() {
    closed = true;
    const owned = child;
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { owned.kill("SIGKILL"); resolve(); }, 1500);
        owned.once("exit", () => { clearTimeout(timer); resolve(); });
        owned.kill();
      });
    }
    await starting?.catch(() => {});
    child = null;
  }
  return { status, ensureRelay, mintPairingCode, stop, open: () => { closed = false; } };
}
module.exports = { createBrowseBridge, OPERATION_META, ENDPOINT, PORT };
