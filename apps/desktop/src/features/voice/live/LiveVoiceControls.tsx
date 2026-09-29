import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { Badge, Button, Checkbox, Panel, Select, TooltipButton } from "../../../components/ui";
import { IconMic, IconSparkles } from "../../../components/icons";
import { useAppStore } from "../../../stores/app-store";
import { getLiveCallController } from "./live-call-controller";
import { liveVoiceApi } from "./live-voice-api";
import { LiveWorkOperations } from "./LiveWorkOperations";
import "../../../styles/voice.css";

export function LiveVoiceControls({
  t,
  workSessionId,
  workSessionLabel,
}: {
  t: TFunction;
  workSessionId?: string;
  workSessionLabel?: string;
}) {
  const controller = getLiveCallController();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const selectSession = useAppStore((state) => state.selectSession);
  const createSession = useAppStore((state) => state.newSession);
  const [open, setOpen] = useState(false);
  const [selectedWorkSessionId, setSelectedWorkSessionId] = useState(workSessionId ?? "");
  const [contextEnabled, setContextEnabled] = useState(false);
  const [workActionMessage, setWorkActionMessage] = useState<string | null>(null);
  const [busyOperationId, setBusyOperationId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const call = snapshot.call;
  const isActive = Boolean(call && !["ended", "failed", "idle"].includes(call.phase));
  const enabled = snapshot.status?.enabled === true;
  const selectable = snapshot.status?.bindings.some((item) => item.selectable) === true;
  const label = isActive ? t("liveVoice.openPanel") : t("liveVoice.start");
  const localSessions = sessions.filter((session) => session.source === undefined || session.source === "desktop").slice(0, 20);
  const selectedWorkSession = localSessions.find((session) => session.id === selectedWorkSessionId);
  const selectedWorkLabel = selectedWorkSession
    ? formatSessionLabel(selectedWorkSession.projectPath, selectedWorkSession.title, t("liveVoice.untitledWorkSession"))
    : workSessionLabel || t("liveVoice.untitledWorkSession");
  const viewingSession = sessions.find((session) => session.id === activeSessionId);

  useEffect(() => {
    setSelectedWorkSessionId(workSessionId ?? "");
  }, [workSessionId]);

  useEffect(() => {
    if (!isActive) setContextEnabled(false);
  }, [isActive]);

  const openSelection = async (callId: string, selectionRef: string) => {
    const target = await liveVoiceApi.resolveWorkSelection({ callId, selectionRef });
    if (target.kind !== "session") throw new Error("The selected item is not a session");
    await selectSession(target.sessionId);
  };

  const createSessionForProject = async (callId: string, selectionRef: string) => {
    const target = await liveVoiceApi.resolveWorkSelection({ callId, selectionRef });
    if (target.kind !== "project") throw new Error("The selected item is not a project");
    await createSession({ projectPath: target.projectPath });
    const createdSessionId = useAppStore.getState().activeSessionId;
    if (!createdSessionId) throw new Error("Session creation did not select a session");
    setSelectedWorkSessionId(createdSessionId);
    setContextEnabled(false);
  };

  useEffect(() => {
    if (!open) return;
    const firstAction = panelRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    firstAction?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (snapshot.starting) setOpen(true);
  }, [snapshot.starting]);

  const closePanel = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="live-voice-control">
      <TooltipButton
        type="button"
        className={`icon-btn icon-btn-square${isActive ? " voice-active" : ""}`}
        ariaLabel={label}
        aria-pressed={isActive}
        aria-expanded={open}
        aria-haspopup="dialog"
        tooltip={label}
        ref={triggerRef}
        onClick={() => {
          if (isActive || snapshot.starting) {
            setOpen((value) => !value);
            return;
          }
          setOpen(true);
          if (enabled && selectable) void controller.start().catch(() => undefined);
        }}
      >
        <IconMic size={15} aria-hidden="true" />
      </TooltipButton>
      {workSessionId ? (
        <TooltipButton
          type="button"
          className="icon-btn icon-btn-square"
          ariaLabel={t("liveVoice.openWorkSetup")}
          aria-expanded={open}
          aria-haspopup="dialog"
          tooltip={t("liveVoice.openWorkSetup")}
          disabled={isActive || snapshot.starting}
          onClick={() => setOpen(true)}
        >
          <IconSparkles size={15} aria-hidden="true" />
        </TooltipButton>
      ) : null}
      {open ? (
        <div ref={panelRef} className="live-voice-panel" role="dialog" aria-label={t("liveVoice.title")}>
        <Panel className="live-voice-panel-surface">
          <div className="live-voice-panel-heading">
            <strong>{t("liveVoice.title")}</strong>
            <Badge aria-live="polite" aria-atomic="true" tone={call?.phase === "connected" ? "success" : snapshot.errorCode ? "error" : "neutral"}>
              {t(`liveVoice.phase.${call?.phase ?? (snapshot.starting ? "preparing" : "idle")}`)}
            </Badge>
          </div>
          {snapshot.status?.selectedBindingId ? (
            <div className="live-voice-provider">
              {snapshot.status.bindings.find((item) => item.bindingId === (call?.bindingId ?? snapshot.status?.selectedBindingId))?.providerLabel ?? t("liveVoice.providerUnavailable")}
            </div>
          ) : null}
          {call?.phase === "connected" ? (
            <div className="live-voice-provider">
              {call.userSpeaking ? t("liveVoice.userSpeaking") : call.assistantSpeaking ? t("liveVoice.assistantSpeaking") : call.muted ? t("liveVoice.muted") : t("liveVoice.phase.connected")}
            </div>
          ) : null}
          {call?.workBinding ? (
            <div className="live-voice-provider" aria-live="polite">
              {t("liveVoice.boundWorkSession", { label: call.workBinding.label || t("liveVoice.untitledWorkSession") })}
              <div>{t(call.workBinding.contextEnabled ? "liveVoice.contextShared" : "liveVoice.contextNotShared")}</div>
            </div>
          ) : null}
          {call?.workBinding && activeSessionId !== call.workBinding.workSessionId ? (
            <div className="live-voice-hint">{t("liveVoice.viewingDifferentSession", { label: viewingSession ? formatSessionLabel(viewingSession.projectPath, viewingSession.title, t("liveVoice.untitledWorkSession")) : t("liveVoice.unknownSession") })}</div>
          ) : null}
          {call?.workBinding && activeSessionId !== call.workBinding.workSessionId ? (
            <Button size="sm" variant="secondary" onClick={() => void selectSession(call.workBinding!.workSessionId).catch(() => setWorkActionMessage(t("liveVoice.sessionOpenFailed")))}>
              {t("liveVoice.viewWorkSession")}
            </Button>
          ) : null}
          {call?.workBinding?.workSessionId && call.workOperations?.length ? (
            <LiveWorkOperations
              sessionId={call.workBinding.workSessionId}
              callId={call.callId}
              operations={call.workOperations}
              t={t}
              busyOperationId={busyOperationId}
              setBusyOperationId={setBusyOperationId}
              setMessage={setWorkActionMessage}
              onOpenSelection={openSelection}
              onCreateSession={createSessionForProject}
            />
          ) : null}
          {workActionMessage ? <div className="live-voice-hint" role="status">{workActionMessage}</div> : null}
          {snapshot.errorCode ? (
            <div className="live-voice-error" role="alert">
              {t(snapshot.errorCode === "LIVE_MICROPHONE_DENIED"
                ? "liveVoice.microphoneDenied"
                : snapshot.errorCode === "LIVE_MICROPHONE_BUSY"
                  ? "liveVoice.microphoneBusy"
                  : snapshot.errorCode === "LIVE_MICROPHONE_UNAVAILABLE"
                    ? "liveVoice.microphoneUnavailable"
                    : "liveVoice.errorGeneric")}
            </div>
          ) : null}
          {call?.playbackBlocked ? (
            <Button size="sm" variant="secondary" onClick={() => void controller.resumePlayback()}>
              {t("liveVoice.resumePlayback")}
            </Button>
          ) : null}
          {snapshot.transcripts.length > 0 ? (
            <div className="live-voice-transcripts" aria-live="polite" aria-relevant="additions text">
              {snapshot.transcripts.map((segment, index) => (
                <p key={`${segment.role}:${segment.id}:${index}`} data-role={segment.role}>{segment.text}</p>
              ))}
            </div>
          ) : null}
          <div className="live-voice-actions">
            {snapshot.starting ? (
              <Button size="sm" variant="secondary" onClick={() => void controller.cancelStart()}>{t("common.cancel")}</Button>
            ) : isActive ? (
              <>
                <Button size="sm" variant="secondary" aria-pressed={call?.muted ?? true} disabled={call?.phase !== "connected"} onClick={() => void controller.toggleMute()}>
                  {call?.muted ? t("liveVoice.unmute") : t("liveVoice.mute")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void controller.end()}>{t("liveVoice.end")}</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" disabled={!enabled || !selectable} onClick={() => void controller.start().catch(() => undefined)}>
                  {t("liveVoice.start")}
                </Button>
                {workSessionId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!enabled || !selectable || !selectedWorkSessionId}
                    onClick={() => void controller.start({ workTarget: { workSessionId: selectedWorkSessionId, contextEnabled } }).catch(() => undefined)}
                  >
                    {t("liveVoice.connectWorkSession", { label: selectedWorkLabel })}
                  </Button>
                ) : null}
              </>
            )}
            <Button size="sm" variant="ghost" onClick={closePanel}>{t("common.close")}</Button>
          </div>
          {!enabled ? <div className="live-voice-hint">{t("liveVoice.enableInSettings")}</div> : null}
          {enabled && !selectable && !isActive ? <div className="live-voice-hint">{t("liveVoice.noProvider")}</div> : null}
          {!isActive && workSessionId ? (
            <div className="live-voice-work-setup">
              <label className="live-voice-field-label" htmlFor="live-voice-work-session">{t("liveVoice.selectWorkSession")}</label>
              <Select
                id="live-voice-work-session"
                value={selectedWorkSessionId}
                onChange={(event) => {
                  setSelectedWorkSessionId(event.currentTarget.value);
                  setContextEnabled(false);
                }}
                aria-label={t("liveVoice.selectWorkSession")}
              >
                {!selectedWorkSession && workSessionId ? (
                  <option value={workSessionId}>{workSessionLabel || t("liveVoice.untitledWorkSession")}</option>
                ) : null}
                {localSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {formatSessionLabel(session.projectPath, session.title, t("liveVoice.untitledWorkSession"))}
                  </option>
                ))}
              </Select>
              <Checkbox
                checked={contextEnabled}
                onChange={(event) => setContextEnabled(event.currentTarget.checked)}
                label={t("liveVoice.shareContext")}
                aria-describedby="live-voice-context-explanation"
              />
              <div id="live-voice-context-explanation" className="live-voice-hint">
                {t("liveVoice.contextConsent")}
              </div>
              <div className="live-voice-actions">
                <Button size="sm" variant="ghost" onClick={() => void (async () => {
                  setWorkActionMessage(null);
                  try {
                    await createSession();
                    const createdSessionId = useAppStore.getState().activeSessionId;
                    if (createdSessionId) {
                      setSelectedWorkSessionId(createdSessionId);
                      setContextEnabled(false);
                    }
                  } catch {
                    setWorkActionMessage(t("liveVoice.sessionCreateFailed"));
                  }
                })()}>
                  {t("liveVoice.createWorkSession")}
                </Button>
              </div>
            </div>
          ) : null}
        </Panel>
        </div>
      ) : null}
    </div>
  );
}

function formatSessionLabel(projectPath: string | undefined, title: string, untitledLabel: string): string {
  const sessionLabel = title.trim() || untitledLabel;
  const projectLabel = projectPath?.split(/[\\/]/).filter(Boolean).at(-1);
  return projectLabel ? `${projectLabel} / ${sessionLabel}` : sessionLabel;
}
