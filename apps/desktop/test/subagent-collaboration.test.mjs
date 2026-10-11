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

test("子代理运行上下文按任务会话和执行版本隔离，不依赖主轮运行", async () => {
  const jsx = (type, props) => ({ type, props });
  const state = { activeSessionId: "other-session", runningSessions: {}, messages: [], agentStatuses: {} };
  const component = await loadSource("../src/features/chat/transcript/SubagentSupervision.tsx", {
    react: { useMemo: (factory) => factory() },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ i18n: { resolvedLanguage: "zh-CN" } }) },
    "../../../lib/tool-presentation": { toolResultPayload: (message) => message.toolResult.details },
    "../../../stores/app-store": { useAppStore: (select) => select(state) },
    "../../../components/PluginInlineSlot": { PluginInlineSlot: "plugin-inline" },
  });
  const message = { toolResult: { details: {
    sessionId: "task-session", delegationId: "child-1", executionId: "child-1:2", execution: 2, status: "running",
  } } };
  const tree = component.SubagentSupervision({ message, running: true, compact: true });
  assert.equal(tree.props.context.sessionId, "task-session");
  assert.equal(tree.props.context.delegationId, "child-1");
  assert.equal(tree.props.context.execution, 2);
  assert.equal(tree.props.context.live, true);
  state.activeSessionId = "task-session";
  state.messages = [{ toolResult: { details: { ...message.toolResult.details, execution: 3 } } }];
  assert.equal(component.useSubagentExecution(message).live, false);
  state.messages = [{ toolResult: { details: { ...message.toolResult.details, status: "completed" } } }];
  assert.equal(component.useSubagentExecution(message).live, false);
  const collaboration = { execution: 4, reportIntervalSteps: 5, phase: "running" };
  assert.equal(component.subagentExecutionIdentity({ toolResult: { details: {
    ...message.toolResult.details, collaboration,
  } } }).execution, 4);
});

test("保存回执更新任务消息时，协作进度不变也刷新观测条上下文", async () => {
  let previousDeps;
  let previousContext;
  const jsx = (type, props) => ({ type, props });
  const component = await loadSource("../src/features/chat/transcript/SubagentSupervision.tsx", {
    react: { useMemo: (factory, deps) => {
      if (!previousDeps || deps.some((value, index) => value !== previousDeps[index])) {
        previousContext = factory();
        previousDeps = deps;
      }
      return previousContext;
    } },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ i18n: { resolvedLanguage: "zh-CN" } }) },
    "../../../lib/tool-presentation": { toolResultPayload: (message) => message.toolResult.details },
    "../../../stores/app-store": { useAppStore: (select) => select({ activeSessionId: "s1", runningSessions: {} }) },
    "../../../components/PluginInlineSlot": { PluginInlineSlot: "plugin-inline" },
  });
  const details = { delegationId: "saved-task", persistenceState: "saving", collaboration: {
    execution: 1, reportIntervalSteps: 4, phase: "finished", completedSteps: 4,
  } };
  const message = { toolResult: { details } };
  const initial = component.SubagentSupervision({ message, running: false }).props.context;
  assert.equal(component.SubagentSupervision({ message, running: false }).props.context, initial);
  const savedMessage = { ...message, toolResult: { details: { ...details, persistenceState: "durable-ready" } } };
  const saved = component.SubagentSupervision({ message: savedMessage, running: false }).props.context;
  assert.notEqual(saved, initial);
  assert.equal(saved.collaboration, initial.collaboration);
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
  const plugin = await loadSource("../resources/plugins/local.subagent-observer/supervision.js");
  const context = { sessionId: "s", delegationId: "child", running: false, live: false, locale: "en", execution: 2,
    collaboration: { execution: 2, reportIntervalSteps: 3, intervalSource: "dispatch", phase: "finished", completedSteps: 4, stepsSinceReport: 0 } };
  const render = () => plugin.renderSupervision(context, {
    desktopInvoke: (operation, [input]) => {
      assert.equal(operation, "subagent/recallStatus");
      return api.subagentRecallStatus(input.sessionId, input.delegationId);
    },
  });
  assert.match(JSON.stringify(await render()), /Available for parent recall/);
  assert.equal(requests[0].method, "agent.subagentRecallStatus");
  available = false;
  assert.doesNotMatch(JSON.stringify(await render()), /Available for parent recall/);
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

test("停止入口共享 busy，pending 按会话、任务和执行隔离", async () => {
  const jsx = (type, props) => ({ type, props });
  const requests = [];
  const effects = [];
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const component = await loadSource("../src/features/chat/transcript/SubagentStopButton.tsx", {
    react: { useEffect: (effect) => effects.push(effect) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
    zustand: { create: (init) => {
      let state = init();
      const useStore = (select) => select(state);
      useStore.getState = () => state;
      useStore.setState = (update) => { state = { ...state, ...update(state) }; };
      return useStore;
    } },
    "../../../lib/api": { api: { stopSubagents: async (request) => {
      requests.push(request);
      await response;
      return { pending: ["child"] };
    } } },
    "../../../stores/app-store": { useAppStore: (select) => select({ sessions: [{ id: "owner" }] }) },
    "../../../components/ui": { Button: "button", TooltipButton: "button" },
  });
  const props = { sessionId: "owner", delegationId: "child", execution: 2, running: true, compact: true };
  const first = component.SubagentStopButton(props);
  first.props.onClick();
  first.props.onClick();
  assert.equal(requests.length, 1);
  assert.equal(component.SubagentStopButton(props).props.disabled, true);
  assert.equal(requests[0].sessionId, "owner");
  assert.equal(JSON.stringify(requests[0].delegationIds), '["child"]');
  assert.equal(requests[0].expectedExecutions.child, 2);
  finish();
  await new Promise(setImmediate);
  assert.equal(component.SubagentStopButton(props).props.disabled, true);
  assert.equal(component.SubagentStopButton({ ...props, execution: 3 }).props.disabled, false);
  assert.equal(component.SubagentStopButton({ ...props, sessionId: "another" }).props.disabled, false);
  component.SubagentStopButton({ ...props, running: false });
  for (const effect of effects.splice(0)) effect();
  assert.equal(component.SubagentStopButton(props).props.disabled, false);
  assert.equal(component.SubagentStopButton({ ...props, execution: undefined }), null);
});
