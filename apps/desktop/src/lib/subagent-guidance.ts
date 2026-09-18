import type { SubagentGuideReceipt, UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";

/** 只识别运行时的结构化回执，不根据正文猜测消息来源。 */
export function subagentGuidance(message: UiMessage): SubagentGuideReceipt | undefined {
  if (message.toolName !== "TaskGuidance") return undefined;
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { guide?: Partial<SubagentGuideReceipt>; execution?: number };
  const guide = record.guide;
  if (!guide || typeof guide.commandId !== "string" || typeof guide.instruction !== "string"
    || typeof guide.delegationId !== "string" || !Number.isFinite(guide.receivedAt)
    || !["accepted", "applying", "applied", "cancelled", "rejected"].includes(guide.status ?? "")) return undefined;
  return { ...guide, execution: guide.execution ?? record.execution } as SubagentGuideReceipt;
}
