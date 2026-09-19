"use strict";

const path = require("node:path");
const { ComputerUseRuntime } = require("./runtime");
const { parseAllowlist } = require("./policy");
const { OCU_TOOLS, STOP_TOOL, makeExecutors } = require("./tools");
const { configure, probe } = require("./cua");

const COMMAND_ID = "computer-use.open";
const runtime = new ComputerUseRuntime();
const ALL_TOOLS = [...OCU_TOOLS, STOP_TOOL];

async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return {};
  }
}

function fail(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

  const settings = await loadSettings();
  if (settings.enabled !== false && settings.autoStart !== false && process.platform === "win32") {
    runtime.start().catch((error) => {
      runtime.lastError = error instanceof Error ? error.message : String(error);
    });
  }
}

async function onUnload() {
  runtime.stop("plugin unload");
  await pi.commands.unregister(COMMAND_ID);
  for (const tool of ALL_TOOLS) {
    await pi.agent.unregisterTool(tool.name);
  }
}

async function onPanelInvoke(channel, payload) {
  if (channel === "cu.state") return panelState();
  if (channel === "cu.start" || channel === "cu.repair") {
    const settings = await loadSettings();
    if (settings.enabled === false) return fail(new Error("Plugin is disabled in settings."));
    if (channel === "cu.repair") {
      runtime.stop("正在修复运行环境");
      probe({ refresh: true });
    }
    await runtime.start();
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
