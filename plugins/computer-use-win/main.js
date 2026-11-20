"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ComputerUseRuntime } = require("./runtime");
const { parseAllowlist } = require("./policy");
const { OCU_TOOLS, STOP_TOOL, makeExecutors } = require("./tools");
const { configure, probe, stopService } = require("./cua");

const COMMAND_ID = "computer-use.open";
const ALL_TOOLS = [...OCU_TOOLS, STOP_TOOL];

class WinRuntime extends ComputerUseRuntime {
  _killChild() {
    // 驱动会派生子进程，单独结束父进程会留下占用运行文件的孤儿进程。
    const pid = this.child?.pid;
    if (pid) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    super._killChild();
  }
}

const runtime = new WinRuntime();
let alive = false;
let timer = null;
let checking = false;
let failures = 0;

async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return {};
  }
}

function fail(error) {
  return {
    ok: false,
    isError: true,
    error: error instanceof Error ? error.message : String(error),
    ...(error?.rpcError ? { rpcError: error.rpcError } : {}),
  };
}

async function panelState() {
  const settings = await loadSettings();
  const snap = runtime.snapshot();
  return {
    ...snap,
    enabled: settings.enabled !== false,
    autoStart: settings.autoStart !== false,
    allowlist: String(settings.allowlist || ""),
    allowlistItems: parseAllowlist(settings.allowlist),
  };
}

async function start() {
  if ((await loadSettings()).enabled === false) throw new Error("插件已禁用，请先在设置中启用。");
  if (!alive) throw new Error("插件已卸载。");
  await runtime.start();
  failures = 0;
}

/** 宿主运行期间定期检查驱动连接；意外断开时自动恢复，手动停止和急停保持停止。 */
function schedule() {
  if (!alive || process.platform !== "win32") return;
  timer = setTimeout(async () => {
    if (checking || !alive) return;
    checking = true;
    try {
      const settings = await loadSettings();
      if (!alive) return;
      if (settings.enabled === false) {
        if (runtime.status !== "stopped") runtime.stop("插件已禁用");
      } else if (!runtime.stoppedByUser && settings.autoStart !== false) {
        if (runtime.status !== "running" || !runtime.child) await start();
        else if (runtime.pending.size === 0) await runtime._rpcUnlocked("ping", {}, 5000);
        failures = 0;
      }
    } catch (error) {
      failures++;
      if (!runtime.stoppedByUser) {
        runtime._killChild();
        runtime.status = "error";
        runtime.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      checking = false;
      schedule();
    }
  }, Math.min(30_000, failures ? 2000 * 2 ** Math.min(failures, 4) : 5000));
  timer.unref?.();
}

async function onLoad() {
  try {
    const dataPath = await pi.plugin.getDataPath();
    configure(dataPath);
    runtime.setTempDir(path.join(dataPath, "ocu-tmp"));
  } catch {
    /* plugin data path is optional during tests */
  }
  const executors = makeExecutors(runtime, loadSettings);

  await pi.commands.register({
    id: COMMAND_ID,
    title: "Computer Use（Win 版）: 打开面板",
    keywords: ["computer use", "cua", "desktop", "自动化", "桌面"],
    run: async () => {
      await pi.ui.openPanel({ title: "Computer Use（Win 版）" });
    },
  });

  for (const tool of ALL_TOOLS) {
    await pi.agent.registerTool({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      schema: tool.schema,
      execute: async (args, context) => {
        try {
          return await executors[tool.name](args, context);
        } catch (error) {
          return fail(error);
        }
      },
    });
  }

  alive = true;
  const settings = await loadSettings();
  if (settings.enabled !== false && settings.autoStart !== false && process.platform === "win32") {
    start().catch((error) => {
      runtime.lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => schedule());
  } else {
    schedule();
  }
}

async function onUnload() {
  alive = false;
  clearTimeout(timer);
  runtime.stop("plugin unload");
  if (typeof stopService === "function") await stopService();
  await pi.commands.unregister(COMMAND_ID);
  for (const tool of ALL_TOOLS) {
    await pi.agent.unregisterTool(tool.name);
  }
}

async function onPanelInvoke(channel, payload) {
  if (channel === "cu.indicator") {
    return {
      running: runtime.status === "running",
      starting: runtime.status === "starting",
      failed: runtime.status === "error" || (runtime.status === "starting" && Boolean(runtime.lastError)),
    };
  }
  if (channel === "cu.state") return panelState();
  if (channel === "cu.start" || channel === "cu.repair") {
    const settings = await loadSettings();
    if (settings.enabled === false) return fail(new Error("Plugin is disabled in settings."));
    if (channel === "cu.repair") {
      runtime.stop("正在修复运行环境");
      await stopService();
      probe({ refresh: true });
    }
    await start();
    return panelState();
  }
  if (channel === "cu.stop") {
    runtime.stop("stopped from panel");
    return panelState();
  }
  if (channel === "cu.doctor") {
    const doctor = await runtime.doctor();
    return { ...(await panelState()), doctor };
  }
  if (channel === "cu.setAllowlist") {
    const allowlist = String(payload?.allowlist ?? "");
    const settings = await loadSettings();
    await pi.plugin.setSettings({ ...settings, allowlist });
    return panelState();
  }
  throw Object.assign(new Error(`unsupported panel channel: ${channel}`), { code: "UNSUPPORTED" });
}

module.exports = { onLoad, onUnload, onPanelInvoke };
