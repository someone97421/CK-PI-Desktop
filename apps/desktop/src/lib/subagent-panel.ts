import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";
import { delegationExecutionKey } from "./tool-display";
import type { TranscriptSearchTarget } from "./transcript-reading";

/** 工作面板当前选中的子代理观测目标。 */
export type SubagentPanelSelection = {
  sessionId: string;
  /** 执行展示键；旧消息回退到 delegationId。 */
  delegationId: string;
  /** Connect an explicit search to the shared transcript reading view. */
  searchRequestId?: number;
};

export function delegationIdForMessage(message: UiMessage): string {
  const payload = toolResultPayload(message);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const delegationId = delegationExecutionKey(payload);
    if (typeof delegationId === "string" && delegationId) return delegationId;
  }
  return message.toolCallId || message.id;
}

/** 将宿主入口转换为插件视图位置，避免过期搜索影响普通任务打开。 */
export function subagentObserverLocation(selection: SubagentPanelSelection, focus?: TranscriptSearchTarget | null): string {
  const query = new URLSearchParams({ sessionId: selection.sessionId, task: selection.delegationId });
  if (focus?.sessionId === selection.sessionId && focus.requestId === selection.searchRequestId) {
    query.set("message", focus.messageId);
    query.set("query", focus.query);
    query.set("request", String(focus.requestId));
  }
  return `?${query}`;
}
