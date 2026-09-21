/**
 * Subagent context checkpoint serialization, validation and codec.
 * Strictly whitelisted message serialization and state snapshotting (ADR 0089).
 */

import type {
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  MessageUsage,
  SubagentDefinition,
  SubagentGuideReceipt,
  SubagentProgressReport,
  SubagentStep,
  SubagentThinkingLevel,
} from "@pi-desktop/shared";

export const SUBAGENT_CHECKPOINT_FORMAT_VERSION = 1;
export const SUBAGENT_CONTEXT_CODEC_VERSION = 1;

export class SubagentCodecError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SubagentCodecError";
    this.code = code;
  }
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

/** Local robust factory for CompactionSummaryMessage */
export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: number = Date.now(),
): AgentMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp,
  } as unknown as AgentMessage;
}

/** Sanitize baseUrl by stripping query parameters, hashes and embedded credentials */
export function sanitizeBaseUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.split("?")[0].replace(/\/$/, "");
  }
}

/** Check disallowed scratch temporary path pattern in attachment/URI references */
const SCRATCH_PATH_PATTERNS = [
  /[\\/]\.pi-desktop[\\/]scratch[\\/]/i,
  /[\\/]scratch[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /[a-zA-Z]:[\\/][^\\/]+[\\/]\.pi-desktop[\\/]scratch[\\/]/i,
];

export function isDisallowedScratchUri(uriOrPath: string): boolean {
  if (typeof uriOrPath !== "string") return false;
  for (const pattern of SCRATCH_PATH_PATTERNS) {
    if (pattern.test(uriOrPath)) return true;
  }
  const scratchEnv = process.env.PI_SCRATCH_DIR;
  if (scratchEnv && scratchEnv.length > 3 && uriOrPath.includes(scratchEnv)) {
    return true;
  }
  return false;
}

/** Enforce that attachment references do not point to scratch paths without leaking values */
export function assertNoDisallowedScratchAttachment(attachmentRef: unknown, location: string): void {
  if (typeof attachmentRef === "string") {
    if (isDisallowedScratchUri(attachmentRef)) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_SCRATCH_PATH_REJECTED",
        `Disallowed reference to session scratch directory found in attachment at ${location}`,
      );
    }
  } else if (attachmentRef && typeof attachmentRef === "object") {
    const obj = attachmentRef as Record<string, unknown>;
    if (typeof obj.path === "string" && isDisallowedScratchUri(obj.path)) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_SCRATCH_PATH_REJECTED",
        `Disallowed reference to session scratch directory found in attachment path at ${location}`,
      );
    }
    if (typeof obj.url === "string" && isDisallowedScratchUri(obj.url)) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_SCRATCH_PATH_REJECTED",
        `Disallowed reference to session scratch directory found in attachment url at ${location}`,
      );
    }
  }
}

/** Reject unknown properties in strict whitelist objects */
function assertKnownKeys(obj: Record<string, unknown>, allowedKeys: readonly string[], location: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_UNKNOWN_FIELD",
        `Unrecognized property '${key}' found at ${location}`,
      );
    }
  }
}

/* Whitelisted Content Part Definitions */
export type SerializedTextContent = {
  type: "text";
  text: string;
  textSignature?: string;
};

export type SerializedThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
};

export type SerializedToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  namespace?: string;
};

export type SerializedImageContent = {
  type: "image";
  mimeType: string;
  data: string; // inline base64 data
};

export type SerializedAssistantContentPart =
  | SerializedTextContent
  | SerializedThinkingContent
  | SerializedToolCallContent;

export type SerializedUserContentPart =
  | SerializedTextContent
  | SerializedImageContent;

export type SerializedUserMessage = {
  role: "user";
  content: string | SerializedUserContentPart[];
  timestamp: number;
};

export type SerializedAssistantMessage = {
  role: "assistant";
  content: SerializedAssistantContentPart[];
  api: string;
  provider: string;
  model: string;
  usage?: Usage;
  stopReason?: "stop" | "toolUse" | "length";
  timestamp: number;
} & Pick<AssistantMessage, "responseModel" | "responseId" | "providerThinkingLevel" | "diagnostics" | "rawStopReason" | "endTurn">;

export type SerializedToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string | SerializedUserContentPart[];
  details?: Record<string, unknown>;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
};

export type SerializedCompactionSummaryMessage = {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
};

export type SerializedAgentMessage =
  | SerializedUserMessage
  | SerializedAssistantMessage
  | SerializedToolResultMessage
  | SerializedCompactionSummaryMessage;

export interface SubagentCheckpointHeader {
  formatVersion: number;
  contextCodecVersion: number;
  sessionId: string;
  delegationId: string;
  projectRealPath: string;
  createdAt: number;
  savedAt: number;
  appVersion?: string;
}

export interface SubagentExecutionIdentity {
  execution: number;
  executionId: string;
  generation: number;
  lastStatus: "completed";
  parentTurnId?: string;
  parentToolCallId: string;
}

export interface SubagentCompactionState {
  checkpointSummary?: string;
  checkpointTokensBefore: number;
  contextCompactions: number;
  summaryMessageIndex?: number;
}

export interface SubagentModelBindingSnapshot {
  provider: {
    id: string;
    name: string;
    baseUrl: string; // sanitized baseUrl
    modelId: string;
    api: string; // wire API
    apiStyle?: string;
    authKind: string;
    supportsReasoning?: boolean;
    supportedThinkingLevels?: string[];
    endpointFingerprint: string;
  };
  primaryModel: {
    id: string;
    modelId: string;
    api: string;
    endpointFingerprint: string;
  };
  thinkingLevel: SubagentThinkingLevel;
  fallbackIndex: number;
  attemptedModels: string[];
  modelFailures: Array<{ model: string; code: string; message: string }>;
  fallbackModels?: Array<{
    key: string;
    provider?: {
      id: string;
      name: string;
      baseUrl: string;
      modelId: string;
      api?: string;
      authKind?: string;
      endpointFingerprint?: string;
    };
  }>;
}

export interface SubagentConfigSnapshot {
  task: string;
  definition: SubagentDefinition;
  systemPrompt: string;
  systemPromptFingerprint: string;
  toolNames: string[];
  toolsFingerprint: string;
  permissions: {
    subagentCanMutate: boolean;
  };
}

export interface SubagentUsageSnapshot {
  turns: number;
  toolCalls: number;
  usage?: MessageUsage;
  executionUsage?: MessageUsage;
  lastReportText: string;
  activityDurationMs?: number;
}

export interface SubagentObserverSnapshot {
  execution: number;
  interval: number;
  intervalSource: "definition" | "dispatch";
  segmentId: number;
  segmentCompleted: number;
  started: number;
  completed: number;
  pendingCount: number;
  pendingErrors: number;
  pendingFrom?: number;
  pendingTo?: number;
  reportSeq: number;
  latestReport?: SubagentProgressReport;
  statement?: string;
  phase: "finished";
  stopSource?: "user" | "parent" | "session";
  guides: SubagentGuideReceipt[];
  steps: SubagentStep[];
  seenSteps: string[];
  seenGuides: string[];
}

export interface SubagentCheckpoint {
  header: SubagentCheckpointHeader;
  execution: SubagentExecutionIdentity;
  compaction: SubagentCompactionState;
  modelBinding: SubagentModelBindingSnapshot;
  config: SubagentConfigSnapshot;
  usage: SubagentUsageSnapshot;
  observer: SubagentObserverSnapshot;
  messages: SerializedAgentMessage[];
}

/**
 * Enforces strict toolCall <-> toolResult pairing in message sequence.
 * Validates unique toolCall IDs, toolName consistency, and batch closure.
 */
export function validatePairedToolCalls(messages: readonly (AgentMessage | SerializedAgentMessage)[]): void {
  const seenCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  const openToolCalls = new Map<string, { name: string; messageIndex: number }>();

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    if (msg.role === "assistant") {
      // Prior tool calls must have been answered before another assistant turn
      if (openToolCalls.size > 0) {
        const unclosed = Array.from(openToolCalls.entries())
          .map(([id, info]) => `${info.name}(${id})`)
          .join(", ");
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_TOOL_UNPAIRED",
          `Assistant message at index ${idx} appeared before preceding tool calls were resolved: ${unclosed}`,
        );
      }
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const part of parts) {
        if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
          const call = part as { id: string; name: string };
          if (!call.id) {
            throw new SubagentCodecError("SUBAGENT_CODEC_TOOL_UNPAIRED", `Missing toolCall id at message index ${idx}`);
          }
          if (seenCallIds.has(call.id)) {
            throw new SubagentCodecError("SUBAGENT_CODEC_TOOL_UNPAIRED", `Duplicate toolCall id '${call.id}' at message index ${idx}`);
          }
          seenCallIds.add(call.id);
          openToolCalls.set(call.id, { name: call.name, messageIndex: idx });
        }
      }
    } else if (msg.role === "toolResult") {
      const toolCallId = (msg as { toolCallId: string }).toolCallId;
      const toolName = (msg as { toolName: string }).toolName;
      if (!toolCallId) {
        throw new SubagentCodecError("SUBAGENT_CODEC_TOOL_UNPAIRED", `ToolResultMessage missing toolCallId at message index ${idx}`);
      }
      if (seenResultIds.has(toolCallId)) {
        throw new SubagentCodecError("SUBAGENT_CODEC_TOOL_UNPAIRED", `Duplicate toolResult for toolCallId '${toolCallId}' at message index ${idx}`);
      }
      const expected = openToolCalls.get(toolCallId);
      if (!expected) {
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_TOOL_UNPAIRED",
          `Orphaned toolResult with toolCallId '${toolCallId}' at message index ${idx} without active preceding toolCall`,
        );
      }
      if (toolName && expected.name && toolName !== expected.name) {
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_TOOL_UNPAIRED",
          `Tool name mismatch for toolCallId '${toolCallId}': expected '${expected.name}', got '${toolName}' at message index ${idx}`,
        );
      }
      seenResultIds.add(toolCallId);
      openToolCalls.delete(toolCallId);
    }
  }

  if (openToolCalls.size > 0) {
    const unclosed = Array.from(openToolCalls.entries())
      .map(([id, info]) => `${info.name}(${id})`)
      .join(", ");
    throw new SubagentCodecError(
      "SUBAGENT_CODEC_TOOL_UNPAIRED",
      `Completed subagent context has unclosed tool calls: ${unclosed}`,
    );
  }
}

/** 保留模型库定义的响应元数据，供恢复上下文和诊断使用。 */
function assistantMetadata(message: Pick<AssistantMessage, "responseModel" | "responseId" | "providerThinkingLevel" | "diagnostics" | "rawStopReason" | "endTurn">) {
  return {
    ...(typeof message.responseModel === "string" ? { responseModel: message.responseModel } : {}),
    ...(typeof message.responseId === "string" ? { responseId: message.responseId } : {}),
    ...(typeof message.providerThinkingLevel === "string" ? { providerThinkingLevel: message.providerThinkingLevel } : {}),
    ...(Array.isArray(message.diagnostics) ? { diagnostics: message.diagnostics.map((item) => ({ ...item })) } : {}),
    ...(typeof message.rawStopReason === "string" ? { rawStopReason: message.rawStopReason } : {}),
    ...(typeof message.endTurn === "boolean" ? { endTurn: message.endTurn } : {}),
  };
}

/** Encode AgentMessage sequence with strict whitelist codec */
export function encodeAgentMessages(
  messages: readonly AgentMessage[],
  validBindings?: Array<{ providerId: string; modelId: string; api?: string }>,
): SerializedAgentMessage[] {
  validatePairedToolCalls(messages);

  const serialized: SerializedAgentMessage[] = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const message = messages[idx];
    if (!message || typeof message !== "object") {
      throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Message at index ${idx} is not an object`);
    }

    switch (message.role) {
      case "user": {
        const u = message as UserMessage;
        assertKnownKeys(u as unknown as Record<string, unknown>, ["role", "content", "timestamp"], `messages[${idx}]`);
        let content: string | SerializedUserContentPart[];
        if (typeof u.content === "string") {
          content = u.content;
        } else if (Array.isArray(u.content)) {
          content = u.content.map((part, pIdx) => {
            if (!part || typeof part !== "object") {
              throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Invalid user content part at message ${idx}[${pIdx}]`);
            }
            const partObj = part as unknown as Record<string, unknown>;
            if (partObj.type === "text" && typeof partObj.text === "string") {
              assertKnownKeys(partObj, ["type", "text", "textSignature"], `messages[${idx}].content[${pIdx}]`);
              return {
                type: "text" as const,
                text: partObj.text,
                ...(typeof partObj.textSignature === "string" ? { textSignature: partObj.textSignature } : {}),
              };
            }
            if (partObj.type === "image") {
              assertKnownKeys(partObj, ["type", "mimeType", "data"], `messages[${idx}].content[${pIdx}]`);
              const data = typeof partObj.data === "string" ? partObj.data : "";
              const mimeType = typeof partObj.mimeType === "string" ? partObj.mimeType : "";
              if (!data) {
                throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Image part missing data at message ${idx}[${pIdx}]`);
              }
              if (!mimeType) {
                throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Image part missing mimeType at message ${idx}[${pIdx}]`);
              }
              assertNoDisallowedScratchAttachment(data, `messages[${idx}].content[${pIdx}].data`);
              return { type: "image" as const, mimeType, data };
            }
            throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Unknown user content part type at message ${idx}`);
          });
        } else {
          throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Unexpected user message content type at index ${idx}`);
        }
        serialized.push({
          role: "user",
          content,
          timestamp: typeof u.timestamp === "number" ? u.timestamp : Date.now(),
        });
        break;
      }

      case "assistant": {
        const a = message as AssistantMessage;
        assertKnownKeys(
          a as unknown as Record<string, unknown>,
          ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp",
            "responseModel", "responseId", "providerThinkingLevel", "diagnostics", "rawStopReason", "endTurn", "errorMessage", "deferred"],
          `messages[${idx}]`,
        );

        if (validBindings && validBindings.length > 0) {
          const match = validBindings.some((b) =>
            b.providerId === a.provider &&
            b.modelId === a.model &&
            (!b.api || !a.api || b.api === a.api),
          );
          if (!match) {
            throw new SubagentCodecError(
              "SUBAGENT_CODEC_BINDING_MISMATCH",
              `Assistant message binding (${a.provider}/${a.model}) at index ${idx} does not match any allowed task bindings`,
            );
          }
        }

        if (!Array.isArray(a.content)) {
          throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Assistant message content at index ${idx} must be an array`);
        }
        if (a.stopReason === "error" || a.stopReason === "aborted" || a.stopReason === "deferred") {
          throw new SubagentCodecError(
            "SUBAGENT_CODEC_INVALID_STRUCTURE",
            `Assistant message at index ${idx} has incomplete stopReason: ${a.stopReason}`,
          );
        }

        const contentParts: SerializedAssistantContentPart[] = [];
        for (let pIdx = 0; pIdx < a.content.length; pIdx++) {
          const part = a.content[pIdx] as unknown as Record<string, unknown>;
          if (!part || typeof part !== "object") continue;
          if (part.type === "text" && typeof part.text === "string") {
            assertKnownKeys(part, ["type", "text", "textSignature"], `messages[${idx}].content[${pIdx}]`);
            contentParts.push({
              type: "text",
              text: part.text,
              ...(typeof part.textSignature === "string" ? { textSignature: part.textSignature } : {}),
            });
          } else if (part.type === "thinking" && typeof part.thinking === "string") {
            assertKnownKeys(part, ["type", "thinking", "thinkingSignature", "redacted"], `messages[${idx}].content[${pIdx}]`);
            contentParts.push({
              type: "thinking",
              thinking: part.thinking,
              ...(typeof part.thinkingSignature === "string" ? { thinkingSignature: part.thinkingSignature } : {}),
              ...(typeof part.redacted === "boolean" ? { redacted: part.redacted } : {}),
            });
          } else if (part.type === "toolCall") {
            assertKnownKeys(part, ["type", "id", "name", "arguments", "thoughtSignature", "namespace"], `messages[${idx}].content[${pIdx}]`);
            const id = typeof part.id === "string" ? part.id : "";
            const name = typeof part.name === "string" ? part.name : "";
            const args = (part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments))
              ? (part.arguments as Record<string, unknown>)
              : {};
            contentParts.push({
              type: "toolCall", id, name, arguments: args,
              ...(typeof part.thoughtSignature === "string" ? { thoughtSignature: part.thoughtSignature } : {}),
              ...(typeof part.namespace === "string" ? { namespace: part.namespace } : {}),
            });
          } else {
            throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Unknown assistant content part type at index ${idx}`);
          }
        }

        const assistantMsg: SerializedAssistantMessage = {
          role: "assistant",
          content: contentParts,
          api: typeof a.api === "string" ? a.api : "",
          provider: typeof a.provider === "string" ? a.provider : "",
          model: typeof a.model === "string" ? a.model : "",
          timestamp: typeof a.timestamp === "number" ? a.timestamp : Date.now(),
          ...assistantMetadata(a),
        };

        if (a.stopReason === "stop" || a.stopReason === "toolUse" || a.stopReason === "length") {
          assistantMsg.stopReason = a.stopReason;
        }

        if (a.usage && typeof a.usage === "object") {
          const u = a.usage as Usage;
          assistantMsg.usage = {
            input: typeof u.input === "number" ? u.input : 0,
            output: typeof u.output === "number" ? u.output : 0,
            cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
            cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
            totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : 0,
            ...(typeof u.cacheWrite1h === "number" ? { cacheWrite1h: u.cacheWrite1h } : {}),
            ...(typeof u.reasoning === "number" ? { reasoning: u.reasoning } : {}),
            ...(u.cost ? { cost: { ...u.cost } } : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
          };
        }

        serialized.push(assistantMsg);
        break;
      }

      case "toolResult": {
        const t = message as ToolResultMessage;
        assertKnownKeys(
          t as unknown as Record<string, unknown>,
          ["role", "toolCallId", "toolName", "content", "details", "isError", "timestamp", "addedToolNames"],
          `messages[${idx}]`,
        );

        const detailAddedToolNames =
          t.details && typeof t.details === "object" && !Array.isArray(t.details)
            ? (t.details as Record<string, unknown>).addedToolNames
            : undefined;
        const rawAddedToolNames = detailAddedToolNames ?? (t as ToolResultMessage & { addedToolNames?: unknown }).addedToolNames;
        const addedToolNames = Array.isArray(rawAddedToolNames)
          ? (rawAddedToolNames as unknown[]).filter((n): n is string => typeof n === "string" && n.length > 0)
          : undefined;

        let content: string | SerializedUserContentPart[];
        if (typeof t.content === "string") {
          content = t.content;
        } else if (Array.isArray(t.content)) {
          content = t.content.map((part, pIdx) => {
            const partObj = part as unknown as Record<string, unknown>;
            if (partObj.type === "text" && typeof partObj.text === "string") {
              assertKnownKeys(partObj, ["type", "text", "textSignature"], `messages[${idx}].content[${pIdx}]`);
              return {
                type: "text" as const,
                text: partObj.text,
                ...(typeof partObj.textSignature === "string" ? { textSignature: partObj.textSignature } : {}),
              };
            }
            if (partObj.type === "image") {
              assertKnownKeys(partObj, ["type", "mimeType", "data"], `messages[${idx}].content[${pIdx}]`);
              const data = typeof partObj.data === "string" ? partObj.data : "";
              const mimeType = typeof partObj.mimeType === "string" ? partObj.mimeType : "";
              if (!data || !mimeType) {
                throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Tool result image missing data or mimeType at index ${idx}`);
              }
              assertNoDisallowedScratchAttachment(data, `messages[${idx}].content[${pIdx}].data`);
              return { type: "image" as const, mimeType, data };
            }
            throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Unknown toolResult content part at index ${idx}`);
          });
        } else {
          throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Unexpected toolResult content type at index ${idx}`);
        }

        serialized.push({
          role: "toolResult",
          toolCallId: typeof t.toolCallId === "string" ? t.toolCallId : "",
          toolName: typeof t.toolName === "string" ? t.toolName : "",
          content,
          ...(t.details && typeof t.details === "object" && !Array.isArray(t.details)
            ? { details: t.details as Record<string, unknown> }
            : {}),
          ...(addedToolNames && addedToolNames.length > 0 ? { addedToolNames } : {}),
          isError: Boolean(t.isError),
          timestamp: typeof t.timestamp === "number" ? t.timestamp : Date.now(),
        });
        break;
      }

      case "compactionSummary": {
        const c = message as unknown as { summary?: string; tokensBefore?: number; timestamp?: number };
        assertKnownKeys(c as unknown as Record<string, unknown>, ["role", "summary", "tokensBefore", "timestamp"], `messages[${idx}]`);
        serialized.push({
          role: "compactionSummary",
          summary: typeof c.summary === "string" ? c.summary : "",
          tokensBefore: typeof c.tokensBefore === "number" ? c.tokensBefore : 0,
          timestamp: typeof c.timestamp === "number" ? c.timestamp : Date.now(),
        });
        break;
      }

      default:
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_UNKNOWN_MESSAGE",
          `Unsupported message role '${(message as { role?: unknown }).role}' at index ${idx}`,
        );
    }
  }

  return serialized;
}

/** Decode serialized message sequence back into full AgentMessage array */
export function decodeAgentMessages(serialized: readonly SerializedAgentMessage[]): AgentMessage[] {
  validatePairedToolCalls(serialized);

  const messages: AgentMessage[] = [];
  for (let idx = 0; idx < serialized.length; idx++) {
    const raw = serialized[idx];
    if (!raw || typeof raw !== "object") {
      throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Serialized message at index ${idx} is invalid`);
    }
    switch (raw.role) {
      case "user": {
        const uMsg: UserMessage = {
          role: "user",
          content: raw.content as any,
          timestamp: raw.timestamp,
        };
        messages.push(uMsg as unknown as AgentMessage);
        break;
      }
      case "assistant": {
        const aMsg: AssistantMessage = {
          role: "assistant",
          content: raw.content as any,
          api: raw.api as any,
          provider: raw.provider,
          model: raw.model,
          timestamp: raw.timestamp,
          ...assistantMetadata(raw),
          stopReason: (raw.stopReason ?? "stop") as any,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        if (raw.usage) {
          aMsg.usage = {
            input: raw.usage.input,
            output: raw.usage.output,
            cacheRead: raw.usage.cacheRead,
            cacheWrite: raw.usage.cacheWrite,
            totalTokens: raw.usage.totalTokens,
            cost: raw.usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            ...(raw.usage.reasoning !== undefined ? { reasoning: raw.usage.reasoning } : {}),
            ...(raw.usage.cacheWrite1h !== undefined ? { cacheWrite1h: raw.usage.cacheWrite1h } : {}),
          };
        }
        messages.push(aMsg as unknown as AgentMessage);
        break;
      }
      case "toolResult": {
        const details: Record<string, unknown> =
          raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)
            ? { ...raw.details }
            : {};
        if (raw.addedToolNames && raw.addedToolNames.length > 0) {
          details.addedToolNames = raw.addedToolNames;
        }
        const tMsg: ToolResultMessage = {
          role: "toolResult",
          toolCallId: raw.toolCallId,
          toolName: raw.toolName,
          content: raw.content as any,
          ...(Object.keys(details).length > 0 ? { details } : {}),
          isError: raw.isError,
          timestamp: raw.timestamp,
        } as any;
        messages.push(tMsg as unknown as AgentMessage);
        break;
      }
      case "compactionSummary": {
        const summaryMsg = createCompactionSummaryMessage(
          raw.summary,
          raw.tokensBefore,
          raw.timestamp,
        );
        messages.push(summaryMsg);
        break;
      }
      default:
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_UNKNOWN_MESSAGE",
          `Cannot decode unknown message role '${(raw as any).role}' at index ${idx}`,
        );
    }
  }

  return messages;
}

/** Validate complete SubagentCheckpoint object */
export function validateCheckpoint(checkpoint: unknown): SubagentCheckpoint {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Checkpoint payload must be a non-null object");
  }
  const cp = checkpoint as SubagentCheckpoint;
  if (!cp.header || cp.header.formatVersion !== SUBAGENT_CHECKPOINT_FORMAT_VERSION) {
    throw new SubagentCodecError(
      "SUBAGENT_CODEC_UNSUPPORTED_VERSION",
      `Unsupported formatVersion: ${cp.header?.formatVersion}, expected ${SUBAGENT_CHECKPOINT_FORMAT_VERSION}`,
    );
  }
  if (cp.header.contextCodecVersion !== SUBAGENT_CONTEXT_CODEC_VERSION) {
    throw new SubagentCodecError(
      "SUBAGENT_CODEC_UNSUPPORTED_VERSION",
      `Unsupported contextCodecVersion: ${cp.header?.contextCodecVersion}, expected ${SUBAGENT_CONTEXT_CODEC_VERSION}`,
    );
  }
  if (!cp.header.sessionId || !cp.header.delegationId || !cp.header.projectRealPath) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Missing sessionId, delegationId, or projectRealPath in checkpoint header");
  }
  if (!cp.execution || cp.execution.lastStatus !== "completed") {
    throw new SubagentCodecError(
      "SUBAGENT_CODEC_NOT_COMPLETED",
      `Checkpoint execution status must be 'completed', got '${cp.execution?.lastStatus}'`,
    );
  }
  if (cp.execution.execution < 1 || cp.execution.generation < 1) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Invalid execution or generation index");
  }
  if (!cp.observer || cp.observer.phase !== "finished" || cp.observer.stopSource !== undefined) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Observer must be cleanly finished without stopSource");
  }
  if (cp.execution.execution !== cp.observer.execution) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Execution count mismatch between execution header and observer");
  }
  if (cp.observer.completed !== cp.usage.toolCalls) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Tool call counts mismatch between observer completed and usage");
  }

  // Ensure all observer guides are settled
  const pendingGuides = cp.observer.guides.filter((g) => g.status === "accepted" || g.status === "applying");
  if (pendingGuides.length > 0) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Checkpoint observer has ${pendingGuides.length} unsettled guides`);
  }

  if (!Array.isArray(cp.messages)) {
    throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "Checkpoint messages must be an array");
  }

  // Validate compaction state & summary index
  if (cp.compaction) {
    if (cp.compaction.checkpointSummary) {
      if (cp.compaction.summaryMessageIndex === undefined || cp.compaction.summaryMessageIndex < 0 || cp.compaction.summaryMessageIndex >= cp.messages.length) {
        throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "summaryMessageIndex missing or out of range for active checkpointSummary");
      }
      const targetSummaryMsg = cp.messages[cp.compaction.summaryMessageIndex];
      if (targetSummaryMsg?.role !== "compactionSummary") {
        throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", `Message at summaryMessageIndex (${cp.compaction.summaryMessageIndex}) is not a compactionSummary`);
      }
      if (!targetSummaryMsg.summary || !targetSummaryMsg.summary.includes(cp.compaction.checkpointSummary)) {
        throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "summaryMessageIndex message content does not match checkpointSummary");
      }
    } else if (cp.compaction.summaryMessageIndex !== undefined) {
      const targetSummaryMsg = cp.messages[cp.compaction.summaryMessageIndex];
      if (targetSummaryMsg?.role !== "compactionSummary") {
        throw new SubagentCodecError("SUBAGENT_CODEC_INVALID_STRUCTURE", "summaryMessageIndex does not point to a compactionSummary message");
      }
    }
  }

  // Deep decode validation: this validates all messages, content parts, and tool call pairing
  decodeAgentMessages(cp.messages);

  return cp;
}

/** Simple fast SHA-256 / digest helper for fingerprinting config, endpoints and prompts */
export function simplePromptFingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return `fp_${Math.abs(hash).toString(16)}`;
}

/** Compute deterministic schema fingerprint for tool definitions */
export function computeToolsFingerprint(tools: readonly { name: string; parameters?: unknown }[]): string {
  const normalized = tools
    .map((t) => ({
      name: t.name,
      parameters: t.parameters ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return simplePromptFingerprint(JSON.stringify(normalized));
}
