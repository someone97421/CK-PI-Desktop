import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  runElapsedMs,
  type RunTiming,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type SessionThinkingLevel,
  type PluginComposerTransformMeta,
} from "@pi-desktop/shared";
import type { AppState } from "../../../stores/app-store";
import { ComposerModePicker } from "./ComposerModePicker";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { ComposerControlSlots } from "./ComposerControlSlots";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconPlus,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { ComposerModelPicker } from "./ComposerModelPicker";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  modeOpen: boolean;
  setModeOpen: Dispatch<SetStateAction<boolean>>;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  localToolsAllowed?: boolean;
  attachmentsAllowed?: boolean;
  stopAllowed?: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  /** The selected model asks for OpenAI's priority tier (ADR 0334). */
  modelFastMode?: boolean;
  contextUsage: ContextUsage | null;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  composerTransforms: PluginComposerTransformMeta[];
  activeTransformKey: string | null;
  undoTransform: PluginComposerTransformMeta | null;
  runComposerTransform: (transform: PluginComposerTransformMeta) => Promise<void>;
  undoComposerTransform: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
  /** 当前运行轮的开始时间（epoch 毫秒）；未知时胶囊自行以挂载时刻兜底。 */
  runStartedAt?: number;
  runTiming?: RunTiming;
};

function formatRunElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 运行中的终止键：宽胶囊，左侧终止图标，右侧本轮运行时长。 */
function StopRunPill({
  t,
  abort,
  startedAt,
  timing,
}: {
  t: TFunction;
  abort: () => void;
  startedAt?: number;
  timing?: RunTiming;
}) {
  const [now, setNow] = useState(() => Date.now());
  const fallbackRef = useRef(startedAt ?? Date.now());
  useEffect(() => {
    fallbackRef.current = startedAt ?? Date.now();
  }, [startedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const anchor = startedAt ?? fallbackRef.current;
  return (
    <TooltipButton
      type="button"
      className="stop-btn stop-btn-pill"
      tooltip={t("chat.stopGenerating")}
      ariaLabel={t("chat.stopGenerating")}
      onClick={() => void abort()}
    >
      <IconStop size={14} />
      <span className="stop-btn-elapsed" aria-hidden="true">
        {formatRunElapsed(timing ? runElapsedMs(timing, now) : now - anchor)}
      </span>
    </TooltipButton>
  );
};

/** Composer controls: mode, permission, model, plugin actions, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  modeOpen,
  setModeOpen,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  localToolsAllowed = true,
  attachmentsAllowed = true,
  stopAllowed = true,
  pasting,
  pickAndAttach,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  modelFastMode = false,
  contextUsage,
  value,
  modelReady,
  sendBlocked,
  composerTransforms,
  activeTransformKey,
  undoTransform,
  runComposerTransform,
  undoComposerTransform,
  runActive,
  hasDraftContent,
  abort,
  submit,
  runStartedAt,
  runTiming,
}: ComposerToolbarProps) {
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square"
            tooltip={t("chat.addFiles")}
            ariaLabel={t("chat.addFiles")}
            disabled={controlsBlocked || pasting || !attachmentsAllowed}
            onClick={() => {
              setPermissionOpen(false);
              setModeOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <ComposerModePicker
          t={t}
          mode={mode}
          planningLive={planningLive}
          open={modeOpen}
          setOpen={setModeOpen}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setPermissionOpen(false);
          }}
          onSelect={async (next) => {
            try {
              await configureActiveSession({
                mode: next,
                providerId,
                modelId,
                thinkingLevel,
              });
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "error",
              });
            }
          }}
        />
        <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setModeOpen(false);
          }}
          onSelect={async (candidate) => {
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
          }} />
        {localToolsAllowed ? <ComposerControlSlots side="left" /> : null}
      </div>

      <div className="composer-right">
        {localToolsAllowed ? <ComposerControlSlots side="right" /> : null}
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          fastMode={modelFastMode}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            setPermissionOpen(false);
            setModeOpen(false);
          }}
        />
        {composerTransforms.map((transform) => {
          const key = `${transform.pluginId}/${transform.id}`;
          const isActive = activeTransformKey === key;
          return (
          <TooltipButton
            key={key}
            type="button"
            className={`icon-btn icon-btn-square composer-plugin-transform-btn${isActive ? " is-loading" : ""}`}
            tooltip={transform.title}
            ariaLabel={transform.title}
            aria-busy={isActive}
            disabled={
              !value.trim() ||
              value.trim().startsWith("/") ||
              controlsBlocked ||
              sendBlocked ||
              pasting ||
              activeTransformKey !== null
            }
            onClick={() => void runComposerTransform(transform)}
          >
            {isActive ? <span className="tool-spinner" aria-hidden="true" /> : <IconSparkles size={15} aria-hidden="true" />}
          </TooltipButton>
          );
        })}
        {undoTransform ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-plugin-transform-undo"
            tooltip={undoTransform.undoTitle}
            ariaLabel={undoTransform.undoTitle}
            disabled={controlsBlocked}
            onClick={undoComposerTransform}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          <StopRunPill t={t} abort={() => { if (stopAllowed) void abort(); }} startedAt={runStartedAt} timing={runTiming} />
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
      </div>
    </div>
  );
}
