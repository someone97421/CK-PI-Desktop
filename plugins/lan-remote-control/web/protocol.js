/**
 * 局域网远程控制 —— 浏览器侧协议层（唯一字段来源）。
 *
 * 信封（SERVER-PROTOCOL.md，桌面端已固定）：
 *   HTTP  { ok: true, result, requestId? } | { ok: false, error: { code, message }, requestId? }
 *   RPC   POST /api/rpc  { requestId, operation, input, mutationId? }（变更必须有 mutationId）
 *   401   => code "UNAUTHORIZED"（会话失效，需重新登录）
 *   变更结果查询  GET /api/mutation/:id（Bearer，只读；断网后不要盲目重发）
 *   WS    { type: "auth", token } -> { type: "ready" }
 *         { type: "subscribe", sessionId } -> { type: "subscribed", sessionId }
 *         { type: "event", event }（event 形状见下）
 *   app 级心跳 { type: "ping" } / { type: "pong" }
 *
 * operation 名称、输入与结果字段以 PROTOCOL.md（host adapter）为准，这里是
 * UI 侧的镜像；改动 op 时两处一起改。
 *
 * 事件（PROTOCOL.md §7 + 事件 agent 约定）：
 *   外层 { subscriptionId, sessionId, kind, at, payload }
 *   kind: "agent.event" | "agent.turnEnded" | "agent.queueChanged" | "session.changed"
 *   agent.event 的 payload 是 AgentEventEnvelope:
 *     { sessionId, turnId?, ts, event: AgentEvent, parentToolCallId?, agentName? }
 *   AgentEvent.type: agent_start | agent_end | turn_start | turn_end |
 *     message_start | message_update | message_end | user_message_persisted |
 *     tool_start | tool_update | tool_end | planning_state |
 *     tool_permission_request | asktool_request | compaction_start | compaction_end |
 *     error | status
 */

export const RPC_PATH = "/api/rpc";
export const MUTATION_PATH = "/api/mutation";
export const LOGIN_PATH = "/api/login";
export const HEALTH_PATH = "/api/health";
export const UPLOAD_PATH = "/api/upload";
export const ATTACHMENT_PATH = "/api/attachment";
export const WS_PATH = "/ws";

export const FILENAME_HEADER = "X-Filename";
export const SESSION_HEADER = "X-Session-Id";

/** 浏览器记住设备令牌；主机仅保存哈希，撤销、改密或到期后失效。 */
export const TOKEN_STORAGE_KEY = "lan-remote-control.token";
export const DEVICE_NAME_STORAGE_KEY = "lan-remote-control.device-name";

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 20_000;
export const READ_TIMEOUT_MS = 25_000;
export const MUTATION_TIMEOUT_MS = 60_000;
/** 语音/输入长度上限：与 adapter limits.maxTextPromptChars 的默认值一致。 */
export const DEFAULT_MAX_PROMPT_CHARS = 262_144;
export const DEFAULT_MAX_ATTACHMENTS = 8;
export const MAX_QUOTE_CHARS = 2000;

export const ErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "MUTATION_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INVALID_PARAMS: "INVALID_PARAMS",
  OPERATION_NOT_ALLOWED: "OPERATION_NOT_ALLOWED",
  UNSUPPORTED: "UNSUPPORTED",
  NOT_READY: "NOT_READY",
  SESSION_BUSY: "SESSION_BUSY",
  QUEUE_LOCKED: "QUEUE_LOCKED",
  PLAN_PENDING: "PLAN_PENDING",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  AGENT_BUSY: "AGENT_BUSY",
  PATH_OUTSIDE_WORKSPACE: "PATH_OUTSIDE_WORKSPACE",
  TIMEOUT: "TIMEOUT",
  NETWORK: "NETWORK",
  INTERNAL: "INTERNAL",
  /** 本文件内部使用：结果不确定（断线且服务端没有该 mutation 记录）。 */
  UNKNOWN_RESULT: "UNKNOWN_RESULT",
};

/** 读操作（不得携带 mutationId）。 */
export const READ_OPERATIONS = [
  "capabilities",
  "projects.list",
  "workspace.get",
  "sessions.list",
  "sessions.get",
  "sessions.messages",
  "sessions.pending",
  "models.list",
  "commands.list",
  "queue.list",
  "collaboration.get",
  "attachments.read",
  "plans.list",
];

/** 变更操作（必须携带 mutationId）。 */
export const MUTATION_OPERATIONS = [
  "sessions.create",
  "sessions.fork",
  "chat.send",
  "chat.edit",
  "chat.retry",
  "chat.stop",
  "queue.push",
  "queue.remove",
  "queue.prioritize",
  "queue.reorder",
  "queue.edit",
  "models.configure",
  "approval.resolve",
  "ask.resolve",
  "plans.resolve",
];

const MUTATION_SET = new Set(MUTATION_OPERATIONS);

export function isMutationOperation(operation) {
  return MUTATION_SET.has(operation);
}

/** 需要桌面原生确认的操作：手机上提交后仍需在电脑上点确认。 */
export const DESKTOP_CONFIRMATION_OPERATIONS = new Set([
  "models.configure",
  "approval.resolve",
  "ask.resolve",
  "plans.resolve",
]);

/** 工具审批的决策取值；契约（plan/goal）审批用 approve/reject。 */
export const TOOL_APPROVAL_DECISIONS = ["allow-once", "allow-session", "deny"];
export const CONTRACT_APPROVAL_DECISIONS = ["approve", "reject"];

export const DECISION_LABELS = {
  "allow-once": "允许一次",
  "allow-session": "本会话允许",
  deny: "拒绝",
  approve: "通过",
  reject: "拒绝",
};

export const PERMISSION_MODE_LABELS = {
  ask: "每次询问",
  "accept-edits": "自动接受编辑",
  auto: "自动",
  inherit: "跟随默认",
};

export const SESSION_MODE_LABELS = {
  agent: "智能体",
  plan: "计划",
  goal: "目标",
};

export const TURN_STATUS_LABELS = {
  idle: "空闲",
  running: "运行中",
  waiting_permission: "等待确认",
  queued: "排队中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  aborted: "已中止",
  error: "出错",
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message || code || "protocol error");
    this.name = "ProtocolError";
    this.code = code || "PROTOCOL_ERROR";
    this.retriable = Boolean(details && details.retriable);
    this.operation = details && details.operation;
    this.status = details && details.status;
    this.requestId = details && details.requestId;
    this.details = details && details.details;
  }
}

/** 结果不确定（断线、超时且服务端查不到记录）时使用；绝不自动重放。 */
export class UnknownResultError extends ProtocolError {
  constructor(message, details) {
    super(ErrorCodes.UNKNOWN_RESULT, message || "结果不确定：电脑端可能已经执行，请先核对再决定是否重试", details);
    this.name = "UnknownResultError";
    this.mutationId = details && details.mutationId;
  }
}

export function uuid() {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function pick(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (key in source) {
      const value = source[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

export function asString(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asNumber(value, fallback = 0) {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : fallback;
}

export function asBool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  if (typeof value === "object") return [value];
  return [];
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** JSON 值 → 可展示文本；只用于工具参数/结果这类结构化内容。 */
export function prettyJson(value, maxLength = 4000) {
  if (value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxLength);
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (typeof text !== "string") text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
}

export function asIso(value, fallback = "") {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const raw = typeof value === "string" ? value : "";
  if (!raw) return fallback;
  return Number.isFinite(Date.parse(raw)) ? raw : fallback;
}

export function formatTime(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return hhmm;
  const sameYear = date.getFullYear() === now.getFullYear();
  const ymd = `${date.getMonth() + 1}/${date.getDate()}`;
  return sameYear ? `${ymd} ${hhmm}` : `${date.getFullYear()}/${ymd} ${hhmm}`;
}

export function formatRelative(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return formatTime(iso);
}

export function formatBytes(value) {
  const size = asNumber(value, 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms) {
  const value = asNumber(ms, 0);
  if (!value) return "";
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}分${seconds}秒`;
}

/** 倒计时文案（审批有效期）。 */
export function formatCountdown(expiresAt) {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "";
  const left = ms - Date.now();
  if (left <= 0) return "已过期";
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** 从设备 UA 猜一个默认设备名。 */
export function suggestDeviceName(userAgent) {
  const ua = String(userAgent || "");
  const platform = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : "浏览器";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return `${platform}${browser ? ` · ${browser}` : ""}`;
}

// ---------------------------------------------------------------------------
// 资源归一化（PROTOCOL.md §6）
// ---------------------------------------------------------------------------

export function normalizeProject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(pick(raw, ["id", "projectId"]));
  if (!id) return null;
  return {
    id,
    name: asString(pick(raw, ["name", "label"])) || id,
    path: asString(pick(raw, ["path"])),
    pinned: asBool(pick(raw, ["pinned"]), false),
  };
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(pick(raw, ["id", "sessionId"]));
  if (!id) return null;
  return {
    id,
    title: asString(pick(raw, ["title", "name"])) || "未命名会话",
    projectId: asString(pick(raw, ["projectId"]), ""),
    projectPath: asString(pick(raw, ["projectPath"]), ""),
    mode: asString(pick(raw, ["mode"]), "agent"),
    permissionMode: asString(pick(raw, ["permissionMode"]), "inherit"),
    providerId: asString(pick(raw, ["providerId"])),
    modelId: asString(pick(raw, ["modelId"])),
    modelKey: asString(pick(raw, ["modelKey"])),
    thinkingLevel: asString(pick(raw, ["thinkingLevel"])),
    createdAt: asIso(pick(raw, ["createdAt"])),
    updatedAt: asIso(pick(raw, ["updatedAt", "createdAt"])),
    running: asBool(pick(raw, ["running"]), false),
    source: asString(pick(raw, ["source"]), "desktop"),
    readOnlyReason: asString(pick(raw, ["readOnlyReason"])),
  };
}

export function normalizeStatus(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    sessionId: asString(pick(raw, ["sessionId"])),
    running: asBool(pick(raw, ["running", "isRunning"]), false),
    currentTurnId: asString(pick(raw, ["currentTurnId"])),
    modelId: asString(pick(raw, ["modelId"])),
    pendingToolConfirmations: asNumber(pick(raw, ["pendingToolConfirmations"]), 0),
    planningState: asString(pick(raw, ["planningState"])),
    pendingPlanId: asString(pick(raw, ["pendingPlanId"])),
    activity: pick(raw, ["activity"]) || null,
  };
}

export function normalizeAttachment(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    kind: asString(pick(raw, ["kind"]), "file") === "image" ? "image" : "file",
    name: asString(pick(raw, ["name"]), "附件"),
    ref: asString(pick(raw, ["ref"])),
    mimeType: asString(pick(raw, ["mimeType"])),
    size: asNumber(pick(raw, ["size"]), 0),
  };
}

/**
 * UiMessage → UI 转录项。
 * 工具消息（role "tool"）保留 toolCallId / toolStatus / toolArgs / toolResult。
 */
export function normalizeMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(pick(raw, ["id", "messageId"]));
  if (!id) return null;
  const role = asString(pick(raw, ["role"]), "assistant");
  const isTool = role === "tool";
  const toolStatus = asString(pick(raw, ["toolStatus"]));
  return {
    id,
    role,
    type: isTool ? "tool" : "message",
    text: textOf(pick(raw, ["content"])),
    thinking: asString(pick(raw, ["thinking"])),
    status: asString(pick(raw, ["status"]), "complete"),
    createdAt: asIso(pick(raw, ["createdAt"])),
    attachments: asArray(pick(raw, ["attachments"])).map((item) => normalizeAttachment(item)).filter(Boolean),
    command: asString(pick(raw, ["command"])),
    steering: asBool(pick(raw, ["steering"]), false),
    agentName: asString(pick(raw, ["agentName"])),
    parentToolCallId: asString(pick(raw, ["parentToolCallId"])),
    error: normalizeAppError(pick(raw, ["error"])),
    revisionRootId: asString(pick(raw, ["revisionRootId"])),
    revisionCount: asNumber(pick(raw, ["revisionCount"]), 0),
    activeRevision: asNumber(pick(raw, ["activeRevision"]), 0),
    tool: isTool
      ? {
          name: asString(pick(raw, ["toolName"]), "工具"),
          callId: asString(pick(raw, ["toolCallId"])),
          status: toolStatus || (asBool(pick(raw, ["isError"]), false) ? "error" : "success"),
          args: pick(raw, ["toolArgs"]),
          result: pick(raw, ["toolResult"]),
          isError: asBool(pick(raw, ["isError"]), toolStatus === "error"),
          durationMs: asNumber(pick(raw, ["toolDurationMs"]), 0),
        }
      : null,
    summary: "",
    sequence: 0,
  };
}

export function normalizeAppError(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    code: asString(pick(raw, ["code"])),
    message: asString(pick(raw, ["message", "detail"])),
  };
}

export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = asString(pick(raw, ["key", "modelKey"]));
  if (!key) return null;
  return {
    key,
    providerId: asString(pick(raw, ["providerId"])),
    modelId: asString(pick(raw, ["modelId"])),
    label: asString(pick(raw, ["label", "alias"])) || key,
    isDefault: asBool(pick(raw, ["isDefault"]), false),
    availableForSubagents: asBool(pick(raw, ["availableForSubagents"]), false),
    capabilities: asArray(pick(raw, ["capabilities"])).map((value) => asString(value)).filter(Boolean),
    thinkingLevels: asArray(pick(raw, ["thinkingLevels"])).map((value) => asString(value)).filter(Boolean),
    contextWindow: asNumber(pick(raw, ["contextWindow"]), 0) || null,
    maxTokens: asNumber(pick(raw, ["maxTokens"]), 0) || null,
  };
}

/**
 * commands.list 的条目：`kind` 区分模板 / 技能 / 插件 / 扩展 / 内置，
 * UI 按 kind 分组，沿用宿主“桌面专属在手机禁用”的语义。
 */
export function normalizeCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = asString(pick(raw, ["name", "title"]));
  if (!name) return null;
  return {
    name,
    kind: asString(pick(raw, ["kind"]), "template"),
    title: asString(pick(raw, ["title"])) || name,
    description: asString(pick(raw, ["description"])),
    argumentHint: asString(pick(raw, ["argumentHint"])),
    skillId: asString(pick(raw, ["skillId"])),
    remoteDisabled: asBool(pick(raw, ["remoteDisabled", "disabled"]), false),
    disabledReason: asString(pick(raw, ["disabledReason", "reason"])),
  };
}

export function normalizeQueueItem(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(pick(raw, ["turnId", "id"]));
  if (!id) return null;
  const priority = pick(raw, ["priority"]);
  return {
    id,
    text: textOf(pick(raw, ["content", "text"])),
    position: asNumber(pick(raw, ["position"]), index + 1),
    priority: priority === undefined ? null : asNumber(priority, 0),
    locked: asBool(pick(raw, ["locked"]), priority !== undefined && priority !== null),
    attachments: asArray(pick(raw, ["attachments"])).map((item) => normalizeAttachment(item)).filter(Boolean),
    createdAt: asIso(pick(raw, ["createdAt"])),
  };
}

export function normalizeCollaboration(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    sessionId: asString(pick(raw, ["sessionId"])),
    title: asString(pick(raw, ["title"])),
    status: asString(pick(raw, ["status"]), "idle"),
    observedAt: asIso(pick(raw, ["observedAt"])),
    modelKey: asString(pick(raw, ["modelKey"])),
    providerName: asString(pick(raw, ["providerName"])),
    modelName: asString(pick(raw, ["modelName"])),
    currentTask: pick(raw, ["currentTask"]) || null,
    result: pick(raw, ["result"]) || null,
  };
}

export function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const proposalId = asString(pick(raw, ["proposalId", "id"]));
  if (!proposalId) return null;
  return {
    proposalId,
    turnId: asString(pick(raw, ["turnId"])),
    toolCallId: asString(pick(raw, ["toolCallId"])),
    version: asNumber(pick(raw, ["version"]), 0),
    title: asString(pick(raw, ["title"])),
    markdown: asString(pick(raw, ["markdown", "plan"])),
    question: asString(pick(raw, ["question"])),
    state: asString(pick(raw, ["state"])),
    kind: asString(pick(raw, ["kind"])),
    targetPermissionMode: asString(pick(raw, ["targetPermissionMode"])),
  };
}

/** 工具审批请求（AgentEvent.tool_permission_request.request）。 */
export function normalizeApprovalRequest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(pick(raw, ["requestId", "id", "approvalId"]));
  if (!id) return null;
  return {
    id,
    kind: "tool",
    sessionId: asString(pick(raw, ["sessionId"])),
    toolCallId: asString(pick(raw, ["toolCallId"])),
    toolName: asString(pick(raw, ["toolName"]), "工具"),
    argsPreview: pick(raw, ["argsPreview", "args"]),
    risk: asString(pick(raw, ["risk"]), ""),
    reason: asString(pick(raw, ["reason"])),
    agentName: asString(pick(raw, ["agentName"])),
    parentToolCallId: asString(pick(raw, ["parentToolCallId"])),
    createdAt: asIso(pick(raw, ["createdAt", "ts"]), new Date().toISOString()),
    allowedDecisions: TOOL_APPROVAL_DECISIONS,
    allowedPermissionModes: [],
    requiresDesktopConfirm: true,
  };
}

/** 智能体提问（AgentEvent.asktool_request.request）。 */
export function normalizeAskRequest(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(pick(raw, ["requestId", "id", "questionId"]));
  if (!id) return null;
  const questions = asArray(pick(raw, ["questions"])).map((question, index) => ({
    id: `${id}:${index}`,
    question: asString(pick(question, ["question", "text"])) || "需要输入",
    options: asArray(pick(question, ["options", "choices"])).map((option) => asString(option)).filter(Boolean),
    multiSelect: asBool(pick(question, ["multiSelect"]), false),
  }));
  if (!questions.length) {
    questions.push({ id: `${id}:0`, question: "需要输入", options: [], multiSelect: false });
  }
  return {
    id,
    sessionId: asString(pick(raw, ["sessionId"])),
    toolCallId: asString(pick(raw, ["toolCallId"])),
    createdAt: asIso(pick(raw, ["createdAt", "ts"]), new Date().toISOString()),
    questions,
    requiresDesktopConfirm: true,
  };
}

/** 待处理计划的统称（Pending.plans / planning_state 事件）。 */
export function normalizePending(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    plans: asArray(pick(source, ["plans"])).map((item) => normalizePlan(item)).filter(Boolean),
    notes: asArray(pick(source, ["notes"])).map((item) => asString(item)).filter(Boolean),
    approvalsFromEventsOnly: asBool(pick(pick(source, ["live"]) || {}, ["approvals"]), true) !== false,
  };
}

export function normalizeHealth(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    name: asString(pick(source, ["name"])),
    version: asString(pick(source, ["version"])),
    requiresAuth: asBool(pick(source, ["requiresAuth"]), true),
    passwordConfigured: asBool(pick(source, ["passwordConfigured"]), false),
    capabilities: pick(source, ["capabilities"]) || {},
  };
}

/** WS ready 帧。 */
export function normalizeReady(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const device = pick(source, ["device"]);
  const capabilities = pick(source, ["capabilities"]);
  return {
    device: device && typeof device === "object" ? { id: asString(pick(device, ["id"])), name: asString(pick(device, ["name"])) } : null,
    capabilities: capabilities && typeof capabilities === "object" ? capabilities : {},
  };
}

/** capabilities 操作的结果（PROTOCOL.md §2）。 */
export function normalizeCapabilities(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const operationsRaw = pick(source, ["operations"]);
  const operations = {};
  if (operationsRaw && typeof operationsRaw === "object") {
    for (const [name, value] of Object.entries(operationsRaw)) {
      const entry = value && typeof value === "object" ? value : {};
      operations[name] = {
        supported: asBool(pick(entry, ["supported"]), true),
        mutation: asBool(pick(entry, ["mutation"]), isMutationOperation(name)),
        needsDesktopConfirmation: asBool(pick(entry, ["needsDesktopConfirmation"]), DESKTOP_CONFIRMATION_OPERATIONS.has(name)),
        stage: asNumber(pick(entry, ["stage"]), 1),
        reason: asString(pick(entry, ["reason"])),
        description: asString(pick(entry, ["description"])),
      };
    }
  }
  const events = pick(source, ["events"]) || {};
  const limits = pick(source, ["limits"]) || {};
  const host = pick(source, ["host"]) || {};
  const adapter = pick(source, ["adapter"]) || {};
  return {
    operations,
    needsDesktopConfirmation: new Set(
      asArray(pick(source, ["needsDesktopConfirmation"])).map((value) => asString(value)).filter(Boolean),
    ),
    events: {
      transport: asBool(pick(events, ["transport"]), true),
      hostApi: asBool(pick(events, ["hostApi"]), true),
      subscribe: asBool(pick(events, ["subscribe"]), true),
      unsubscribe: asBool(pick(events, ["unsubscribe"]), true),
      replay: asString(pick(events, ["replay"]), "snapshot-then-delta"),
    },
    host: { name: asString(pick(host, ["name"])), version: asString(pick(host, ["version"])) },
    adapter: { version: asString(pick(adapter, ["version"])), protocol: asNumber(pick(adapter, ["protocol"]), 0) },
    limits: {
      maxUploadBytes: asNumber(pick(limits, ["maxUploadBytes"]), 10 * 1024 * 1024),
      maxTextPromptChars: asNumber(pick(limits, ["maxTextPromptChars"]), DEFAULT_MAX_PROMPT_CHARS),
      maxAttachmentsPerMessage: asNumber(pick(limits, ["maxAttachmentsPerMessage"]), DEFAULT_MAX_ATTACHMENTS),
      maxMessagesPerPage: asNumber(pick(limits, ["maxMessagesPerPage"]), 200),
      maxQueueItems: asNumber(pick(limits, ["maxQueueItems"]), 500),
    },
    notes: asArray(pick(source, ["notes"])).map((value) => asString(value)).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// 事件归一化
// ---------------------------------------------------------------------------

/**
 * WS `{ type: "event", event }` 的内层事件归一化。
 * 返回 { kind, sessionId, at, agentEvent?, payload? }；不识别的 kind 保留原名，
 * 由调用方决定忽略（不伪造内容）。
 */
export function normalizeSubscriptionEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = asString(pick(raw, ["kind", "type"]));
  if (!kind) return null;
  const sessionId = asString(pick(raw, ["sessionId"]));
  const at = asIso(pick(raw, ["at", "ts"]), new Date().toISOString());
  const payload = pick(raw, ["payload"]);

  if (kind === "agent.event") {
    const envelope = payload && typeof payload === "object" ? payload : {};
    const agentEvent = pick(envelope, ["event"]);
    if (!agentEvent || typeof agentEvent !== "object") return null;
    return {
      kind,
      sessionId: asString(pick(envelope, ["sessionId"]), sessionId),
      turnId: asString(pick(envelope, ["turnId"])),
      agentName: asString(pick(envelope, ["agentName"])),
      parentToolCallId: asString(pick(envelope, ["parentToolCallId"])),
      at,
      agentEvent: {
        type: asString(pick(agentEvent, ["type"])),
        raw: agentEvent,
      },
    };
  }
  return { kind, sessionId, at, payload: payload && typeof payload === "object" ? payload : {} };
}

/** 事件去重键：有 eventId 用 id，否则用 (kind, sessionId, type, ts)。 */
export function eventDedupeKey(event) {
  if (!event) return "";
  const type = event.agentEvent ? event.agentEvent.type : event.kind;
  return `${event.kind}|${event.sessionId}|${type}|${event.at}|${event.turnId || ""}`;
}

export function isUnknownOperationError(error) {
  if (!error) return false;
  if (error.code === ErrorCodes.OPERATION_NOT_ALLOWED) return true;
  if (error.code === "METHOD_NOT_FOUND" || error.code === "UNKNOWN_OPERATION") return true;
  if (error.status === 404 || error.status === 405) return true;
  return false;
}

/** 从服务端错误对象构造 ProtocolError。 */
export function protocolErrorFromResponse(response, fallbackMessage, operation) {
  const envelope = response && typeof response === "object" ? response : {};
  const error = envelope.error && typeof envelope.error === "object" ? envelope.error : envelope;
  const code = asString(pick(error, ["code"]), "INTERNAL");
  const message = asString(pick(error, ["message", "detail"]), fallbackMessage || code);
  return new ProtocolError(code, message, {
    operation,
    requestId: asString(pick(envelope, ["requestId"])),
    retriable: asBool(pick(error, ["retriable", "retryable"]), false),
    details: pick(error, ["details"]),
  });
}

/** 把错误翻译成给用户看的一句话；未知错误原样透出 code。 */
export function describeError(error) {
  if (!error) return "未知错误";
  const code = asString(error.code);
  const message = asString(error.message);
  switch (code) {
    case ErrorCodes.UNAUTHORIZED:
      return "连接已失效，请重新登录";
    case ErrorCodes.CONFIRMATION_REQUIRED:
      return "需要电脑上的确认，请查看桌面端弹窗";
    case ErrorCodes.FORBIDDEN:
      return message || "电脑端拒绝了这次操作";
    case ErrorCodes.SESSION_BUSY:
      return "会话正在运行：先停止或改用排队发送";
    case ErrorCodes.QUEUE_LOCKED:
      return "该队列项已「立即发送」，不能移动或编辑";
    case ErrorCodes.PLAN_PENDING:
      return "有待处理的计划审批，先在电脑或手机上处理";
    case ErrorCodes.AGENT_BUSY:
      return "电脑端繁忙，请稍后重试";
    case ErrorCodes.PAYLOAD_TOO_LARGE:
      return "内容超过大小限制";
    case ErrorCodes.RATE_LIMITED:
      return "操作太频繁，请稍后再试";
    case ErrorCodes.UNSUPPORTED:
      return message || "电脑端宿主不支持这个操作";
    case ErrorCodes.OPERATION_NOT_ALLOWED:
      return message || "电脑端不允许这个操作";
    case ErrorCodes.NOT_FOUND:
      return message || "目标不存在或已被删除";
    case ErrorCodes.MUTATION_CONFLICT:
      return "同一请求的重复提交内容不一致，已阻止执行";
    case ErrorCodes.UNKNOWN_RESULT:
      return message || "结果不确定：电脑端可能已执行，请先核对";
    case ErrorCodes.TIMEOUT:
      return "请求超时";
    case ErrorCodes.NETWORK:
      return "网络不可达";
    default:
      return message || code || "操作失败";
  }
}
