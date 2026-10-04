import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, AppearanceMediaKind } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { refreshAppearanceMedia, useAppearanceMedia } from "../../lib/appearance-media";
import { Button } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import defaultIcon from "../../assets/brand/logo-dark.png";

type Action = `${AppearanceMediaKind}:choose` | `${AppearanceMediaKind}:reset` | "icon:apply";

export function AppearanceMediaSection({ settings, saveSettings }: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const media = useAppearanceMedia();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<AppearanceMediaKind | null>(null);
  const [systemIcon, setSystemIcon] = useState<{ supported: boolean; pending: boolean; message?: string } | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [failedPreviews, setFailedPreviews] = useState<Partial<Record<AppearanceMediaKind, string>>>({});

  useEffect(() => {
    if (window.piDesktop?.platform !== "win32") return;
    let disposed = false;
    void api.getAppearanceSystemIcon().then((state) => {
      if (!disposed) setSystemIcon(state);
    }).catch((error: unknown) => {
      if (!disposed) setSystemError(String(error));
    });
    return () => { disposed = true; };
  }, [media.icon?.url]);

  async function update(kind: AppearanceMediaKind, action: "choose" | "reset") {
    if (busy) return;
    setBusy(`${kind}:${action}`);
    setError(null);
    if (kind === "icon") setSystemError(null);
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

  async function applySystemIcon() {
    if (busy) return;
    setBusy("icon:apply");
    setSystemError(null);
    try {
      await api.applyAppearanceSystemIcon();
    } catch (error) {
      setSystemError(error instanceof Error ? error.message : String(error));
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
        const description = kind === "icon"
          ? systemIcon?.supported ? "settings.customAppIconSystemDesc" : "settings.customAppIconDesc"
          : "settings.customHomeMediaDesc";
        return (
          <SettingsRow key={kind} title={title} description={t(description)}>
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
                  {kind === "icon" && systemIcon?.supported && (
                    <Button variant="secondary" disabled={!!busy || (!systemIcon.pending && !systemIcon.message && !systemError)} onClick={() => void applySystemIcon()}>
                      {t(busy === "icon:apply" ? "settings.customAppIconApplying" : "settings.customAppIconApply")}
                    </Button>
                  )}
                </div>
                {kind === "icon" && systemIcon?.supported && (
                  <span className="appearance-media-name" role="status">
                    {t(systemIcon.pending ? "settings.customAppIconPending" : "settings.customAppIconApplied")}
                  </span>
                )}
                {kind === "icon" && (systemError || systemIcon?.message) && (
                  <span role="alert" className="appearance-error">{systemError || systemIcon?.message}</span>
                )}
                {(error === kind || previewFailed) && <span role="alert" className="appearance-error">{t("settings.customMediaError")}</span>}
              </div>
            </div>
          </SettingsRow>
        );
      })}
      <SettingsRow title={t("settings.customMediaSize")}>
        <div className="appearance-media-size">
          <input type="range" min={64} max={500} step={4}
            aria-label={t("settings.customMediaSize")}
            value={settings.homeMediaSize ?? 256}
            onChange={(event) => void saveSettings({ homeMediaSize: Number(event.target.value) }).catch(() => undefined)} />
          <span>{settings.homeMediaSize ?? 256} px</span>
        </div>
      </SettingsRow>
    </SettingsCard>
  );
}
