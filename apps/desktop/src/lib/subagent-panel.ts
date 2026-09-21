import type { UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";
import { delegationExecutionKey } from "./tool-display";

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
