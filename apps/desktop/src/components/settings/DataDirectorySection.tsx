import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { IconFolderOpen } from "../icons";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

type DataDirectoryInfo = {
  path: string;
  overriddenByEnvironment: boolean;
};

/** 显示当前数据目录，并通过主进程选择、迁移及重启。 */
export function DataDirectorySection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DataDirectoryInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"change" | "open" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getDataDirectory()
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(describeFailure(t("settings.dataDirectoryLoadFailed"), err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const change = async () => {
    if (busy) return;
    setBusy("change");
    setError(null);
    try {
      const result = await api.changeDataDirectory();
      if (result.canceled) return;
      if (result.restarting) {
        setRestarting(true);
        return;
      }
      const next = await api.getDataDirectory();
      setInfo(next);
    } catch (err: unknown) {
      setError(describeFailure(t("settings.dataDirectoryChangeFailed"), err));
    } finally {
      setBusy(null);
    }
  };

  const open = async () => {
    if (busy) return;
    setBusy("open");
    setError(null);
    try {
      await api.openDataDirectory();
    } catch (err: unknown) {
      setError(describeFailure(t("settings.dataDirectoryOpenFailed"), err));
    } finally {
      setBusy(null);
    }
  };

  const overridden = info?.overriddenByEnvironment === true;
  const path = loading
    ? t("common.loading")
    : info?.path ?? t("settings.dataDirectoryUnavailable");

  return (
    <SettingsCard>
      <SettingsRow
        title={t("settings.dataDirectory")}
        description={t("settings.dataDirectoryDesc")}
        detail={
          <span className="font-mono text-xs-plus break-all" title={info?.path}>
            {path}
          </span>
        }
      >
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={loading || busy !== null || restarting || overridden || !info}
            aria-busy={busy === "change" || undefined}
            onClick={() => void change()}
          >
            {t("settings.dataDirectoryChange")}
          </Button>
          <Button
            variant="secondary"
            disabled={loading || busy !== null || restarting || !info}
            aria-busy={busy === "open" || undefined}
            onClick={() => void open()}
          >
            <IconFolderOpen size={14} aria-hidden />
            {t("settings.dataDirectoryOpen")}
          </Button>
        </div>
      </SettingsRow>
      {restarting ? (
        <div className="settings-row" role="status">
          <div className="settings-row-detail">{t("settings.dataDirectoryRestarting")}</div>
        </div>
      ) : null}

      {overridden ? (
        <div className="settings-row" role="status">
          <div className="settings-row-detail">
            {t("settings.dataDirectoryEnvOverride")}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="settings-row" role="alert">
          <div className="settings-row-detail text-destructive">{error}</div>
        </div>
      ) : null}
    </SettingsCard>
  );
}

function describeFailure(fallback: string, err: unknown): string {
  const detail = err instanceof Error ? err.message.trim() : String(err).trim();
  return detail ? `${fallback} ${detail}` : fallback;
}
