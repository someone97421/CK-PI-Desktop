import type { TFunction } from "i18next";
import type { GlobalPermissionMode, Mode } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck, IconSliders } from "../../../components/icons";
import { PERMISSION_MODE_I18N_KEYS } from "../../../lib/permission-mode-labels";
import { modeDisplayLabel, userModePickerEntries } from "../../modes/mode-picker-model";
import { useModesStore } from "../../modes/modes-store";
import { ComposerUserModeItems } from "./ComposerModePicker";
import { MODE_CYCLE } from "./model";

export function ComposerRemoteOptions({
  t, open, onToggle, onClose, blocked, mode, permission,
  onMode, onPermission,
}: {
  t: TFunction;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  blocked: boolean;
  mode: Mode;
  permission: GlobalPermissionMode;
  onMode: (mode: Mode) => Promise<void>;
  onPermission: (permission: GlobalPermissionMode) => Promise<void>;
}) {
  const catalog = useModesStore((state) => state.catalog);
  const label = t("settings.title");
  const modeLabel = t("settings.mode");
  const permissionLabel = t("chat.permissionMode");
  const permissionHint = mode === "goal" ? t("goal.autoWarning")
    : mode === "plan" && permission === "auto" ? t("plan.autoWarning") : undefined;

  return (
    <AnchoredMenu
      open={open && !blocked}
      onClose={onClose}
      menuClassName="composer-permission-menu composer-remote-options"
      label={label}
      role="dialog"
      initialFocus="selected"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn icon-btn-square${open ? " active" : ""}`}
          tooltip={label}
          ariaLabel={label}
          aria-haspopup="dialog"
          aria-expanded={open && !blocked}
          disabled={blocked}
          onClick={onToggle}
        >
          <IconSliders size={15} aria-hidden="true" />
        </TooltipButton>
      )}
    >
      <div role="group" aria-label={modeLabel}>
        <div className="composer-mode-menu-group" aria-hidden="true">{modeLabel}</div>
        {MODE_CYCLE.map((candidate) => (
          <Option key={candidate} label={modeDisplayLabel(t, candidate, catalog)}
            selected={mode === candidate} onSelect={() => void onMode(candidate)} />
        ))}
        <ComposerUserModeItems t={t} mode={mode} entries={userModePickerEntries(catalog)}
          controlsBlocked={blocked} onPick={onMode} inPanel />
      </div>
      <div role="group" aria-label={permissionLabel} title={permissionHint}>
        <div className="composer-mode-menu-group" aria-hidden="true">{permissionLabel}</div>
        {(["ask", "accept-edits", "auto"] as const).map((candidate) => (
          <Option key={candidate} label={t(PERMISSION_MODE_I18N_KEYS[candidate])}
            selected={permission === candidate} disabled={mode === "goal"}
            hint={permissionHint} onSelect={() => void onPermission(candidate)} />
        ))}
      </div>
    </AnchoredMenu>
  );
}

function Option({ label, selected, disabled, hint, onSelect }: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`composer-plus-item${selected ? " active" : ""}`}
      aria-disabled={disabled || undefined}
      aria-pressed={selected}
      title={hint}
      onClick={disabled ? undefined : onSelect}
    >
      <span className="flex-1 text-left">{label}</span>
      {selected ? <IconCheck size={13} /> : null}
    </button>
  );
}
