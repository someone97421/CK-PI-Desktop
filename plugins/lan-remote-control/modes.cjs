"use strict";

const BUILTINS = [
  { id: "agent", label: "执行", available: true, staged: false },
  { id: "plan", label: "计划", available: true, staged: false },
  { id: "goal", label: "目标", available: true, staged: true },
];
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function localSession(session) {
  return (!session?.source || session.source === "desktop")
    && !/^(native-pi|remote):/.test(session?.id || "");
}
function remoteWorkspace(session) { return session?.projectPath?.startsWith("remote-project:") === true; }
// 运行状态与修订均由宿主负责，插件只转交目录及带版本的操作。
function createModes({ host, operations, getSession, isDraft }) {
  const snapshots = new Map();
  function observe(run) {
    if (!run?.sessionId || !run.id || !Number.isSafeInteger(run.revision)) return;
    const previous = snapshots.get(run.sessionId);
    if (previous && (previous.id === run.id ? previous.revision > run.revision : previous.createdAt > run.createdAt)) return;
    snapshots.delete(run.sessionId);
    snapshots.set(run.sessionId, run);
    while (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
  }
  async function catalog(sessionId) {
    const current = sessionId ? await getSession(sessionId) : null;
    if (current && !localSession(current)) {
      if (current.source === "remote" || current.id?.startsWith("remote:")) return {
        modes: BUILTINS.map(mode => ({ ...mode, available: mode.id !== "goal" })),
        configurable: true, reason: "远程宿主暂不支持阶段模式", diagnostics: [],
      };
      return { modes: [], configurable: false, reason: "原生 Pi 会话不支持模式配置", diagnostics: [] };
    }
    const available = await operations();
    if (!available.has("modes/catalog")) return { modes: BUILTINS.map(mode => ({ ...mode, available: !(remoteWorkspace(current) && mode.staged) })), configurable: true, diagnostics: [], legacy: true };
    const result = await host("modes/catalog");
    if (!Array.isArray(result?.modes)) throw new Error("宿主模式目录格式无效");
    const modes = new Map(BUILTINS.map(mode => [mode.id, { ...mode }]));
    for (const entry of result.modes) {
      if (!entry || typeof entry.id !== "string" || !entry.id) continue;
      modes.set(entry.id, { id: entry.id, label: entry.label || entry.id,
        description: entry.description || "", available: entry.available === true, staged: entry.staged === true });
    }
    if (remoteWorkspace(current)) for (const mode of modes.values()) if (mode.staged) mode.available = false;
    return { modes: [...modes.values()], configurable: true, diagnostics: result.diagnostics || [] };
  }
  async function validateMode(value, current) {
    if (typeof value !== "string" || !value.trim()) fail("INVALID_PARAMS", "工作模式无效");
    if (value === current?.mode || value === current?.pendingConfiguration?.mode) return value;
    const result = await catalog(current?.id);
    if (!result.configurable) fail("UNSUPPORTED", result.reason);
    if (!result.modes.some(mode => mode.id === value && mode.available)) fail("INVALID_PARAMS", "工作模式已不可用，请刷新目录");
    return value;
  }
  async function get(sessionId, current) {
    current ??= await getSession(sessionId);
    if (!localSession(current) || remoteWorkspace(current)) return { supported: false, run: null, reason: "此会话不支持远控阶段运行" };
    const available = await operations();
    if (!available.has("modes/run/get")) return { supported: false, run: null, reason: "宿主缺少模式运行接口" };
    if (isDraft(sessionId)) return { supported: true, run: null };
    const result = await host("modes/run/get", [sessionId]);
    if (!result || !Object.hasOwn(result, "run")) throw new Error("宿主模式运行响应无效");
    if (result.run && result.run.sessionId !== sessionId) throw new Error("宿主返回了其他会话的模式运行");
    observe(result.run);
    const latest = snapshots.get(sessionId);
    const run = result.run ? latest : latest && ["finished", "stopped"].includes(latest.state) ? latest : null;
    return { supported: true, run,
      controls: available.has("modes/run/control"), updates: available.has("modes/run/update"), approvals: available.has("modes/run/resolve") };
  }
  async function mutate(sessionId, input, kind) {
    if (typeof input.runId !== "string" || !input.runId.trim() || input.runId.length > 200
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      fail("INVALID_PARAMS", "模式运行标识或修订无效");
    const payload = { sessionId, runId: input.runId, expectedRevision: input.expectedRevision };
    if (kind === "update") {
      if (Object.hasOwn(input, "input")) {
        if (typeof input.input !== "string" || !input.input.trim() || Buffer.byteLength(input.input, "utf8") > 100_000)
          fail("INVALID_PARAMS", "运行目标不能为空且不能超过 100000 字节");
        payload.input = input.input;
      }
      if (Object.hasOwn(input, "budget")) {
        const budget = input.budget;
        if (!budget || typeof budget !== "object" || Array.isArray(budget)
          || Object.keys(budget).length !== 2 || !Object.hasOwn(budget, "maxTurns") || !Object.hasOwn(budget, "maxTokens")
          || !(budget.maxTurns === null || Number.isSafeInteger(budget.maxTurns) && budget.maxTurns >= 1 && budget.maxTurns <= 10_000)
          || !(budget.maxTokens === null || Number.isSafeInteger(budget.maxTokens) && budget.maxTokens >= 1_000))
          fail("INVALID_PARAMS", "预算需含 maxTurns（1–10000）和 maxTokens（至少 1000）的安全整数，null 表示不限");
        payload.budget = { maxTurns: budget.maxTurns, maxTokens: budget.maxTokens };
      }
      if (!Object.hasOwn(payload, "input") && !Object.hasOwn(payload, "budget"))
        fail("INVALID_PARAMS", "请提供要更新的目标或预算");
    } else {
      if (!(kind === "resolve" ? ["approve", "reject"] : ["pause", "resume", "stop", "remove"]).includes(input.action))
        fail("INVALID_PARAMS", "模式操作无效");
      payload.action = input.action;
    }
    const current = await get(sessionId);
    const capability = kind === "update" ? current.updates : kind === "resolve" ? current.approvals : current.controls;
    if (!current.supported || !capability) fail("UNSUPPORTED", current.reason || "宿主不支持此模式操作");
    if (!current.run || current.run.id !== input.runId || current.run.revision !== input.expectedRevision)
      fail("MODE_REVISION_CONFLICT", "模式运行已变化，请刷新后重试");
    const result = await host(`modes/run/${kind}`, [payload]);
    if (result?.run?.sessionId === sessionId) observe(result.run);
    return result;
  }
  return { catalog, validateMode, get, observe,
    control: (id, input) => mutate(id, input, "control"),
    update: (id, input) => mutate(id, input, "update"),
    resolve: (id, input) => mutate(id, input, "resolve") };
}
module.exports = { createModes };
