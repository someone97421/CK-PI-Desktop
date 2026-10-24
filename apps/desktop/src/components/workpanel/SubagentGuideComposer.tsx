import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentGuideReceipt, SubagentGuideRequest, UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { subagentGuidance } from "../../lib/subagent-guidance";
import { useChatSessionCapability } from "../../hooks/use-chat-session-capability";
import { SubagentStopButton } from "../../features/chat/transcript/SubagentStopButton";
import { IconArrowUp, IconBot } from "../icons";
import { Textarea, TooltipButton } from "../ui";

/** 仅提供当前执行的文字引导与模型展示，不承载主会话的输入选项。 */
export function SubagentGuideComposer({ sessionId, delegationId, execution, running, stopping, modelId, thinkingLevel, messages }: {
  sessionId?: string | null;
  delegationId?: string;
  execution?: number;
  running: boolean;
  stopping: boolean;
  modelId: string;
  thinkingLevel?: string;
  messages: readonly UiMessage[];
}) {
  const { t } = useTranslation();
  const localToolsAllowed = useChatSessionCapability("canUseLocalTools");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<SubagentGuideReceipt>();
  const inFlight = useRef(false);
  const composing = useRef(false);
  const retryRequest = useRef<SubagentGuideRequest | undefined>(undefined);
  const canGuide = Boolean(localToolsAllowed && running && !stopping && sessionId && delegationId && execution);
  const persistedMessage = receipt ? messages.find(message => message.id === `subagent-guide:${receipt.commandId}`) : undefined;
  const currentReceipt = (persistedMessage ? subagentGuidance(persistedMessage) : undefined) ?? receipt;

  async function sendGuidance() {
    const instruction = draft.trim();
    if (!canGuide || !sessionId || !delegationId || !execution || !instruction || inFlight.current) return;
    const previous = retryRequest.current;
    const request: SubagentGuideRequest = previous?.instruction === instruction ? previous : {
      sessionId, delegationId, expectedExecution: execution,
      commandId: `user-guide:${crypto.randomUUID()}`, instruction,
    };
    retryRequest.current = request;
    inFlight.current = true;
    setSending(true);
    setError(undefined);
    try {
      const result = await api.guideSubagent(request);
      setReceipt(result);
      retryRequest.current = undefined;
      if (result.status !== "rejected" && result.status !== "cancelled") {
        setDraft("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const placeholder = !localToolsAllowed ? t("panel.subagentGuideUnavailable")
    : canGuide ? t("panel.subagentGuidePlaceholder") : t("panel.subagentGuideInactive");
  const modelLabel = `${t("chat.model")}: ${modelId || "—"}${thinkingLevel ? ` · ${thinkingLevel}` : ""}`;

  return <footer className="subagent-transcript-composer">
    <Textarea
      rows={2}
      maxLength={12_000}
      value={draft}
      disabled={!canGuide}
      readOnly={sending}
      aria-label={t("panel.subagentGuideInput")}
      placeholder={placeholder}
      onChange={event => { setDraft(event.target.value); setError(undefined); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
        event.preventDefault();
        event.stopPropagation();
        void sendGuidance();
      }}
    />
    <div className="subagent-transcript-composer-controls">
      <div className="subagent-transcript-model" title={modelLabel} aria-label={modelLabel}>
        <IconBot size={14} aria-hidden />
        <span className="subagent-transcript-model-name">{modelId || "—"}</span>
        {thinkingLevel ? <span className="subagent-transcript-thinking">{thinkingLevel}</span> : null}
      </div>
      <SubagentStopButton sessionId={sessionId} delegationId={delegationId} execution={execution} running={running} compact />
      <TooltipButton
        type="button"
        className="send-btn subagent-transcript-send"
        tooltip={t(sending ? "panel.subagentGuideSending" : "panel.subagentGuideSend")}
        disabled={!canGuide || sending || !draft.trim()}
        aria-busy={sending}
        onClick={() => { void sendGuidance(); }}
      ><IconArrowUp size={15} /></TooltipButton>
    </div>
    {error ? <p className="subagent-transcript-feedback is-error" role="alert">
      {t("panel.subagentGuideFailed", { reason: error })}
    </p> : sending ? <p className="subagent-transcript-feedback" role="status">{t("panel.subagentGuideSending")}</p>
      : currentReceipt ? <p className={`subagent-transcript-feedback${currentReceipt.status === "rejected" || currentReceipt.status === "cancelled" ? " is-error" : ""}`} role="status">
        {t(`chat.subagentGuideState.${currentReceipt.status}`)}
        {currentReceipt.reason ? ` · ${currentReceipt.reason}` : ""}
      </p> : null}
  </footer>;
}
