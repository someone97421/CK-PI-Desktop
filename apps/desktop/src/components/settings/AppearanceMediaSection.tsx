import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, AppearanceMediaKind } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { refreshAppearanceMedia, useAppearanceMedia } from "../../lib/appearance-media";
import { Button } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import defaultIcon from "../../assets/brand/logo-dark.png";

type Action = `${AppearanceMediaKind}:choose` | `${AppearanceMediaKind}:reset`;

export function AppearanceMediaSection({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const media = useAppearanceMedia();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<AppearanceMediaKind | null>(null);
  const [failedPreviews, setFailedPreviews] = useState<Partial<Record<AppearanceMediaKind, string>>>({});

  async function update(kind: AppearanceMediaKind, action: "choose" | "reset") {
    if (busy) return;
    setBusy(`${kind}:${action}`);
    setError(null);
    try {
      if (action === "choose") {
        const result = await api.selectAppearanceMedia(kind);
        if (!result.canceled) await refreshAppearanceMedia();
      } else {
        await api.resetAppearanceMedia(kind);
        await refreshAppearanceMedia();
      }
    } catch {
      setError(kind);
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsCard title={t("settings.customMediaTitle")}>
      {(["icon", "home"] as const).map((kind) => {
        const asset = media[kind];
        const previewFailed = !!asset && failedPreviews[kind] === asset.url;
        const onPreviewError = () => {
          if (asset) setFailedPreviews((current) => ({ ...current, [kind]: asset.url }));
        };
        const title = t(kind === "icon" ? "settings.customAppIcon" : "settings.customHomeMedia");
        return (
          <SettingsRow key={kind} title={title}
            description={t(kind === "icon" ? "settings.customAppIconDesc" : "settings.customHomeMediaDesc")}>
            <div className="appearance-media-control">
              <div className="appearance-media-preview" aria-hidden="true">
                {asset?.mimeType.startsWith("video/") && !previewFailed ? (
                  <video key={asset.url} src={asset.url} autoPlay muted loop playsInline disablePictureInPicture onError={onPreviewError} />
                ) : (
                  <img src={!previewFailed ? asset?.url ?? defaultIcon : defaultIcon} alt="" onError={onPreviewError} />
                )}
              </div>
              <div className="appearance-media-actions">
                <span className="appearance-media-name" title={asset?.originalName}>
                  {asset?.originalName ?? t("settings.customMediaDefault")}
                </span>
                <div className="appearance-media-buttons">
                  <Button variant="secondary" disabled={!!busy} onClick={() => void update(kind, "choose")}>
                    {t("settings.customMediaChoose")}
                  </Button>
                  {asset && <Button variant="secondary" disabled={!!busy} onClick={() => void update(kind, "reset")}>
                    {t("settings.customMediaReset")}
                  </Button>}
                </div>
                {(error === kind || previewFailed) && <span role="alert" className="appearance-error">{t("settings.customMediaError")}</span>}
              </div>
            </div>
          </SettingsRow>
        );
      })}
      <SettingsRow title={t("settings.customMediaSize")}>
        <div className="appearance-media-size">
          <input type="range" min={64} max={200} step={4}
            aria-label={t("settings.customMediaSize")}
            value={settings.homeMediaSize ?? 100}
            onChange={(event) => void saveSettings({ homeMediaSize: Number(event.target.value) }).catch(() => undefined)} />
          <span>{settings.homeMediaSize ?? 100} px</span>
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
