"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MacRuntime } = require("./mac-runtime");
const { configure, probe } = require("./cua");
const { parseAllowlist } = require("./policy");
const { OCU_TOOLS, STOP_TOOL, makeExecutors } = require("./tools");
const runtime = new MacRuntime();
const ALL_TOOLS = [...OCU_TOOLS, STOP_TOOL];
const COMMAND_ID = "computer-use.open";
let alive = false;
let timer;
let permissions = null;
let checking = false;
let failures = 0;

async function loadSettings() { return (await pi.plugin.getSettings()) || {}; }
function fail(error) { return { ok: false, isError: true, error: error instanceof Error ? error.message : String(error) }; }
function unpack(result) {
  if (result?.isError) throw new Error((result.content || []).filter(x => x.type === "text").map(x => x.text).join("\n") || "驱动调用失败。");
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).find(x => x.type === "text")?.text;
  if (!text) throw new Error("驱动未返回权限状态。");
  return JSON.parse(text);
}
async function checkPermissions(prompt = false) {
  await runtime.ensureRunning();
  permissions = unpack(await runtime.callTool("check_permissions", { prompt, probe_direct_capture: prompt }));
  return permissions;
}
async function panelState() {
  const settings = await loadSettings();
  return { ...runtime.snapshot(), enabled: settings.enabled !== false, autoStart: settings.autoStart !== false,
    allowlist: String(settings.allowlist || ""), allowlistItems: parseAllowlist(settings.allowlist), permissions };
}
async function start() {
  if ((await loadSettings()).enabled === false) throw new Error("插件已禁用，请先在设置中启用。");
  if (!alive) throw new Error("插件已卸载。");
  await runtime.start();
  failures = 0;
  await checkPermissions(false);
}
function schedule() {
  if (!alive) return;
  timer = setTimeout(async () => {
    if (checking || !alive) return;
    checking = true;
    try {
      const settings = await loadSettings();
      if (!alive) return;
      if (settings.enabled === false) {
        if (runtime.status !== "stopped") runtime.stop("插件已禁用");
      } else if (!runtime.stoppedByUser && settings.autoStart !== false) {
        if (runtime.status !== "running") await start();
        else if (runtime.pending.size === 0) {
          await runtime._rpcUnlocked("ping", {}, 5000);
          await checkPermissions(false);
        }
        failures = 0;
      }
    } catch (error) {
      failures++;
      if (!runtime.stoppedByUser) {
        runtime._killChild();
        runtime.status = "error";
        runtime.lastError = error.message || String(error);
      }
    } finally { checking = false; schedule(); }
  }, Math.min(30_000, failures ? 2000 * 2 ** Math.min(failures, 4) : 5000));
  timer.unref?.();
}
async function onLoad() {
  const dataPath = await pi.plugin.getDataPath();
  configure(dataPath);
  runtime.setTempDir(path.join(dataPath, "ocu-tmp"));
  await pi.commands.register({ id: COMMAND_ID, title: "Computer Use（Mac 常驻版）: 打开面板", keywords: ["computer use", "mac", "桌面", "自动化"], run: () => pi.ui.openPanel({ title: "Computer Use（Mac 常驻版）" }) });
  const executors = makeExecutors(runtime, loadSettings);
  for (const tool of ALL_TOOLS) await pi.agent.registerTool({ ...tool, execute: async (args, context) => {
    try { return await executors[tool.name](args, context); } catch (error) { return fail(error); }
  } });
  alive = true;
  const settings = await loadSettings();
  if (settings.enabled !== false && settings.autoStart !== false) {
    start().catch(error => { runtime.lastError = error.message || String(error); }).finally(() => schedule());
  } else schedule();
}
async function onUnload() {
  alive = false;
  clearTimeout(timer);
  runtime.stop("插件已卸载");
  await pi.commands.unregister(COMMAND_ID);
  for (const tool of ALL_TOOLS) await pi.agent.unregisterTool(tool.name);
}
async function onPanelInvoke(channel, payload) {
  if (channel === "cu.indicator") return {
    running: runtime.status === "running" && permissions?.accessibility === true && permissions?.screen_recording === true,
    starting: runtime.status === "starting" || (runtime.status === "running" && !permissions),
    failed: runtime.status === "error" || (runtime.status === "running" && permissions != null && (!permissions.accessibility || !permissions.screen_recording)),
  };
  if (channel === "cu.state") return panelState();
  if (channel === "cu.start" || channel === "cu.repair") {
    if (channel === "cu.repair") { runtime.stop("正在修复运行环境"); probe({ refresh: true }); }
    await start();
    return panelState();
  }
  if (channel === "cu.setup") {
    await start();
    await checkPermissions(true);
    return panelState();
  }
  if (channel === "cu.permissions") {
    if (runtime.status === "running") await checkPermissions(false);
    return panelState();
  }
  if (channel === "cu.stop") { runtime.stop("已从面板停止"); permissions = null; return panelState(); }
  if (channel === "cu.doctor") return { ...(await panelState()), doctor: await runtime.doctor() };
  if (channel === "cu.openSettings") {
    if (!["Privacy_Accessibility", "Privacy_ScreenCapture"].includes(payload?.section)) throw new Error("未知的权限设置页。");
    const opened = spawnSync("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${payload.section}`], { timeout: 5000 });
    if (opened.error || opened.status !== 0) throw new Error(opened.error?.message || "无法打开系统设置。");
    return { ok: true };
  }
  if (channel === "cu.setAllowlist") {
    const settings = await loadSettings();
    await pi.plugin.setSettings({ ...settings, allowlist: String(payload?.allowlist ?? "") });
    return panelState();
  }
  throw Object.assign(new Error(`unsupported panel channel: ${channel}`), { code: "UNSUPPORTED" });
}
module.exports = { onLoad, onUnload, onPanelInvoke };
