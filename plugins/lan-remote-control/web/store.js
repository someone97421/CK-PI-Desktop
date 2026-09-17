/**
 * 客户端状态与事件合并规则。
 *
 * 恢复模型是「先订阅后快照」：WS 订阅确认后取 `sessions.get`（消息页 + status +
 * pending），期间到达的事件按顺序缓存，快照落地后再合并，避免订阅空窗。
 * 宿主是消息与状态的唯一权威来源，这里不做本地业务推演。
 *
 * 事件外层：{ subscriptionId, sessionId, kind, at, payload }
 *   kind = "agent.event"        → payload 是 AgentEventEnvelope，按 event.type 分派
 *   kind = "agent.turnEnded"    → 本轮结束（运行标记复位，队列可能变化）
 *   kind = "agent.queueChanged" → 队列变化（重新拉 queue.list）
 *   kind = "session.changed"    → 会话元信息变化（标题/模型/运行状态）
 */

import {
  asArray,
  asBool,
  asIso,
  asNumber,
  asString,
  eventDedupeKey,
  normalizeAskRequest,
  normalizeAttachment,
  normalizeApprovalRequest,
  normalizeCapabilities,
  normalizeCollaboration,
  normalizeCommand,
  normalizeMessage,
  normalizeModel,
  normalizePending,
  normalizePlan,
  normalizeProject,
  normalizeQueueItem,
  normalizeSession,
  normalizeStatus,
  pick,
  prettyJson,
} from "./protocol.js";

export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();
  return {
    get: () => state,
    /** 原地修改后 commit：避免每个 token 增量都深拷贝整棵树。 */
    commit(mutator) {
      if (mutator) mutator(state);
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch (error) {
          console.error("view error", error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function emptyChat() {
  return {
    sessionId: "",
    loading: false,
    error: null,
    session: null,
    status: null,
    collaboration: null,
    items: [],
    liveTools: new Map(),
    queue: [],
    pendingApprovals: [],
    pendingInputs: [],
    plans: [],
    hasMoreBefore: false,
    cursor: null,
    loadingOlder: false,
    streaming: false,
    stale: false,
    buffered: [],
    subscribed: false,
    snapshotAt: 0,
    lastEventAt: 0,
    droppedEvents: 0,
    unknownEventKinds: new Set(),
  };
}

export function createInitialState() {
  return {
    phase: "boot", // boot | login | connecting | online | reconnecting | unauthorized | error | closed
    connectionError: null,
    health: null,
    login: { deviceName: "", status: "idle", message: "" },
    ready: { device: null, capabilities: {} },
    capabilities: normalizeCapabilities({}),
    diagnostics: { socketStatus: "idle", socketDetail: {}, lastError: null, renderer: "", replay: "snapshot-then-delta" },
    view: "library", // library | chat
    library: {
      projects: { items: [], loading: false, error: null, query: "", loaded: false, activeProjectId: "" },
      sessions: {}, // projectId -> { items, loading, error, query, nextCursor, loaded, loadingMore }
      recent: { items: [], loading: false, error: null, loaded: false },
    },
    chat: emptyChat(),
    sidechats: { items: [], active: null, loading: false, error: null },
    models: { items: [], defaultKey: "", loading: false, error: null, loaded: false },
    catalog: { commands: [], loading: false, error: null, loaded: false, context: null },
    attachments: { pending: [], uploading: 0, errors: [] },
    compose: { text: "", attachments: [], modelKey: "", thinkingLevel: "", mode: "agent" },
    drafts: {}, // sessionId -> 草稿文本
    annotations: {}, // sessionId -> ResponseAnnotation[]
    metrics: { sends: 0, errors: 0 },
  };
}

/** 历史分页条目（一个会话一份）。 */
export function historyEntry(projectId) {
  return {
    items: [],
    loading: false,
    error: null,
    query: "",
    nextCursor: "",
    loaded: false,
    loadingMore: false,
    projectId,
  };
}

// ---------------------------------------------------------------------------
// 事件合并
// ---------------------------------------------------------------------------

/** 合并一条消息（UiMessage）到转录，同 id 覆盖。 */
export function mergeMessage(chat, message) {
  if (!message) return;
  const index = chat.items.findIndex((item) => item.id === message.id);
  if (index >= 0) {
    const existing = chat.items[index];
    const merged = Object.assign({}, existing, message);
    // 增量帧可能不带 attachments / thinking 等字段，保留已有值。
    if (!message.attachments || !message.attachments.length) merged.attachments = existing.attachments;
    if (!message.thinking && existing.thinking) merged.thinking = existing.thinking;
    chat.items[index] = merged;
  } else {
    chat.items.push(message);
  }
  if (message.tool && message.tool.callId) {
    chat.liveTools.set(message.tool.callId, message.tool);
  }
}

function markStreaming(chat, running) {
  if (typeof running === "boolean") chat.streaming = running;
}

/**
 * 处理一条（已归一化的）订阅事件。
 * @returns {{changed: boolean, effects: Array<object>}}
 */
export function applyEvent(chat, event) {
  const effects = [];
  let changed = false;
  if (!event) return { changed, effects };

  if (event.kind === "agent.turnEnded") {
    chat.streaming = false;
    for (const item of chat.items) {
      if (item.status === "streaming") item.status = "complete";
    }
    effects.push({ type: "refresh-queue" });
    return { changed: true, effects };
  }

  if (event.kind === "agent.queueChanged") {
    effects.push({ type: "refresh-queue" });
    return { changed, effects };
  }

  if (event.kind === "session.changed") {
    const session = normalizeSession(pick(event.payload, ["session"]) || event.payload);
    if (session) {
      chat.session = Object.assign({}, chat.session || {}, session);
      if (typeof pick(event.payload, ["running"]) === "boolean") {
        markStreaming(chat, asBool(pick(event.payload, ["running"])));
      }
      effects.push({ type: "refresh-sessions" });
      changed = true;
    }
    return { changed, effects };
  }

  if (event.kind === "resync.required") {
    chat.stale = true;
    effects.push({ type: "resync" });
    return { changed, effects };
  }

  if (event.kind !== "agent.event") {
    if (event.kind) chat.unknownEventKinds.add(event.kind);
    return { changed, effects };
  }

  const raw = event.agentEvent ? event.agentEvent.raw : {};
  const type = event.agentEvent ? event.agentEvent.type : "";
  const subagent = { agentName: event.agentName, parentToolCallId: event.parentToolCallId };

  switch (type) {
    case "agent_start":
    case "turn_start": {
      markStreaming(chat, true);
      changed = true;
      break;
    }
    case "agent_end":
    case "turn_end": {
      markStreaming(chat, false);
      for (const item of chat.items) {
        if (item.status === "streaming") item.status = "complete";
      }
      effects.push({ type: "refresh-queue" });
      changed = true;
      break;
    }
    case "message_start": {
      const message = normalizeMessage(raw.message);
      if (message) {
        message.status = "streaming";
        mergeMessage(chat, message);
        markStreaming(chat, true);
        changed = true;
      }
      break;
    }
    case "message_update": {
      const incoming = normalizeMessage(raw.message);
      if (!incoming) break;
      const existingIndex = chat.items.findIndex((item) => item.id === incoming.id);
      const isDelta = raw.stream === "delta";
      if (isDelta) {
        if (existingIndex < 0) {
          incoming.status = "streaming";
          chat.items.push(incoming);
        } else {
          const item = chat.items[existingIndex];
          const textDelta = asString(pick(raw, ["deltaText"]));
          const thinkingDelta = asString(pick(raw, ["deltaThinking"]));
          if (asBool(pick(raw, ["resetText"]), false)) item.text = textDelta;
          else if (textDelta) item.text = `${item.text || ""}${textDelta}`;
          if (asBool(pick(raw, ["resetThinking"]), false)) item.thinking = thinkingDelta;
          else if (thinkingDelta) item.thinking = `${item.thinking || ""}${thinkingDelta}`;
          item.status = "streaming";
        }
      } else {
        // 非增量帧是整段替换（可能带完整 content）。
        incoming.status = incoming.status === "complete" ? "streaming" : incoming.status;
        mergeMessage(chat, incoming);
      }
      markStreaming(chat, true);
      changed = true;
      break;
    }
    case "message_end": {
      const message = normalizeMessage(raw.message);
      if (message) {
        if (raw.replacesMessageId) {
          const replaced = chat.items.findIndex((item) => item.id === asString(raw.replacesMessageId));
          if (replaced >= 0) chat.items[replaced] = message;
          else mergeMessage(chat, message);
        } else {
          mergeMessage(chat, message);
        }
        changed = true;
      }
      const preceding = normalizeMessage(raw.precedingAssistant);
      if (preceding) mergeMessage(chat, preceding);
      break;
    }
    case "user_message_persisted": {
      const message = normalizeMessage(raw.message);
      if (message) {
        const optimisticIndex = chat.items.findIndex(
          (item) => item.id === asString(raw.optimisticMessageId),
        );
        if (optimisticIndex >= 0) chat.items[optimisticIndex] = message;
        else mergeMessage(chat, message);
        changed = true;
      }
      break;
    }
    case "tool_start": {
      const callId = asString(pick(raw, ["toolCallId"]));
      if (callId) {
        chat.liveTools.set(callId, {
          callId,
          name: asString(pick(raw, ["toolName"]), "工具"),
          status: "running",
          args: pick(raw, ["args"]),
          result: undefined,
          isError: false,
          startedAt: Date.now(),
          ...subagent,
        });
        changed = true;
      }
      break;
    }
    case "tool_update": {
      const callId = asString(pick(raw, ["toolCallId"]));
      const tool = callId ? chat.liveTools.get(callId) : null;
      if (tool) {
        tool.result = pick(raw, ["partialResult"]);
        tool.status = "running";
        changed = true;
      }
      break;
    }
    case "tool_end": {
      const callId = asString(pick(raw, ["toolCallId"]));
      if (callId) {
        const tool = chat.liveTools.get(callId) || { callId, name: "工具", args: undefined, ...subagent };
        tool.result = pick(raw, ["result"]);
        tool.isError = asBool(pick(raw, ["isError"]), false);
        tool.status = tool.isError ? "error" : "success";
        tool.endedAt = Date.now();
        chat.liveTools.set(callId, tool);
        changed = true;
      }
      break;
    }
    case "planning_state": {
      const plan = normalizePlan(raw);
      if (plan) {
        const index = chat.plans.findIndex((entry) => entry.proposalId === plan.proposalId);
        if (index >= 0) chat.plans[index] = plan;
        else if (plan.state && plan.state !== "inactive") chat.plans.push(plan);
        if (plan.state === "inactive") {
          chat.plans = chat.plans.filter((entry) => entry.proposalId !== plan.proposalId);
        }
        changed = true;
        effects.push({ type: "plan" });
      }
      break;
    }
    case "tool_permission_request": {
      const approval = normalizeApprovalRequest(raw.request);
      if (approval) {
        const index = chat.pendingApprovals.findIndex((entry) => entry.id === approval.id);
        if (index >= 0) chat.pendingApprovals[index] = approval;
        else chat.pendingApprovals.push(approval);
        changed = true;
        effects.push({ type: "approval" });
      }
      break;
    }
    case "asktool_request": {
      const input = normalizeAskRequest(raw.request);
      if (input) {
        const index = chat.pendingInputs.findIndex((entry) => entry.id === input.id);
        if (index >= 0) chat.pendingInputs[index] = input;
        else chat.pendingInputs.push(input);
        changed = true;
        effects.push({ type: "question" });
      }
      break;
    }
    case "status": {
      const status = normalizeStatus(raw.status);
      if (status) {
        chat.status = status;
        markStreaming(chat, status.running);
        for (const item of chat.items) {
          if (item.status === "streaming" && !status.running) item.status = "complete";
        }
        changed = true;
      }
      break;
    }
    case "compaction_start": {
      chat.compaction = { reason: asString(pick(raw, ["reason"])), active: true, at: Date.now() };
      changed = true;
      break;
    }
    case "compaction_end": {
      const ok = asBool(pick(raw, ["ok"]), true);
      chat.compaction = { reason: asString(pick(raw, ["reason"])), active: false, at: Date.now() };
      effects.push({ type: ok ? "info" : "error", message: ok ? "上下文已压缩" : "上下文压缩失败" });
      changed = true;
      break;
    }
    case "error": {
      const error = raw.error && typeof raw.error === "object" ? raw.error : {};
      effects.push({ type: "error", message: asString(pick(error, ["message"]), "电脑端报告错误") });
      break;
    }
    default: {
      if (type) chat.unknownEventKinds.add(`agent.event:${type}`);
      break;
    }
  }
  chat.lastEventAt = Date.now();
  return { changed, effects };
}

/**
 * 把订阅事件合进聊天状态（快照未落地时先缓存）。
 * @returns {{changed: boolean, effects: Array<object>, buffered: boolean}}
 */
export function ingestEvent(chat, event, { snapshotReady }) {
  if (!snapshotReady) {
    chat.buffered.push(event);
    return { changed: false, effects: [], buffered: true };
  }
  const result = applyEvent(chat, event);
  return { changed: result.changed, effects: result.effects, buffered: false };
}

/** 快照落地后把缓存事件按到达顺序合并（去重）。 */
export function drainBufferedEvents(chat) {
  const seen = new Set();
  const effects = [];
  let changed = false;
  for (const event of chat.buffered.splice(0, chat.buffered.length)) {
    const key = eventDedupeKey(event);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const result = applyEvent(chat, event);
    changed = changed || result.changed;
    effects.push(...result.effects);
  }
  chat.snapshotAt = Date.now();
  return { changed, effects };
}

// ---------------------------------------------------------------------------
// 快照与列表
// ---------------------------------------------------------------------------

/** `sessions.get` → 聊天状态。 */
export function applySessionSnapshot(chat, result) {
  const source = result && typeof result === "object" ? result : {};
  const session = normalizeSession(source.session);
  if (session) chat.session = session;

  const status = normalizeStatus(source.status);
  if (status) {
    chat.status = status;
    chat.streaming = status.running;
  }

  const messages = source.messages && typeof source.messages === "object" ? source.messages : {};
  const items = asArray(pick(messages, ["items", "messages"]))
    .map((item) => normalizeMessage(item))
    .filter(Boolean);
  chat.items = items;
  chat.cursor = pick(messages, ["cursor"]) ?? null;
  chat.hasMoreBefore = asBool(pick(messages, ["hasMoreBefore", "hasMore"]), chat.cursor !== null && chat.cursor !== undefined);

  // 快照里的运行时项目（adapter 会纳入 activeItems / pendingApprovals / pendingInputs）。
  const activeItems = asArray(pick(source, ["activeItems"]))
    .map((item) => normalizeMessage(item))
    .filter(Boolean);
  for (const item of activeItems) mergeMessage(chat, item);
  for (const item of chat.items) {
    if (item.status === "streaming") chat.streaming = true;
  }

  chat.liveTools = new Map();
  for (const item of chat.items) {
    if (item.tool && item.tool.callId) chat.liveTools.set(item.tool.callId, item.tool);
  }

  const approvals = asArray(pick(source, ["pendingApprovals"]))
    .map((entry) => normalizeApprovalRequest(entry))
    .filter(Boolean);
  if (approvals.length || !chat.pendingApprovals.length) chat.pendingApprovals = approvals;

  const inputs = asArray(pick(source, ["pendingInputs"]))
    .map((entry) => normalizeAskRequest(entry))
    .filter(Boolean);
  if (inputs.length || !chat.pendingInputs.length) chat.pendingInputs = inputs;

  const pending = normalizePending(source.pending);
  chat.plans = asArray(pick(pending, ["plans"]));
  chat.pendingNotes = pick(source.pending, ["notes"]) || [];

  chat.collaboration = normalizeCollaboration(source.collaboration);
  chat.stale = false;
  return chat;
}

/** 更旧一页：`sessions.messages` 结果前插。 */
export function applyOlderMessages(chat, result) {
  const source = result && typeof result === "object" ? result : {};
  const items = asArray(pick(source, ["items", "messages"]))
    .map((item) => normalizeMessage(item))
    .filter(Boolean);
  const existing = new Map(chat.items.map((item) => [item.id, true]));
  const prepend = items.filter((item) => !existing.has(item.id));
  chat.items = [...prepend, ...chat.items];
  chat.cursor = pick(source, ["cursor"]) ?? null;
  chat.hasMoreBefore = asBool(pick(source, ["hasMoreBefore"]), false);
  return prepend.length;
}

export function normalizeProjects(result) {
  const source = result && typeof result === "object" ? result : {};
  return {
    items: asArray(pick(source, ["items", "projects"])).map((item) => normalizeProject(item)).filter(Boolean),
    activeProjectId: asString(pick(source, ["activeProjectId"]), ""),
  };
}

export function normalizeSessionList(result) {
  const source = result && typeof result === "object" ? result : {};
  return {
    items: asArray(pick(source, ["items", "sessions"])).map((item) => normalizeSession(item)).filter(Boolean),
    nextCursor: asString(pick(source, ["nextCursor", "cursor"]), ""),
  };
}

export function normalizeModelList(result) {
  const source = result && typeof result === "object" ? result : {};
  return {
    items: asArray(pick(source, ["items", "models"])).map((item) => normalizeModel(item)).filter(Boolean),
    defaultKey: asString(pick(source, ["defaultKey"]), ""),
  };
}

export function normalizeCommandList(result) {
  const source = result && typeof result === "object" ? result : {};
  return {
    items: asArray(pick(source, ["items", "commands"])).map((item) => normalizeCommand(item)).filter(Boolean),
    context: pick(source, ["context"]) || null,
  };
}

export function normalizeQueueList(result) {
  const source = result && typeof result === "object" ? result : {};
  return asArray(pick(source, ["items"]))
    .map((item, index) => normalizeQueueItem(item, index))
    .filter(Boolean)
    .sort((a, b) => a.position - b.position);
}

export function normalizeAttachmentRefs(raw) {
  return asArray(raw).map((item) => normalizeAttachment(item)).filter(Boolean);
}

/** 会话列表排序：运行中的排前面，其次按更新时间。 */
export function sortSessions(items) {
  return items.slice().sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    const aTime = Date.parse(a.updatedAt || "") || 0;
    const bTime = Date.parse(b.updatedAt || "") || 0;
    return bTime - aTime;
  });
}

export function formatToolResult(value) {
  return prettyJson(value, 4000);
}

export function normalizeIsoOrNow(value) {
  return asIso(value, new Date().toISOString());
}

export function toNumberOr(value, fallback) {
  return asNumber(value, fallback);
}
