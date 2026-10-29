import type { AgentActivity, AppSettings, UiMessage } from "@pi-desktop/shared";
import type {
  AssistantActivityItem,
  AssistantTurnEntry,
  AssistantTurnPart,
  TranscriptEntry,
} from "./assistant-turns";
import { isStandaloneRunActivity } from "./assistant-turns";
import { activityItemHasIssue } from "./activity-summary";
import type { TranscriptDisplayMode } from "./transcript-display-mode";
import { isDelegationStartTool } from "./tool-display";

type ThinkingDisplayMode = NonNullable<AppSettings["thinkingDisplayMode"]>;

export function resolveThinkingDisplayMode(value: unknown): ThinkingDisplayMode {
  return value === "compact" ? "compact" : "detailed";
}

export function isThinkingActive(message: UiMessage, active: boolean): boolean {
  return active && message.status === "streaming" && !message.content.trim();
}

export function isTurnThinking(parts: readonly AssistantTurnPart[], active: boolean): boolean {
  const latestPart = parts.at(-1);
  const latestActivity = latestPart?.kind === "activity" ? latestPart.items.at(-1) : undefined;
  return latestActivity?.kind === "thinking" && isThinkingActive(latestActivity.message, active);
}

export function processContainsMessage(parts: readonly AssistantTurnPart[], messageId: string): boolean {
  return parts.some((part) => {
    if (part.kind === "compaction") return false;
    if (part.kind === "message") return part.message.id === messageId;
    return part.items.some((item) => item.message.id === messageId || (
      item.kind === "tool" && Boolean(item.delegate?.items.some((row) => row.message.id === messageId))
    ));
  });
}

export function hasFailedProcessTool(parts: readonly AssistantTurnPart[]): boolean {
  return parts.some((part) => part.kind === "activity" && part.items.some(activityItemHasIssue));
}

/** Both legacy presentation modes expose the same process hierarchy. */
export function shouldGroupTurnProcess(mode: ThinkingDisplayMode): boolean {
  return mode === "detailed" || mode === "compact";
}

export function isLastActivityPart(parts: readonly AssistantTurnPart[], part: AssistantTurnPart): boolean {
  if (part.kind !== "activity") return false;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].kind === "activity") return parts[index] === part;
  }
  return false;
}

export function shouldAutoOpenTurnProcess(mode: ThinkingDisplayMode, isActive: boolean, hasToolFailure: boolean): boolean {
  return isActive && (mode === "detailed" || hasToolFailure);
}

export type TurnProcessRunSegment = {
  kind: "run";
  key: string;
  item: Extract<AssistantActivityItem, { kind: "tool" }>;
};
export type TurnProcessBodySegment = {
  kind: "process";
  key: string;
  parts: AssistantTurnPart[];
};
export type TurnProcessSegment = TurnProcessRunSegment | TurnProcessBodySegment;

function isDelegationGroupPart(part: Extract<AssistantTurnPart, { kind: "activity" }>): boolean {
  return part.items.some((item) => item.kind === "tool" && isDelegationStartTool(item.message.toolName));
}

function processPartKey(part: AssistantTurnPart): string {
  if (part.kind === "compaction") return part.mark.id;
  return part.kind === "activity" ? part.items[0].message.id : part.message.id;
}

/** 连续普通过程可合并，正文、压缩记录和子代理拓扑保持边界。 */
function coalesceProcessActivityParts(parts: readonly AssistantTurnPart[]): AssistantTurnPart[] {
  const result: AssistantTurnPart[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (part.kind === "activity" && previous?.kind === "activity"
      && isDelegationGroupPart(part) === isDelegationGroupPart(previous)) {
      result[result.length - 1] = { ...part, items: [...previous.items, ...part.items] };
    } else {
      result.push(part);
    }
  }
  return result;
}

/** 只在普通轮次渲染时分段，不修改缓存投影或任务抽屉中的命令。 */
export function segmentTurnProcess(parts: readonly AssistantTurnPart[], mode: TranscriptDisplayMode): TurnProcessSegment[] {
  if (parts.length === 0) return [];
  const key = processPartKey(parts[0]);
  if (mode === "fully-folded") {
    return [{ kind: "process", key, parts: coalesceProcessActivityParts(parts) }];
  }
  if (mode === "flat") return [{ kind: "process", key, parts: [...parts] }];
  const segments: TurnProcessSegment[] = [];
  let pending: AssistantTurnPart[] = [];
  const flushProcess = () => {
    if (pending.length === 0) return;
    segments.push({ kind: "process", key: processPartKey(pending[0]), parts: pending });
    pending = [];
  };
  for (const part of parts) {
    if (part.kind !== "activity" || isDelegationGroupPart(part)) {
      pending.push(part);
      continue;
    }
    // fork 的投影允许命令与其他工具共用一个活动组，按实际行切分。
    if (!part.items.some(isStandaloneRunActivity)) {
      pending.push(part);
      continue;
    }
    let items: AssistantActivityItem[] = [];
    const flushItems = () => {
      if (items.length === 0) return;
      pending.push({ ...part, items });
      items = [];
    };
    for (const item of part.items) {
      if (isStandaloneRunActivity(item)) {
        flushItems();
        flushProcess();
        segments.push({ kind: "run", key: item.message.id, item });
      } else {
        items.push(item);
      }
    }
    flushItems();
  }
  flushProcess();
  return segments;
}

export type TurnProcessPhase =
  | { kind: "failed" }
  | { kind: "stopped" }
  | { kind: "running"; phase?: AgentActivity["phase"] }
  /** Nothing is driving the turn, yet its rows never settled. */
  | { kind: "unsettled" }
  | { kind: "completed" };

/** 失败和主动停止优先于运行状态；子代理结果不等于主轮次结果。 */
export function turnProcessPhase({ parts, isActive, failed, activity }: {
  parts: readonly AssistantTurnPart[];
  isActive: boolean;
  failed: boolean;
  activity?: AgentActivity;
}): TurnProcessPhase {
  if (failed) return { kind: "failed" };
  const stopped = parts.some((part) => part.kind === "compaction" ? false
    : part.kind === "message" ? part.message.status === "aborted"
      : part.items.some((item) => item.message.status === "aborted"));
  if (stopped) return { kind: "stopped" };
  if (isActive) return { kind: "running", phase: activity?.phase };
  if (turnHasStreamingRows(parts)) return { kind: "unsettled" };
  return { kind: "completed" };
}

/** 轮次中仍有未结算的正文或活动行，压缩记录不参与状态判断。 */
export function turnHasStreamingRows(parts: readonly AssistantTurnPart[]): boolean {
  return parts.some((part) => {
    if (part.kind === "compaction") return false;
    return part.kind === "message"
      ? part.message.status === "streaming"
      : part.items.some((item) => item.message.status === "streaming");
  });
}

/** 系统更新和当前轮引导可排在运行轮次之后；普通用户消息划定新轮次边界。 */
export function liveHistoryTurnId(
  entries: readonly TranscriptEntry[],
  tailEntry?: TranscriptEntry | null,
): string | undefined {
  if (tailEntry?.kind === "assistant-turn") return undefined;
  for (let index = entries.length; index >= 0; index -= 1) {
    const entry = index === entries.length ? (tailEntry ?? undefined) : entries[index];
    if (!entry) continue;
    if (entry.kind === "assistant-turn") {
      return turnHasStreamingRows(entry.parts) ? entry.id : undefined;
    }
    if (entry.kind === "message") {
      const { message } = entry;
      if (message.role === "system") continue;
      if (message.role === "user" && message.steering) continue;
      break;
    }
  }
  return undefined;
}

/** 工具前的文字属于过程；完成任务保留连续最终正文，思考不截断正文。 */
export function projectTurnProcess(entry: AssistantTurnEntry) {
  if (entry.task) {
    const finalIndex = entry.task.status === "completed" && entry.finalMessageId
      ? entry.parts.findIndex((part) => part.kind === "message"
        && part.message.id === entry.finalMessageId)
      : -1;
    const responses: Extract<AssistantTurnPart, { kind: "message" }>[] = [];
    for (let index = finalIndex; index >= 0; index -= 1) {
      const part = entry.parts[index];
      if (part.kind === "activity") {
        if (part.items.some((item) => item.kind === "tool")) break;
      } else if (part.kind === "message") {
        if (part.message.role !== "assistant" || part.message.status !== "complete"
          || part.message.error) break;
        if (part.message.content.trim()) responses.push(part);
      }
    }
    responses.reverse();
    const responseParts = new Set<AssistantTurnPart>(responses);
    return { process: entry.parts.filter((part) => !responseParts.has(part)), responses };
  }
  const last = entry.parts.at(-1);
  const answer = last?.kind === "message" && last.message.role === "assistant" && last.message.content.trim()
    ? last : undefined;
  const process: AssistantTurnPart[] = [];
  const responses: Extract<AssistantTurnPart, { kind: "message" }>[] = [];
  for (const part of entry.parts) {
    if (part.kind === "message" && (part === answer || part.message.error)) responses.push(part);
    else process.push(part);
  }
  return { process, responses };
}

export function visibleProcessSteps(parts: readonly AssistantTurnPart[], mode: ThinkingDisplayMode, active: boolean): number {
  let count = 0;
  for (const part of parts) {
    if (part.kind === "compaction") continue;
    if (part.kind === "message") {
      if (part.message.content.trim()) count += 1;
      continue;
    }
    for (const item of part.items) {
      if (item.kind !== "thinking" || mode === "detailed" || (active && !item.message.content.trim())) count += 1;
    }
  }
  return count;
}

/** Use recorded message/tool timing for history; elapsed live time is UI-only. */
export function turnProcessTiming(parts: readonly AssistantTurnPart[]) {
  const messages = parts.flatMap((part) => {
    if (part.kind === "compaction") return [];
    return part.kind === "message" ? [part.message] : part.items.map((item) => item.message);
  });
  const starts = messages.map((message) => Date.parse(message.createdAt)).filter(Number.isFinite);
  if (starts.length === 0) return { startedAt: undefined, endedAt: undefined };
  const startedAt = Math.min(...starts);
  const endedAt = Math.max(startedAt, ...messages.map((message) => {
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isFinite(createdAt)) return startedAt;
    const duration = message.role === "tool" ? message.toolDurationMs : message.responseDurationMs;
    const recordedEnd = Date.parse(message.toolCompletedAt ?? "");
    return Number.isFinite(recordedEnd) ? recordedEnd : createdAt + (
      typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : 0
    );
  }));
  return { startedAt, endedAt };
}
