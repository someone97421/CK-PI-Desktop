import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as protocol from "../../../packages/shared/dist/protocol.js";

const require = createRequire(import.meta.url);
async function loadSource(relative, modules = {}, globals = {}, extra = "") {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const { outputText: code } = ts.transpileModule(source + extra, { fileName: relative,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const exports = {};
  const sandbox = { exports, module: { exports }, TextEncoder, ...globals,
    require: (name) => modules[name] ?? (name === "@pi-desktop/shared" ? shared :
      name === "@pi-desktop/shared/protocol" ? protocol : name.startsWith("node:") ? require(name) : {}),
  };
  vm.runInNewContext(code, sandbox, { filename: relative });
  return sandbox.module.exports;
}

test("人工终止按钮通过 renderer API 和专用 IPC 定向停止，不调用整轮停止", async () => {
  const handlers = new Map();
  const requests = [];
  const ipc = await loadSource("../electron/main/ipc/agent-ipc.ts");
  ipc.registerAgentIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => null, getAgentHostBridge: () => null,
    getSidecar: () => ({ call: async (method, params) => {
      requests.push({ method, ...params });
      return { delegationId: params.delegationId, status: "running", collaboration: { phase: "stopping" } };
    } }),
    cancelSessionTools: () => { throw new Error("must not stop the session"); },
    finishTurn: () => { throw new Error("must not finish the parent turn"); },
  });
  assert.ok(protocol.IPC_WHITELIST.has(protocol.IPC.invoke.subagentStop));
  const { api } = await loadSource("../src/lib/api.ts", {}, { window: { piDesktop: {
    invoke: async (channel, payload) => ({ ok: true, data: await handlers.get(channel)(payload) }),
  } } });
  const jsx = (type, props) => ({ type, props });
  const state = { activeSessionId: "session-1", runningSessions: { "session-1": true } };
  const component = await loadSource("../src/features/chat/transcript/SubagentSupervision.tsx", {
    react: { useState: (value) => [value, () => {}], useEffect: () => {} },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../../../lib/api": { api },
    "../../../lib/tool-presentation": { toolResultPayload: (message) => message.toolResult.details },
    "../../../stores/app-store": { useAppStore: (select) => select(state) },
    "../../../components/icons": { IconStop: () => null },
  });
  const message = { toolResult: { details: { delegationId: "child-1", collaboration: {
    reportIntervalSteps: 4, intervalSource: "dispatch", phase: "running", completedSteps: 2, stepsSinceReport: 2,
  } } } };
  const tree = component.SubagentSupervision({ message, running: true, compact: true });
  const find = (node) => !node || typeof node !== "object" ? undefined : Array.isArray(node)
    ? node.map(find).find(Boolean) : node.type === "button" ? node : find(node.props?.children);
  const button = find(tree);
  assert.ok(button);
  await button.props.onClick({ stopPropagation() {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "agent.subagentStop");
  assert.equal(requests[0].sessionId, "session-1");
  assert.equal(requests[0].delegationId, "child-1");
  state.runningSessions["session-1"] = false;
  assert.equal(find(component.SubagentSupervision({ message, running: true, compact: true })), undefined);
  await assert.rejects(() => handlers.get(protocol.IPC.invoke.subagentStop)({ sessionId: "session-1" }), /delegationId/);
});

test("编辑器保留固定汇报间隔、允许留空并拒绝非法值", async () => {
  const editor = await loadSource("../src/components/settings/SubagentEditorSheet.tsx");
  const draft = { ...editor.emptySubagentDraft(), name: "worker", description: "Work", body: "Inspect" };
  assert.equal(draft.reportIntervalSteps, "");
  assert.equal(editor.subagentDraftError(draft), null);
  assert.equal(editor.subagentDraftError({ ...draft, reportIntervalSteps: "5" }), null);
  for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
    assert.equal(editor.subagentDraftError({ ...draft, reportIntervalSteps: value }), "extensions.subagents.errorReportInterval");
  }
  const restored = editor.draftFromRecord({ id: "worker", name: "worker", tools: ["Read"], reportIntervalSteps: 7 }, "Inspect");
  assert.equal(restored.reportIntervalSteps, "7");
  const old = editor.draftFromRecord({ id: "old", name: "old", tools: ["Read"] }, "Inspect");
  assert.equal(old.reportIntervalSteps, "");
});

test("召回状态查询经过专用只读 IPC，历史卡片不凭落盘快照宣称可以召回", async () => {
  const handlers = new Map();
  let available = true;
  const requests = [];
  const ipc = await loadSource("../electron/main/ipc/agent-ipc.ts");
  ipc.registerAgentIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn) },
    getHost: () => null, getAgentHostBridge: () => null,
    getSidecar: () => ({ call: async (method, params) => {
      requests.push({ method, ...params });
      return { delegationId: params.delegationId, execution: 2, status: available ? "completed" : "unavailable", canResume: available };
    } }),
  });
  const { api } = await loadSource("../src/lib/api.ts", {}, { window: { piDesktop: {
    invoke: async (channel, payload) => ({ ok: true, data: await handlers.get(channel)(payload) }),
  } } });
  const jsx = (type, props) => ({ type, props });
  const state = { activeSessionId: "s", runningSessions: {} };
  const slots = [];
  let cursor = 0;
  let effects = [];
  const component = await loadSource("../src/features/chat/transcript/SubagentSupervision.tsx", {
    react: { useState: (initial) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { slots[i] = value; }]; },
      useEffect: (fn) => effects.push(fn) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    "../../../lib/api": { api },
    "../../../lib/tool-presentation": { toolResultPayload: (message) => message.toolResult.details },
    "../../../stores/app-store": { useAppStore: (select) => select(state) },
    "../../../components/icons": { IconStop: () => null },
  });
  const message = { toolResult: { details: { delegationId: "child", canResume: true, collaboration: {
    execution: 2, reportIntervalSteps: 3, intervalSource: "dispatch", phase: "finished", completedSteps: 4, stepsSinceReport: 0,
  } } } };
  const render = () => { cursor = 0; effects = []; return component.SubagentSupervision({ message, running: false }); };
  assert.doesNotMatch(JSON.stringify(render()), /subagentRecallReady/);
  for (const effect of effects) effect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(JSON.stringify(render()), /subagentRecallReady/);
  assert.equal(requests[0].method, "agent.subagentRecallStatus");
  available = false;
  for (const effect of effects) effect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(JSON.stringify(render()), /subagentRecallReady/);
  await assert.rejects(() => handlers.get(protocol.IPC.invoke.subagentStop)({ sessionId: "s", delegationId: "child", expectedExecution: 0 }), /expectedExecution/);
});

test("配置导入兼容旧文件，保留间隔并拒绝字符串或零", async () => {
  const transfer = await loadSource("../electron/main/config-transfer.ts", {}, {}, "\nexport { parseFile };\n");
  const file = (extra = {}) => JSON.stringify({ kind: "this-is-a-agent.config", version: 1, subagents: {
    owned: [{ id: "worker", name: "worker", description: "Work", body: "Inspect", tools: ["Read"],
      model: "", fallbackModels: [], thinkingLevel: "", maxTokens: 0, enabled: true, ...extra }], disabledBuiltins: [],
  } });
  assert.equal(transfer.parseFile(file()).subagents.owned[0].reportIntervalSteps, undefined);
  assert.equal(transfer.parseFile(file({ reportIntervalSteps: 6 })).subagents.owned[0].reportIntervalSteps, 6);
  assert.equal(transfer.parseFile(file({ reportIntervalSteps: null })).subagents.owned[0].reportIntervalSteps, null);
  for (const value of [0, -1, 2.5, "6"]) assert.throws(() => transfer.parseFile(file({ reportIntervalSteps: value })), /汇报间隔/);
});
