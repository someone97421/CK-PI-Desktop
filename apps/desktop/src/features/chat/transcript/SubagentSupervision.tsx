import { useChatSessionCapability } from "../../../hooks/use-chat-session-capability";
import { useSlotSessionId } from "../../../plugins/renderer-slots/use-slots";
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

/** 展示键可能包含执行 ID，控制操作始终使用原始任务 ID 和执行版本。 */
export function subagentExecutionIdentity(message?: UiMessage) {
  const payload = message ? toolResultPayload(message) : undefined;
  const details = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as { sessionId?: string; delegationId?: string; execution?: number; status?: string; collaboration?: SubagentCollaborationSnapshot }
    : {};
  const version = details.collaboration?.execution ?? details.execution;
  return {
    sessionId: details.sessionId,
    delegationId: details.delegationId,
    execution: typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? version : undefined,
    status: details.status,
    phase: details.collaboration?.phase,
  };
}

/** 子代理可在主轮结束后继续运行；旧执行只控制自身版本。 */
export function useSubagentExecution(message?: UiMessage) {
  const identity = subagentExecutionIdentity(message);
  const paneSessionId = useSlotSessionId();
  const activeSessionId = useAppStore((state) => paneSessionId || state.activeSessionId);
  const sessionId = identity.sessionId ?? activeSessionId;
  const status = useAppStore((state) => sessionId ? state.agentStatuses?.[sessionId] : undefined);
  const historical = useAppStore((state) => {
    if (!sessionId || state.activeSessionId !== sessionId || !identity.delegationId) return false;
    return (state.messages ?? []).some(candidate => {
      const current = subagentExecutionIdentity(candidate);
      if (current.delegationId !== identity.delegationId || (current.sessionId && current.sessionId !== sessionId)) return false;
      return current.execution !== undefined && identity.execution !== undefined && (
        current.execution > identity.execution ||
        (current.execution === identity.execution && (current.phase === "finished" || (current.status !== undefined && current.status !== "running")))
      );
    });
  });
  const collaboration = message ? subagentCollaboration(message) : undefined;
  const live = Boolean(sessionId && identity.delegationId && identity.execution !== undefined && !historical &&
    identity.phase !== "finished" && (identity.status === "running" || identity.phase !== undefined));
  return { ...identity, sessionId, live, parentTurnId: status?.currentTurnId, collaboration };
}

/** 原位置的宿主适配器：只提供执行上下文，内容和召回操作由插件贡献。 */
export function SubagentSupervision({ message, running, compact = false }: { message: UiMessage; running: boolean; compact?: boolean }) {
  const { i18n } = useTranslation();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const { sessionId, delegationId, execution, live, parentTurnId, collaboration } = useSubagentExecution(message);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  // 保存回执只更新任务消息时，也要重新查询插件状态。
  const context = useMemo<PluginInlineViewContext | null>(() => sessionId && delegationId ? {
    sessionId, delegationId, running, live, compact, locale,
    ...(execution !== undefined ? { execution } : {}),
    ...(parentTurnId ? { parentTurnId } : {}),
    ...(collaboration ? { collaboration } : {}),
  } : null, [message, sessionId, delegationId, running, live, compact, locale, execution, parentTurnId, collaboration]);
  return localToolsAllowed && context ? <PluginInlineSlot slot="subagent.supervision" context={context} /> : null;
}
