import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import type { AppState } from "../../../stores/app-store";
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
import { ModeIcon } from "./ComposerModeIcon";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  MODE_LABEL_KEYS,
  nextMode,
} from "./model";
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
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  contextUsage: ContextUsage | null;
  enhancementDraft: string;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  enhancingPrompt: boolean;
  enhancementUndoText: string | null;
  enhancePrompt: () => Promise<void>;
  undoPromptEnhancement: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
  /** 当前运行轮的开始时间（epoch 毫秒）；未知时胶囊自行以挂载时刻兜底。 */
  runStartedAt?: number;
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
}: {
  t: TFunction;
  abort: () => void;
  startedAt?: number;
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
        {formatRunElapsed(now - anchor)}
      </span>
    </TooltipButton>
  );
};

/** Composer controls: mode, permission, model, enhancement, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  pasting,
  pickAndAttach,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  contextUsage,
  enhancementDraft,
  value,
  modelReady,
  sendBlocked,
  enhancingPrompt,
  enhancementUndoText,
  enhancePrompt,
  undoPromptEnhancement,
  runActive,
  hasDraftContent,
  abort,
  submit,
  runStartedAt,
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
            disabled={controlsBlocked || pasting}
            onClick={() => {
              setPermissionOpen(false);
              void pickAndAttach();
            }}
          >
            <IconPlus size={15} aria-hidden="true" />
          </TooltipButton>
        </div>
        <TooltipButton
          type="button"
          className="icon-btn mode-chip composer-mode-chip"
          data-mode={mode}
          data-planning={planningLive ? "true" : undefined}
          tooltip={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          ariaLabel={planningLive ? t(`${mode}.planning`) : t("settings.mode")}
          disabled={controlsBlocked}
          onClick={async () => {
            modelMenu.setOpen(false);
            setPermissionOpen(false);
            const next: Mode = nextMode(mode);
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
        >
          <span className="composer-mode-chip-face" key={mode}>
            <ModeIcon mode={mode} />
            <span className="composer-mode-chip-label text-sm">
              {t(MODE_LABEL_KEYS[mode])}
            </span>
          </span>
        </TooltipButton>
        <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked} onCloseOtherMenus={() => modelMenu.setOpen(false)}
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
        <ComposerControlSlots side="left" />
      </div>

      <div className="composer-right">
        <ComposerControlSlots side="right" />
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => setPermissionOpen(false)}
        />
        <TooltipButton
          type="button"
          className={`icon-btn icon-btn-square composer-enhance-btn${enhancingPrompt ? " is-loading" : ""}`}
          tooltip={t("chat.enhancePrompt")}
          ariaLabel={enhancingPrompt ? t("chat.enhancingPrompt") : t("chat.enhancePrompt")}
          aria-busy={enhancingPrompt}
          disabled={
            !enhancementDraft.trim() ||
            enhancementDraft.trim().startsWith("/") ||
            !modelReady ||
            sendBlocked ||
            enhancingPrompt
          }
          onClick={() => void enhancePrompt()}
        >
          {enhancingPrompt ? (
            <>
              <span className="tool-spinner" aria-hidden="true" />
              <span>{t("chat.enhancingPrompt")}</span>
            </>
          ) : (
            <IconSparkles size={15} aria-hidden="true" />
          )}
        </TooltipButton>
        {enhancementUndoText !== null ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-enhance-undo"
            tooltip={t("chat.undoEnhancement")}
            ariaLabel={t("chat.undoEnhancement")}
            disabled={controlsBlocked}
            onClick={undoPromptEnhancement}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          <StopRunPill t={t} abort={() => void abort()} startedAt={runStartedAt} />
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
