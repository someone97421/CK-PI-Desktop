import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PluginInlineViewContext, SubagentCollaborationSnapshot, UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "../../../lib/tool-presentation";
import { useAppStore } from "../../../stores/app-store";
import { PluginInlineSlot } from "../../../components/PluginInlineSlot";

export function subagentCollaboration(message: UiMessage): SubagentCollaborationSnapshot | undefined {
  const payload = toolResultPayload(message);
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { collaboration?: SubagentCollaborationSnapshot }).collaboration;
  return data && Number.isSafeInteger(data.reportIntervalSteps) && data.reportIntervalSteps > 0 ? data : undefined;
}

/** 用任务所属会话和轮次判断活跃性，历史卡片不能控制另一个会话的新运行。 */
export function useSubagentExecution(message: UiMessage) {
  const payload = toolResultPayload(message);
  const details = payload && typeof payload === "object" ? payload as { sessionId?: string; turnId?: string } : {};
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const sessionId = details.sessionId ?? activeSessionId;
  const sessionRunning = useAppStore((state) => sessionId ? state.runningSessions[sessionId] : false);
  const status = useAppStore((state) => sessionId ? state.agentStatuses?.[sessionId] : undefined);
  const live = Boolean(sessionRunning && (!details.turnId || !status?.currentTurnId || details.turnId === status.currentTurnId));
  const collaboration = subagentCollaboration(message);
  return { sessionId, live, parentTurnId: status?.currentTurnId, phase: collaboration?.phase, collaboration };
}

/** 原位置的宿主适配器：只提供执行上下文，内容和操作由插件贡献。 */
export function SubagentSupervision({ message, running, compact = false }: { message: UiMessage; running: boolean; compact?: boolean }) {
  const { i18n } = useTranslation();
  const { sessionId, live, parentTurnId, collaboration } = useSubagentExecution(message);
  const payload = toolResultPayload(message);
  const delegationId = payload && typeof payload === "object" ? (payload as { delegationId?: string }).delegationId : undefined;
  const execution = collaboration?.execution;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const context = useMemo<PluginInlineViewContext | null>(() => sessionId && delegationId ? {
    sessionId, delegationId, running, live, compact, locale,
    ...(execution !== undefined ? { execution } : {}),
    ...(parentTurnId ? { parentTurnId } : {}),
    ...(collaboration ? { collaboration } : {}),
  } : null, [sessionId, delegationId, running, live, compact, locale, execution, parentTurnId, collaboration]);
  return context ? <PluginInlineSlot slot="subagent.supervision" context={context} /> : null;
}
