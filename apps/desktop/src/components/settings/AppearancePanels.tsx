import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  APPEARANCE_DEFAULT_COLORS,
  normalizeHexColor,
  resetModeAppearance,
  type AppSettings,
  type ModeAppearance,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { DEFAULT_CODE_FONT, DEFAULT_UI_FONT, readableFontFamily } from "../../lib/fonts";
import { FontFamilyRow } from "./FontFamilyRow";
import { FontWeightControl } from "./FontWeightControl";
import { Button } from "../ui";

function ColorField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(value);
  // Keep a valid shorthand editable even after its normalized value is saved.
  useEffect(() => setDraft((current) => normalizeHexColor(current) === value ? current : value), [value]);
  const valid = normalizeHexColor(draft);
  return (
    <div className="appearance-color-field">
      <label className="settings-row-title" htmlFor={id}>{label}</label>
      <div className="appearance-color-inputs">
        <input type="color" aria-label={t("settings.appearanceColorPicker", { label })}
          value={value} onChange={(event) => { setDraft(event.target.value.toUpperCase()); onChange(event.target.value.toUpperCase()); }} />
        <input id={id} type="text" className="field-input appearance-hex" value={draft}
          aria-label={`${label} HEX`} aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined}
          spellCheck={false} autoComplete="off" maxLength={7}
          onChange={(event) => {
            setDraft(event.target.value);
            const color = normalizeHexColor(event.target.value);
            if (color) onChange(color);
          }}
          onBlur={() => { if (valid) setDraft(valid); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(value);
            if (event.key === "Enter" && valid) setDraft(valid);
          }} />
      </div>
      {!valid && <span id={`${id}-error`} className="appearance-error">{t("settings.appearanceHexError")}</span>}
    </div>
  );
}

export function AppearancePanels({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [resetVersion, setResetVersion] = useState({ light: 0, dark: 0 });
  const update = (mode: "light" | "dark", patch: Partial<ModeAppearance>, reset = false) => {
    const current = useAppStore.getState().settings ?? settings;
    return saveSettings({ appearance: reset ? resetModeAppearance(current.appearance, mode) : {
      ...current.appearance,
      [mode]: { ...current.appearance?.[mode], ...patch },
    } });
  };
  const scopes = [
    ["ui", "settings.appearanceUiFont", "settings.appearanceUiDesc"],
    ["content", "settings.appearanceContentFont", "settings.appearanceContentDesc"],
    ["code", "settings.appearanceCodeFont", "settings.appearanceCodeDesc"],
  ] as const;
  return (
    <div className="appearance-panels">
      <p className="settings-row-desc">{t("settings.appearanceAutoSave")}</p>
      {(["light", "dark"] as const).map((mode) => {
        const panel = settings.appearance?.[mode] ?? {};
        const title = t(mode === "light" ? "settings.appearanceLight" : "settings.appearanceDark");
        return (
          <section key={mode} className="appearance-panel" aria-label={title}>
            <div className="appearance-panel-header">
              <h2 className="settings-card-heading">{title}</h2>
              <Button variant="secondary" aria-label={t("settings.appearanceResetMode", { mode: title })}
                onClick={() => {
                  setResetVersion((value) => ({ ...value, [mode]: value[mode] + 1 }));
                  void update(mode, {}, true).catch(() => undefined);
                }}>{t("settings.appearanceReset")}</Button>
            </div>
            <div className="appearance-colors">
              {([
                ["accent", "settings.appearanceAccent"],
                ["background", "settings.appearanceBackground"],
                ["foreground", "settings.appearanceForeground"],
              ] as const).map(([key, label]) => (
                <ColorField key={`${key}-${resetVersion[mode]}`} label={t(label)}
                  value={panel[key] ?? APPEARANCE_DEFAULT_COLORS[mode][key]}
                  onChange={(value) => { void update(mode, { [key]: value }).catch(() => undefined); }} />
              ))}
            </div>
            {scopes.map(([scope, label, description]) => {
              const font = panel[scope];
              const fallback = scope === "code" ? DEFAULT_CODE_FONT : settings.fontFamily || DEFAULT_UI_FONT;
              const defaultLabel = scope === "code" ? t("settings.appearanceDefaultMono")
                : settings.fontFamily ? t("settings.appearanceLegacyFont", { font: readableFontFamily(settings.fontFamily) })
                  : t("settings.fontSystemDefault");
              const updateFont = (patch: NonNullable<ModeAppearance[typeof scope]>) => {
                const latest = useAppStore.getState().settings?.appearance?.[mode]?.[scope];
                return update(mode, { [scope]: { ...latest, ...patch } });
              };
              return <FontFamilyRow key={scope} title={t(label)} description={t(description)}
                settings={{ fontFamily: font?.family }} defaultFamily={fallback} defaultLabel={defaultLabel}
                saveSettings={(patch) => updateFont({ family: patch.fontFamily ?? "" })}
                weightControl={<FontWeightControl key={resetVersion[mode]} family={font?.family || fallback} value={font?.weight}
                  label={t("settings.appearanceWeightLabel", { scope: t(label) })}
                  onChange={(weight) => updateFont({ weight })} />} />;
            })}
          </section>
        );
      })}
    </div>
  );
}
