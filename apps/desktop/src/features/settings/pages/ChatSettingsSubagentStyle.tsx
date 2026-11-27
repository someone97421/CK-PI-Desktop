import type { AppSettings } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { SettingsRow } from "../primitives";

export function ChatSettingsSubagentStyle({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return <SettingsRow title={t("settings.subagentStyle")} description={t("settings.subagentStyleDesc")}>
    <SettingsMenuSelect label={t("settings.subagentStyle")} value={settings.subagentStyle === "bar" ? "bar" : "transcript"}
      options={[
        { id: "transcript", label: t("settings.subagentStyleTranscript") },
        { id: "bar", label: t("settings.subagentStyleBar") },
      ]}
      onChange={(value) => {
        if (value === "bar" || value === "transcript") void saveSettings({ subagentStyle: value });
      }} />
  </SettingsRow>;
}
