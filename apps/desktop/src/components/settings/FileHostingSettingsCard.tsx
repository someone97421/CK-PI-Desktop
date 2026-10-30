import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LITTERBOX_EXPIRATIONS,
  normalizeFileHostingSettings,
  type AppSettings,
  type LitterboxExpiration,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsToggle } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

export function FileHostingSettingsCard({ settings }: { settings?: AppSettings }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const litterbox = normalizeFileHostingSettings(settings?.fileHosting).litterbox!;

  const save = async (patch: { enabled?: boolean; expiration?: LitterboxExpiration }) => {
    const current = useAppStore.getState().settings;
    if (!current || saving.current) return;
    saving.current = true;
    setBusy(true);
    const fileHosting = {
      ...current.fileHosting,
      litterbox: {
        ...normalizeFileHostingSettings(current.fileHosting).litterbox!,
        ...patch,
      },
    };
    try {
      await api.setSettings({ ...current, fileHosting });
      useAppStore.setState((state) => ({
        settings: state.settings ? { ...state.settings, fileHosting } : { ...current, fileHosting },
      }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <SettingsCard title={t("settings.fileHostingTitle")}>
      <SettingsRow title={t("settings.litterboxEnable")} description={t("settings.litterboxHint")}>
        <SettingsToggle
          checked={litterbox.enabled}
          label={t("settings.litterboxEnable")}
          disabled={!settings || busy}
          busy={busy}
          onChange={() => void save({ enabled: !litterbox.enabled })}
        />
      </SettingsRow>
      <SettingsRow title={t("settings.litterboxExpiration")} description={t("settings.litterboxExpirationHint")}>
        <SettingsMenuSelect
          label={t("settings.litterboxExpiration")}
          value={litterbox.expiration}
          disabled={!settings || busy}
          onChange={(value) => void save({ expiration: value as LitterboxExpiration })}
          options={LITTERBOX_EXPIRATIONS.map((expiration) => ({
            id: expiration,
            label: t(`settings.litterboxExpiration${expiration}`),
          }))}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
