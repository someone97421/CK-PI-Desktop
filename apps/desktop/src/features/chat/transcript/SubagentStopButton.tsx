import { useEffect } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Button, TooltipButton } from "../../../components/ui";
import { IconStop } from "../../../components/icons";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";

// 各入口共享请求状态；等待回执属于具体会话中的具体执行。
const useStops = create<{
  busy: Record<string, string[] | undefined>;
  pending: Record<string, boolean | undefined>;
}>(() => ({ busy: {}, pending: {} }));

function executionKey(sessionId: string, delegationId: string, execution: number) {
  return JSON.stringify([sessionId, delegationId, execution]);
}

export function SubagentStopButton({
  sessionId,
  delegationId,
  execution,
  expectedExecutions,
  running,
  name,
  compact = false,
}: {
  sessionId?: string | null;
  delegationId?: string;
  execution?: number;
  expectedExecutions?: Record<string, number>;
  running: boolean;
  name?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const source = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.source);
  const executions: Record<string, number> = delegationId && execution !== undefined
    ? { [delegationId]: execution }
    : delegationId ? {} : expectedExecutions ?? {};
  const ids = Object.keys(executions).filter(id => Number.isSafeInteger(executions[id]) && executions[id] > 0);
  const keys = sessionId ? ids.map(id => executionKey(sessionId, id, executions[id])) : [];
  const busy = useStops(state => sessionId ? state.busy[sessionId] : undefined);
  const stopping = useStops(state => keys.some(key => state.pending[key]));
  const stoppingRequest = busy?.some(key => keys.includes(key));
  const keysIdentity = JSON.stringify(keys);
  useEffect(() => {
    if (running || !stopping) return;
    const settledKeys = JSON.parse(keysIdentity) as string[];
    useStops.setState(state => {
      const pending = { ...state.pending };
      for (const key of settledKeys) delete pending[key];
      return { pending };
    });
  }, [running, stopping, keysIdentity]);
  if (!running || !sessionId || ids.length === 0 || source === "remote" || source === "pi-native") return null;

  const stop = async () => {
    const state = useStops.getState();
    if (state.busy[sessionId] || keys.some(key => state.pending[key])) return;
    useStops.setState(state => ({ busy: { ...state.busy, [sessionId]: keys } }));
    try {
      const result = await api.stopSubagents({
        sessionId,
        delegationIds: ids,
        expectedExecutions: Object.fromEntries(ids.map(id => [id, executions[id]])),
      });
      useStops.setState(state => {
        const pending = { ...state.pending };
        for (const id of result.pending) {
          if (ids.includes(id)) pending[executionKey(sessionId, id, executions[id])] = true;
        }
        return { pending };
      });
    } catch (error) {
      useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      useStops.setState(state => {
        const busy = { ...state.busy };
        delete busy[sessionId];
        return { busy };
      });
    }
  };
  const label = stoppingRequest || stopping
    ? t("chat.stoppingSubagents")
    : delegationId
      ? t("chat.stopSubagentNamed", { name: name ?? t("chat.subagentUnnamed") })
      : t("chat.stopAllSubagents");
  if (compact) {
    return (
      <TooltipButton
        type="button"
        className="stop-btn"
        tooltip={label}
        ariaLabel={label}
        disabled={!!busy || stopping}
        onClick={() => void stop()}
      >
        {stoppingRequest || stopping ? <span className="tool-spinner" aria-hidden /> : <IconStop size={13} />}
      </TooltipButton>
    );
  }
  return (
    <Button
      className="subagent-stop-button"
      variant="secondary"
      size="sm"
      title={label}
      aria-label={label}
      disabled={!!busy || stopping}
      onClick={() => void stop()}
    >
      {stoppingRequest || stopping ? <span className="tool-spinner" aria-hidden /> : <IconStop size={9} />}
      <span>{stoppingRequest || stopping
        ? t("chat.stoppingSubagents")
        : t(delegationId ? "chat.stopSubagent" : "chat.stopAllSubagentsShort")}</span>
    </Button>
  );
}
