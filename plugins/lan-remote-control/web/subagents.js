/**
 * 子代理只读观测面板（局域网远程控制 · 移动网页端）。
 *
 * 只读：本模块不发送任何 RPC、不写会话数据，只把 `update()` 收到的消息与
 * 实时工具快照渲染成右侧固定观测侧栏（窄屏是铺满的 dialog）。
 *
 * 归集规则对齐桌面端 `lib/assistant-turns.ts:collectSubagentRuns`、
 * `lib/subagent-panel.ts` 与 `lib/subagent-topology.ts`：
 *   - 父行：toolName 是 Task / TaskResume 的工具行（含 `plugin_task` 这类
 *     带命名空间的写法）；
 *   - 子行：带 `parentToolCallId` 的消息，与带 `parentToolCallId` 的实时工具；
 *   - 关联键优先 `delegationId`（同一子代理的多次执行合并成一项），再退化到
 *     `executionId`（第二次起是 `<delegationId>:<execution>`）与 `toolCallId`；
 *   - 状态 / 模型 / 耗时 / 轮次 / 错误取工具结果 payload：Task 自带快照、
 *     TaskWait / TaskList 的 `delegations[]`、TaskStop 的 `stopped[]`。
 *
 * 安全：远端字符串只经 textContent、`el()` 属性，或 markdown.js（DOMPurify 或
 * 本地构造节点）进入 DOM；本文件没有任何 innerHTML 入口。
 */
import { el, button } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

/** 面板样式表；主程序链接过就复用，没有就由本模块补一个同源 link。 */
const STYLE_ID = "subagent-observer-stylesheet";
const STYLE_HREF = "/subagents.css";
/** 与 layout.css 的断点一致：≤700px 是手机单栏。 */
const MOBILE_QUERY = "(max-width: 700px)";
/** 单块文本上限，避免一次工具结果把移动端 DOM 撑爆。 */
const MAX_TEXT = 20_000;
/** 距底部多少像素内算“跟随滚动”。 */
const FOLLOW_THRESHOLD = 48;

const STATUS_LABELS = {
  running: "运行中",
  creating: "创建中",
  completed: "已完成",
  failed: "失败",
  denied: "已拒绝",
  timed_out: "超时",
  aborted: "已中止",
  stopped: "已停止",
};

const STATUS_TONES = {
  running: "running",
  creating: "running",
  completed: "ok",
  denied: "error",
  failed: "error",
  timed_out: "warn",
  aborted: "warn",
  stopped: "warn",
};

/** 与桌面端 isDelegationStartTool 一致：Task / Subagent / TaskResume。 */
const DELEGATION_START_TOOLS = new Set(["task", "subagent", "taskresume"]);
/** 任务正文可能落在这些参数名前。 */
const TASK_ARG_KEYS = ["task", "prompt", "instruction", "message", "description"];
const SNAPSHOT_LIST_KEYS = ["delegations", "stopped"];

// ---------------------------------------------------------------------------
// 取值工具
// ---------------------------------------------------------------------------

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function firstString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function clampText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n…（已截断，共 ${text.length} 字符）`;
}

/** 值 → 可显示文本：字符串原样，其他走 JSON（失败则退化为 String）。 */
function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return clampText(value);
  try {
    return clampText(JSON.stringify(value, null, 2));
  } catch {
    return clampText(String(value));
  }
}

function compact(value, limit = 160) {
  const single = String(value ?? "").replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** 只解析“看起来是对象/数组”的字符串，避免把普通文本当 JSON。 */
function parseJsonValue(raw) {
  const text = raw.trim();
  if (!/^[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function envelopeText(envelope) {
  if (!Array.isArray(envelope.content)) return null;
  const parts = [];
  for (const block of envelope.content) {
    const record = asRecord(block);
    if (record && record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * 与桌面端 toolResultPayload 一致：`{ content, details }` 只保留值得显示的一层。
 * 字符串结果（可能是持久化过的 JSON）尽量解一层。
 */
function toolResultPayload(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string") return parseJsonValue(raw) ?? raw;
  const envelope = asRecord(raw);
  if (!envelope) return raw;
  if (envelope.details !== undefined && envelope.details !== null) return envelope.details;
  return envelopeText(envelope) ?? envelope;
}

/** 一行到底的工具名（去命名空间），与桌面端 bareToolName 同义。 */
function bareToolName(name) {
  return asString(name)
    .split(".")
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isDelegationStartTool(name) {
  return DELEGATION_START_TOOLS.has(bareToolName(name));
}

// UiMessage / 实时工具在插件里有两套形状（原始 UiMessage 与 normalizeMessage），
// 这里统一读取。

function messageTool(message) {
  return asRecord(message?.tool);
}

function messageContent(message) {
  return firstString(message?.content, message?.text);
}

function messageToolName(message) {
  return firstString(message?.toolName, messageTool(message)?.name);
}

function messageToolCallId(message) {
  return firstString(message?.toolCallId, messageTool(message)?.callId);
}

function messageToolArgs(message) {
  return message?.toolArgs !== undefined ? message.toolArgs : messageTool(message)?.args;
}

function messageToolResult(message) {
  return message?.toolResult !== undefined ? message.toolResult : messageTool(message)?.result;
}

function messageToolStatus(message) {
  return firstString(message?.toolStatus, messageTool(message)?.status);
}

function liveToolName(tool) {
  return firstString(tool?.toolName, tool?.name);
}

function liveToolCallId(tool) {
  return firstString(tool?.toolCallId, tool?.callId, tool?.id);
}

function liveToolResult(tool) {
  if (tool?.result !== undefined && tool?.result !== null && tool.result !== "") return tool.result;
  if (tool?.partialResult !== undefined && tool?.partialResult !== null && tool.partialResult !== "") {
    return tool.partialResult;
  }
  return undefined;
}

function liveToolStatus(tool) {
  const status = asString(tool?.status);
  if (status) return status;
  if (tool?.running === true) return "running";
  if (tool?.isError === true) return "error";
  if (tool?.running === false) return "success";
  return "";
}

function liveToolsOf(tools) {
  if (!tools) return [];
  if (tools instanceof Map) return [...tools.values()].filter((tool) => asRecord(tool));
  if (Array.isArray(tools)) return tools.filter((tool) => asRecord(tool));
  if (typeof tools === "object") return Object.values(tools).filter((tool) => asRecord(tool));
  return [];
}

function normalizeStatus(value) {
  const status = asString(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (!status) return "";
  if (status === "success" || status === "complete" || status === "done") return "completed";
  if (status === "error") return "failed";
  if (status === "timeout") return "timed_out";
  return status;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

function statusTone(status) {
  return STATUS_TONES[status] || "idle";
}

function taskTextFromArgs(args) {
  const record = asRecord(args);
  if (!record) return "";
  for (const key of TASK_ARG_KEYS) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return "";
}

/** 快照/任务结果里同一子代理的所有别名。 */
function delegationIdsOf(record, args) {
  const ids = [];
  const delegationId = firstString(record?.delegationId, asRecord(args)?.delegationId);
  const executionId = asString(record?.executionId);
  const execution = numberOf(record?.execution);
  if (executionId) ids.push(executionId);
  if (delegationId) {
    ids.push(delegationId);
    if (execution !== undefined && execution > 1) ids.push(`${delegationId}:${execution}`);
  }
  return ids;
}

/** executionId 里的 `:<n>` 后缀还原出执行序号。 */
function executionNumberOf(record) {
  const explicit = numberOf(record?.execution);
  if (explicit !== undefined && explicit >= 1) return Math.floor(explicit);
  const executionId = asString(record?.executionId);
  const match = /:(\d+)$/.exec(executionId);
  if (match) return Number(match[1]);
  return 1;
}

function formatClock(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// 归集（只读数据 → 可渲染的子代理列表）
// ---------------------------------------------------------------------------

function createEntry(id) {
  return {
    id,
    ids: new Set(),
    calls: [],
    children: [],
    snapshots: [],
    status: "running",
    name: "",
    model: "",
    description: "",
    task: "",
    startedAt: 0,
    completedAt: 0,
    turns: 0,
    toolCalls: 0,
    error: null,
  };
}

function fallbackFailure(record) {
  const error = asRecord(record?.error);
  if (!error) return null;
  const code = asString(error.code).trim();
  const message = asString(error.message).trim();
  if (!code && !message) return null;
  return { code, message };
}

function collectSubagents(messages, tools) {
  const list = Array.isArray(messages) ? messages : [];
  const live = liveToolsOf(tools);
  const entries = new Map();
  const alias = new Map();
  const childrenByParent = new Map();
  /** 已成文本消息的工具行 callId：实时工具行不再重复显示。 */
  const persistedToolCalls = new Set();

  const link = (entry, ...ids) => {
    for (const id of ids) {
      if (!id) continue;
      entry.ids.add(id);
      if (!alias.has(id)) alias.set(id, entry.id);
    }
  };

  const ensureEntry = (id, ...ids) => {
    let entry = entries.get(id);
    if (!entry) {
      entry = createEntry(id);
      entries.set(id, entry);
    }
    link(entry, id, ...ids);
    return entry;
  };

  const addChild = (parentKey, row) => {
    if (!parentKey) return;
    const bucket = childrenByParent.get(parentKey);
    if (bucket) bucket.push(row);
    else childrenByParent.set(parentKey, [row]);
  };

  // 子行索引：先建全量，父行再认领。
  list.forEach((message, index) => {
    if (!asRecord(message)) return;
    const parent = asString(message.parentToolCallId);
    if ((message.role === "tool" || asString(message.toolName)) && messageToolCallId(message)) {
      persistedToolCalls.add(messageToolCallId(message));
    }
    if (!parent) return;
    addChild(parent, {
      kind: "message",
      message,
      order: index,
      id: `message:${firstString(message.id, String(index))}`,
    });
  });
  live.forEach((tool, index) => {
    const parent = asString(tool.parentToolCallId);
    if (!parent) return;
    const callId = liveToolCallId(tool);
    if (callId && persistedToolCalls.has(callId)) return;
    addChild(parent, {
      kind: "tool",
      tool,
      order: list.length + index,
      id: `tool:${firstString(callId, String(index))}`,
    });
  });

  const ingestCall = ({ callId, name, args, rawResult, toolStatus, source, order, agentName }) => {
    const payload = asRecord(toolResultPayload(rawResult));
    const ids = delegationIdsOf(payload, args);
    const delegationId = firstString(payload?.delegationId, asRecord(args)?.delegationId);
    const entryId = delegationId || firstString(payload?.executionId) || callId;
    const entry = ensureEntry(entryId, ...ids, callId);
    const call = {
      callId,
      name,
      order,
      source,
      toolStatus: normalizeStatus(toolStatus) || asString(toolStatus),
      status: "",
      agentName: firstString(payload?.agent, agentName, asRecord(args)?.agent),
      args,
      argsText: textOf(args),
      text: taskTextFromArgs(args),
      execution: payload ? executionNumberOf(payload) : /taskresume$/i.test(name)
        ? (numberOf(asRecord(args)?.expectedExecution) ?? 0) + 1 : 1,
      payload,
      delegationId,
      executionId: firstString(payload?.executionId),
      startedAt: numberOf(payload?.startedAt),
      completedAt: numberOf(payload?.completedAt),
      model: asString(payload?.modelId),
      error: fallbackFailure(payload),
    };
    const duplicate = entry.calls.find((candidate) => candidate.callId === callId);
    if (duplicate) {
      // 同一次调用同时出现在消息与实时工具里：保留信息更全的一份。
      if (!duplicate.payload && call.payload) Object.assign(duplicate, call);
      return entry;
    }
    entry.calls.push(call);
    return entry;
  };

  const ingestSnapshot = (snapshot, order) => {
    const delegationId = asString(snapshot?.delegationId);
    if (!delegationId) return;
    const entryId = delegationId;
    const entry = ensureEntry(entryId, ...delegationIdsOf(snapshot));
    entry.snapshots.push({
      order,
      ids: delegationIdsOf(snapshot),
      execution: executionNumberOf(snapshot),
      status: normalizeStatus(snapshot?.status) || asString(snapshot?.status),
      stopped: snapshot?.stopped === true,
      model: asString(snapshot?.modelId),
      agent: asString(snapshot?.agent),
      startedAt: numberOf(snapshot?.startedAt),
      completedAt: numberOf(snapshot?.completedAt),
      turns: numberOf(snapshot?.turns),
      toolCalls: numberOf(snapshot?.toolCalls),
      error: fallbackFailure(snapshot),
    });
  };

  const ingestToolRow = (rawResult, order) => {
    const payload = asRecord(toolResultPayload(rawResult));
    if (!payload) return;
    for (const key of SNAPSHOT_LIST_KEYS) {
      if (!Array.isArray(payload[key])) continue;
      for (const item of payload[key]) {
        const record = asRecord(item);
        if (!record) continue;
        ingestSnapshot({ ...record, stopped: key === "stopped" }, order);
      }
    }
  };

  list.forEach((message, index) => {
    if (!asRecord(message)) return;
    const name = messageToolName(message);
    if (isDelegationStartTool(name)) {
      ingestCall({
        callId: messageToolCallId(message) || firstString(message.id, `message:${index}`),
        name,
        args: messageToolArgs(message),
        rawResult: messageToolResult(message),
        toolStatus: messageToolStatus(message),
        source: "message",
        order: index,
        agentName: asString(message.agentName),
      });
      return;
    }
    if (asString(message.role) !== "tool" && !name) return;
    ingestToolRow(messageToolResult(message), index);
  });

  live.forEach((tool, index) => {
    const name = liveToolName(tool);
    const order = list.length + index;
    if (isDelegationStartTool(name)) {
      const callId = liveToolCallId(tool);
      if (!callId) return;
      ingestCall({
        callId,
        name,
        args: tool.args,
        rawResult: liveToolResult(tool),
        toolStatus: liveToolStatus(tool),
        source: "tool",
        order,
        agentName: asString(tool.agentName),
      });
      return;
    }
    ingestToolRow(liveToolResult(tool), order);
  });

  // 认领子行：父调用 → 子代理项。
  const consumed = new Set();
  for (const entry of entries.values()) {
    for (const call of entry.calls) {
      const keys = [call.callId, call.delegationId, call.executionId].filter(Boolean);
      for (const key of keys) {
        const rows = childrenByParent.get(key);
        if (!rows) continue;
        consumed.add(key);
        entry.children.push(...rows);
      }
    }
  }
  // 父行不在当前窗口（或只剩子行）时，按别名兜底，绝不静默丢行。
  for (const [parentKey, rows] of childrenByParent) {
    if (consumed.has(parentKey)) continue;
    const known = alias.get(parentKey);
    const entry = known ? entries.get(known) : ensureEntry(parentKey);
    entry.children.push(...rows);
  }

  const collected = [...entries.values()].filter((entry) => entry.calls.length || entry.children.length || entry.snapshots.length);
  for (const entry of collected) finalizeEntry(entry);
  return { entries: collected, alias };
}

function rowRunning(row) {
  if (row.kind === "message") {
    const message = row.message;
    return (
      asString(message?.status) === "streaming" ||
      normalizeStatus(messageToolStatus(message)) === "running"
    );
  }
  return liveToolStatus(row.tool) === "running";
}

function snapshotIdsMatch(entry, snapshot) {
  for (const id of snapshot.ids) if (entry.ids.has(id)) return true;
  return false;
}

function callStatus(entry, call) {
  let snapshotStatus = "";
  for (const snapshot of entry.snapshots) {
    if (!snapshotIdsMatch(entry, snapshot)) continue;
    if (snapshot.execution === call.execution && (snapshot.ids.includes(call.executionId) || snapshot.ids.includes(call.delegationId))) {
      if (snapshot.status) snapshotStatus = snapshot.status;
    }
  }
  const payloadStatus = normalizeStatus(call.payload?.status);
  const rowLive = entry.children.some((row) => rowRunning(row));
  if (snapshotStatus && snapshotStatus !== "running") return snapshotStatus;
  if (payloadStatus && payloadStatus !== "running") return payloadStatus;
  if (snapshotStatus === "running" || payloadStatus === "running") return "running";
  if (rowLive) return "running";
  if (call.toolStatus === "running") return call.toolStatus;
  if (call.toolStatus === "failed" || call.toolStatus === "error") return "failed";
  if (call.toolStatus === "denied") return "denied";
  if (call.toolStatus === "completed" || call.toolStatus === "success" || call.toolStatus === "complete") return "completed";
  return entry.children.length ? "completed" : "running";
}

function latestSnapshot(entry) {
  let latest = null;
  for (const snapshot of entry.snapshots) {
    if (!snapshotIdsMatch(entry, snapshot)) continue;
    if (!latest || snapshot.execution > latest.execution
      || (snapshot.execution === latest.execution && snapshot.order >= latest.order)) latest = snapshot;
  }
  return latest;
}

function finalizeEntry(entry) {
  // 子行去重 + 按原始顺序排序。
  const seenRows = new Set();
  entry.children = entry.children
    .filter((row) => {
      if (seenRows.has(row.id)) return false;
      seenRows.add(row.id);
      return true;
    })
    .sort((left, right) => left.order - right.order);
  entry.calls.sort((left, right) => left.execution - right.execution || left.order - right.order);

  const snapshot = latestSnapshot(entry);
  const newestCall = entry.calls[entry.calls.length - 1];
  for (const call of entry.calls) call.status = callStatus(entry, call);

  entry.status = snapshot?.status && (!newestCall || snapshot.execution > newestCall.execution)
    ? snapshot.status : newestCall?.status || snapshot?.status
      || (entry.children.some((row) => rowRunning(row)) ? "running" : "completed");

  const childAgent = firstString(...entry.children.map((row) => asString(row.kind === "message" ? row.message?.agentName : row.tool?.agentName)));
  entry.name = firstString(
    newestCall?.agentName,
    snapshot?.agent,
    childAgent,
  );
  entry.model = firstString(newestCall?.model, snapshot?.model);
  entry.description = firstString(newestCall?.payload?.description, asRecord(entry.calls[0]?.args)?.description);
  entry.task = firstString(...entry.calls.map((call) => call.text));
  const starts = [...entry.calls.map((call) => call.startedAt), snapshot?.startedAt].filter((value) => typeof value === "number");
  const ends = [...entry.calls.map((call) => call.completedAt), snapshot?.completedAt].filter((value) => typeof value === "number");
  entry.startedAt = starts.length ? Math.min(...starts) : 0;
  entry.completedAt = ends.length ? Math.max(...ends) : 0;
  entry.turns = (newestCall?.payload?.turns ?? snapshot?.turns ?? 0) || 0;
  entry.toolCalls = (newestCall?.payload?.toolCalls ?? snapshot?.toolCalls ?? entry.children.length) || 0;

  const childError = entry.children
    .map((row) => {
      if (row.kind === "message") {
        const error = asRecord(row.message?.error);
        return error ? { code: asString(error.code), message: asString(error.message) } : null;
      }
      const tool = row.tool;
      if (tool?.isError !== true) return null;
      return { code: "", message: compact(textOf(liveToolResult(tool)), 400) };
    })
    .filter(Boolean);
  const failures = [snapshot?.error, ...entry.calls.map((call) => call.error)].filter(
    (failure) => failure && (failure.code || failure.message),
  );
  entry.error =
    failures[failures.length - 1] ||
    childError[childError.length - 1] ||
    null;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

/**
 * 创建一个只读观测面板。
 * @returns {{
 *   update: (sessionId: string, messages: unknown, tools: unknown) => Promise<void>,
 *   open: (id?: string) => boolean,
 *   close: () => void,
 *   buttonLabel: () => string,
 *   isOpen: () => boolean,
 * }}
 */
export function createSubagentObserver() {
  let visible = false;
  let modeSwitch = false;
  let sessionId = "";
  let entries = [];
  let alias = new Map();
  let selectedId = "";
  let dialogEl = null;
  let panel = null;
  let tabsNode = null;
  let bodyNode = null;
  let scroller = null;
  let summaryNode = null;
  let jumpButton = null;
  let closeButton = null;
  let previousFocus = null;
  let renderToken = 0;
  let renderQueue = [];
  const expanded = new Set();
  const mobileQuery =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_QUERY)
      : { matches: false, addEventListener: undefined };

  // ---- 样式 ----

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const linked = [...document.querySelectorAll('link[rel="stylesheet"]')].some((link) =>
      /subagents\.css(\?|$)/.test(link.getAttribute("href") || ""),
    );
    if (linked) return;
    document.head.append(
      el("link", { attrs: { id: STYLE_ID, rel: "stylesheet", href: STYLE_HREF } }),
    );
  }

  // ---- 骨架 ----

  function ensurePanel() {
    if (panel) return panel;
    summaryNode = el("span", { className: "subagent-summary", text: "" });
    closeButton = button("关闭", {
      variant: "ghost",
      title: "关闭子代理观测",
      onClick: () => close(),
    });
    const header = el(
      "header",
      { className: "subagent-head" },
      el(
        "div",
        { className: "subagent-heading" },
        el("h2", { className: "subagent-title", text: "子代理观测" }),
        summaryNode,
      ),
      closeButton,
    );
    tabsNode = el("div", {
      className: "subagent-tabs",
      attrs: { role: "tablist", "aria-label": "子代理列表" },
    });
    bodyNode = el("div", { className: "subagent-body" });
    scroller = el(
      "div",
      {
        className: "subagent-scroll",
        attrs: { role: "log", "aria-live": "polite", "aria-label": "子代理过程", tabindex: "0" },
        on: { scroll: onScroll },
      },
      bodyNode,
    );
    jumpButton = button("回到最新", { preserveLabel: true, className: "subagent-jump", onClick: () => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      if (jumpButton) jumpButton.hidden = true;
    } });
    jumpButton.hidden = true;
    panel = el(
      "aside",
      {
        className: "subagent-observer",
        attrs: { id: "subagent-observer", role: "complementary", "aria-label": "子代理观测" },
      },
      header,
      tabsNode,
      scroller,
      jumpButton,
    );
    return panel;
  }

  function ensureDialog() {
    if (dialogEl) return dialogEl;
    dialogEl = el("dialog", {
      className: "subagent-observer-dialog",
      attrs: { "aria-label": "子代理观测" },
    });
    // dom.js 的焦点移出/窗口失焦自动关闭对只读侧栏太激进，这里显式豁免。
    dialogEl.dataset.persistent = "true";
    dialogEl.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialogEl.addEventListener("close", () => {
      if (!modeSwitch) close();
    });
    return dialogEl;
  }

  /** 桌面：右侧固定侧栏（非 modal）。手机：铺满的 dialog。 */
  function applyMode() {
    const mobile = mobileQuery.matches === true;
    if (mobile) {
      const dialog = ensureDialog();
      dialog.append(panel);
      if (!dialog.isConnected) document.body.append(dialog);
      if (!dialog.open) dialog.showModal();
      panel.classList.add("is-in-dialog");
      if (closeButton && !closeButton.contains(document.activeElement) && document.activeElement?.tagName === "BODY") {
        closeButton.focus({ preventScroll: true });
      }
      return;
    }
    panel.classList.remove("is-in-dialog");
    if (!panel.isConnected || panel.parentElement !== document.body) document.body.append(panel);
    if (dialogEl) {
      modeSwitch = true;
      const dialog = dialogEl;
      dialogEl = null;
      if (dialog.open) dialog.close();
      dialog.remove();
      modeSwitch = false;
    }
  }

  // ---- 滚动 ----

  function onScroll() {
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (jumpButton) jumpButton.hidden = distance <= FOLLOW_THRESHOLD;
  }

  function rememberScroll() {
    if (!scroller) return { top: 0, follow: true };
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    return { top: scroller.scrollTop, follow: distance <= FOLLOW_THRESHOLD };
  }

  function restoreScroll(view) {
    if (!scroller) return;
    if (view.follow) scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTop = view.top;
    if (jumpButton) jumpButton.hidden = view.follow;
  }

  // ---- 渲染 ----

  function markdownBlock(text, className) {
    const holder = el("div", { className: className ? `subagent-md ${className}` : "subagent-md" });
    const value = clampText(text || "");
    if (!value.trim()) {
      holder.append(el("p", { className: "subagent-hint", text: "（空）" }));
      return holder;
    }
    const token = renderToken;
    renderQueue.push(
      renderMarkdown(value)
        .then((node) => {
          if (token === renderToken && holder.isConnected) holder.replaceChildren(node);
        })
        .catch(() => {}),
    );
    return holder;
  }

  function plainBlock(text, className) {
    return el("pre", { className: className || "subagent-pre", text: clampText(text || "") });
  }

  function disclosure(key, label, excerpt, tone, ...children) {
    const details = el("details", { className: "subagent-process" });
    details.open = expanded.has(key);
    details.dataset.tone = tone || "idle";
    details.append(
      el(
        "summary",
        {},
        el("span", { className: "subagent-process-label", text: label }),
        el("span", { className: "subagent-process-excerpt", text: compact(excerpt) }),
      ),
      el("div", { className: "subagent-process-body" }, ...children),
    );
    details.addEventListener("toggle", () => {
      if (details.open) expanded.add(key);
      else expanded.delete(key);
    });
    return details;
  }

  function metaRow(list, label, value) {
    if (!value) return;
    list.append(el("dt", { text: label }), el("dd", { text: value }));
  }

  function guidanceNode(name, result) {
    if (name !== "TaskGuidance") return null;
    const payload = asRecord(toolResultPayload(result));
    const guide = asRecord(payload?.guide);
    const states = { accepted: "引导已接收", applying: "正在应用引导", applied: "引导已生效", cancelled: "引导已取消", rejected: "引导被拒绝" };
    if (!guide || typeof guide.commandId !== "string" || typeof guide.instruction !== "string"
      || !Object.hasOwn(states, guide.status) || !Number.isFinite(guide.receivedAt)) return null;
    const execution = guide.execution ?? payload.execution;
    const meta = el("footer", {}, el("span", { text: states[guide.status], attrs: { role: "status" } }));
    const timestamp = (value, label) => el("time", {
      text: `${formatClock(value)} ${label}`,
      attrs: { datetime: new Date(value).toISOString(), title: new Date(value).toLocaleString() },
    });
    meta.append(timestamp(guide.receivedAt, "已接收"));
    if (Number.isFinite(guide.appliedAt)) meta.append(timestamp(guide.appliedAt, "已应用"));
    return el("article", { className: "subagent-guidance-message", dataset: { status: guide.status, guideId: guide.commandId } },
      el("header", {}, el("strong", { text: "主代理 → 子代理" }),
        Number.isSafeInteger(execution) ? el("span", { text: `第 ${execution} 轮执行` }) : null),
      el("p", { className: "subagent-guidance-content", text: guide.instruction }), meta,
      ["accepted", "applying"].includes(guide.status) ? el("p", {
        className: "subagent-guidance-note", text: "等待安全执行边界；当前正在执行的工具会先完成。",
      }) : null,
      guide.reason ? el("p", { className: "subagent-guidance-note", text: guide.reason }) : null);
  }

  function itemNode(entry, row) {
    const wrap = el("div", { className: "subagent-item" });
    if (row.kind === "tool") {
      const tool = row.tool;
      const isError = tool?.isError === true || liveToolStatus(tool) === "failed" || liveToolStatus(tool) === "error";
      const name = liveToolName(tool) || "工具";
      const guidance = guidanceNode(name, liveToolResult(tool));
      if (guidance) return guidance;
      wrap.dataset.tone = isError ? "error" : liveToolStatus(tool) === "running" ? "running" : "ok";
      wrap.append(
        disclosure(
          `${entry.id}|${row.id}`,
          `⌘ ${name}`,
          `${statusLabel(normalizeStatus(liveToolStatus(tool))) || liveToolStatus(tool) || "执行中"} · ${textOf(tool?.args)}`,
          wrap.dataset.tone,
          plainBlock(textOf(tool?.args), "subagent-pre subagent-pre-args"),
          plainBlock(textOf(liveToolResult(tool) ?? "等待工具输出…"), "subagent-pre subagent-pre-result"),
        ),
      );
      return wrap;
    }

    const message = row.message;
    const role = asString(message?.role) || "assistant";
    const thinking = asString(message?.thinking);
    const content = messageContent(message);
    const toolName = messageToolName(message);
    const guidance = guidanceNode(toolName, messageToolResult(message));
    if (guidance) return guidance;
    if (thinking) {
      wrap.append(disclosure(`${entry.id}|${row.id}|thinking`, "思考", thinking, "thinking", plainBlock(thinking)));
    }
    if (role === "tool" || toolName) {
      const status = normalizeStatus(messageToolStatus(message));
      const isError = message?.isError === true || messageTool(message)?.isError === true || status === "failed" || status === "error";
      wrap.dataset.tone = isError ? "error" : status === "running" ? "running" : "ok";
      wrap.append(
        disclosure(
          `${entry.id}|${row.id}|tool`,
          `⌘ ${toolName || "工具"}`,
          `${statusLabel(status || "completed")} · ${textOf(messageToolArgs(message))}`,
          wrap.dataset.tone,
          plainBlock(textOf(messageToolArgs(message)), "subagent-pre subagent-pre-args"),
          plainBlock(textOf(toolResultPayload(messageToolResult(message)) ?? "无输出"), "subagent-pre subagent-pre-result"),
        ),
      );
    } else if (content.trim()) {
      wrap.append(markdownBlock(content, "subagent-answer"));
    }
    const error = asRecord(message?.error);
    const errorText = error ? `${asString(error.code)} ${asString(error.message)}`.trim() : "";
    if (errorText) wrap.append(el("p", { className: "subagent-error", text: errorText }));
    return wrap;
  }

  function executionNode(entry, call) {
    const key = `${entry.id}|call|${call.callId}`;
    const label = call.execution > 1 ? `第 ${call.execution} 次执行（续跑）` : "任务派发";
    const details = disclosure(
      key,
      label,
      `${statusLabel(call.status)} · ${call.text || call.argsText}`,
      statusTone(call.status),
      plainBlock(call.argsText, "subagent-pre subagent-pre-args"),
      plainBlock(textOf(toolResultPayload(call.payload)) || "无输出", "subagent-pre subagent-pre-result"),
    );
    const summary = details.querySelector("summary");
    if (summary) {
      summary.append(
        el("span", {
          className: "subagent-status",
          dataset: { tone: statusTone(call.status) },
          text: statusLabel(call.status),
        }),
      );
    }
    return details;
  }

  function detailNode(entry) {
    const wrapper = el("div", { className: "subagent-detail" });
    wrapper.append(
      el(
        "div",
        { className: "subagent-headline" },
        el("span", {
          className: "subagent-status",
          dataset: { tone: statusTone(entry.status) },
          text: statusLabel(entry.status),
        }),
        el("span", { className: "subagent-agent", text: entry.name || "未命名子代理" }),
      ),
    );

    const meta = el("dl", { className: "subagent-meta" });
    metaRow(meta, "模型", entry.model || "未提供");
    metaRow(meta, "代理", entry.name || "未提供");
    metaRow(meta, "说明", entry.description);
    metaRow(meta, "执行次数", entry.calls.length ? `${entry.calls.length}` : "");
    metaRow(meta, "开始", entry.startedAt ? formatClock(entry.startedAt) : "");
    metaRow(
      meta,
      "耗时",
      entry.startedAt
        ? formatDuration((entry.completedAt || Date.now()) - entry.startedAt)
        : "",
    );
    metaRow(meta, "轮次", entry.turns ? `${entry.turns}` : "");
    metaRow(meta, "工具调用", entry.toolCalls ? `${entry.toolCalls}` : "");
    metaRow(meta, "消息", `${entry.children.length}`);
    wrapper.append(meta);

    wrapper.append(
      el(
        "section",
        { className: "subagent-section" },
        el("h3", { className: "subagent-section-title", text: "任务" }),
        entry.task
          ? markdownBlock(entry.task, "subagent-task")
          : el("p", { className: "subagent-hint", text: "未收到任务正文（消息可能不在当前窗口）。" }),
      ),
    );

    if (entry.calls.length) {
      wrapper.append(
        el(
          "section",
          { className: "subagent-section" },
          el("h3", { className: "subagent-section-title", text: "派发记录" }),
          ...entry.calls.map((call) => executionNode(entry, call)),
        ),
      );
    }

    const process = el(
      "section",
      { className: "subagent-section" },
      el("h3", { className: "subagent-section-title", text: "子代理过程" }),
    );
    if (entry.children.length) {
      for (const row of entry.children) process.append(itemNode(entry, row));
    } else {
      process.append(
        el("p", {
          className: "subagent-hint",
          text: "当前已加载记录中还没有子代理消息。后续事件到达或加载更早消息后会补上。",
        }),
      );
    }
    wrapper.append(process);

    if (entry.error) {
      const text = [entry.error.code, entry.error.message].filter(Boolean).join(" ");
      wrapper.append(
        el(
          "section",
          { className: "subagent-section" },
          el("h3", { className: "subagent-section-title", text: "错误" }),
          el("p", { className: "subagent-error", text: text || "子代理报告了错误。" }),
        ),
      );
    }
    return wrapper;
  }

  function emptyNode() {
    return el(
      "div",
      { className: "subagent-empty", attrs: { role: "status" } },
      el("p", { className: "subagent-empty-title", text: "暂无子代理" }),
      el(
        "p",
        { className: "subagent-empty-detail", text: "主代理调用 Task（或 TaskResume）后，这里会列出每个子代理的任务、状态、模型与过程。" },
      ),
    );
  }

  function renderTabs() {
    if (!tabsNode) return;
    if (!entries.length) {
      tabsNode.hidden = true;
      tabsNode.replaceChildren();
      return;
    }
    tabsNode.hidden = false;
    tabsNode.replaceChildren(
      ...entries.map((entry, index) => {
        const selected = entry.id === selectedId;
        const tab = button(entry.name || `子代理 ${index + 1}`, {
          variant: "ghost",
          preserveLabel: true,
          className: `subagent-tab${selected ? " is-selected" : ""}`,
          title: `${entry.name || `子代理 ${index + 1}`} · ${statusLabel(entry.status)}`,
          onClick: () => select(entry.id),
        });
        tab.dataset.tone = statusTone(entry.status);
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(selected));
        tab.prepend(el("span", { className: "subagent-dot", attrs: { "aria-hidden": "true" } }));
        return tab;
      }),
    );
  }

  function updateSummary() {
    if (!summaryNode) return;
    if (!entries.length) {
      summaryNode.textContent = "没有正在跟踪的子代理";
      return;
    }
    const running = entries.filter((entry) => entry.status === "running").length;
    const issues = entries.filter((entry) => entry.status === "failed" || entry.status === "denied").length;
    const parts = [`${entries.length} 个子代理`];
    if (running) parts.push(`${running} 运行中`);
    if (issues) parts.push(`${issues} 失败`);
    summaryNode.textContent = parts.join(" · ");
  }

  async function render(options) {
    if (!panel || !visible) return;
    const fresh = options?.fresh === true;
    const view = rememberScroll();
    renderToken += 1;
    renderQueue = [];
    if (!entries.length) selectedId = "";
    if (selectedId && !entries.some((entry) => entry.id === selectedId)) selectedId = "";
    if (!selectedId && entries.length) selectedId = entries[0].id;
    const selected = entries.find((entry) => entry.id === selectedId);
    renderTabs();
    updateSummary();
    bodyNode.replaceChildren(selected ? detailNode(selected) : emptyNode());
    restoreScroll(fresh || !selected ? { top: 0, follow: true } : view);
    const queue = renderQueue;
    renderQueue = [];
    await Promise.all(queue);
  }

  function select(id) {
    if (!id || id === selectedId) return;
    selectedId = id;
    void render({ fresh: true });
  }

  function resolveSelection(id) {
    const wanted = asString(id);
    if (!wanted) return "";
    if (entries.some((entry) => entry.id === wanted)) return wanted;
    const mapped = alias.get(wanted);
    if (mapped && entries.some((entry) => entry.id === mapped)) return mapped;
    return "";
  }

  // ---- 生命周期 ----

  function onKeydown(event) {
    if (event.key !== "Escape" || !visible) return;
    const openDialogs = document.querySelectorAll("dialog[open]");
    const top = openDialogs.length ? openDialogs[openDialogs.length - 1] : null;
    // 别的弹窗（审批、设置等）开着时，ESC 归它。
    if (top && top !== dialogEl) return;
    event.preventDefault();
    close();
  }

  function close() {
    if (!visible) return;
    visible = false;
    renderToken += 1;
    document.removeEventListener("keydown", onKeydown, true);
    mobileQuery.removeEventListener?.("change", onViewportChange);
    if (modeSwitch) return;
    if (dialogEl) {
      const dialog = dialogEl;
      dialogEl = null;
      if (dialog.open) dialog.close();
      dialog.remove();
    }
    panel?.remove();
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      previousFocus.focus({ preventScroll: true });
    }
    previousFocus = null;
  }

  function onViewportChange() {
    if (visible) applyMode();
  }

  function open(id) {
    ensureStyle();
    ensurePanel();
    const wanted = resolveSelection(id);
    if (wanted) selectedId = wanted;
    else if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries[0]?.id ?? "";
    if (!visible) {
      visible = true;
      previousFocus = document.activeElement;
      document.addEventListener("keydown", onKeydown, true);
      mobileQuery.addEventListener?.("change", onViewportChange);
    }
    applyMode();
    void render({ fresh: true });
    return true;
  }

  function buttonLabel() {
    if (!entries.length) return "子代理观测";
    const running = entries.filter((entry) => entry.status === "running").length;
    const issues = entries.filter((entry) => entry.status === "failed" || entry.status === "denied").length;
    let label = `子代理观测 ${entries.length}`;
    if (running) label += ` · ${running} 运行中`;
    else if (issues) label += ` · ${issues} 失败`;
    return label;
  }

  async function update(nextSessionId, messages, tools) {
    const nextId = asString(nextSessionId);
    if (nextId !== sessionId) {
      sessionId = nextId;
      selectedId = "";
      expanded.clear();
    }
    const collected = collectSubagents(messages, tools);
    entries = collected.entries;
    alias = collected.alias;
    if (visible) await render();
    else renderToken += 1;
  }

  return { update, open, close, buttonLabel, isOpen: () => visible };
}
