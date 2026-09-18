import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubagentPersistenceSettings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { CapabilityToggle } from "./AgentCapabilityLayout";
import { IconCheck, IconTrash } from "../icons";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}

export function SubagentPersistenceSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SubagentPersistenceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getSubagentPersistenceSettings()
      .then((data) => {
        if (!cancelled) {
          setSettings(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const handleToggle = async () => {
    if (!settings || toggling) return;
    const next = !settings.enabled;
    setToggling(true);
    setError(null);
    try {
      const updated = await api.setSubagentPersistenceEnabled(next);
      setSettings(updated ?? { ...settings, enabled: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  const handleClear = async () => {
    if (clearing) return;
    setClearing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.clearSubagentSnapshots();
      setMessage(t("settings.subagentPersistenceCleared", { cleared: result.cleared }));
      setConfirmingClear(false);
      const updated = await api.getSubagentPersistenceSettings();
      setSettings(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="subagent-persistence-section settings-panel" style={{ marginTop: 16 }}>
      <div className="settings-row">
        <div className="settings-row-copy">
          <div className="settings-row-title">{t("settings.subagentPersistenceTitle")}</div>
          <div className="settings-row-desc">{t("settings.subagentPersistenceDesc")}</div>
        </div>
        <div className="settings-row-control">
          <CapabilityToggle
            checked={Boolean(settings?.enabled)}
            disabled={loading || toggling || clearing || !settings}
            busy={toggling}
            label={t("settings.subagentPersistenceEnable")}
            onChange={() => void handleToggle()}
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-copy">
          <div className="settings-row-title">{t("settings.subagentPersistenceStatus")}</div>
          <div className="settings-row-desc">
            {loading ? t("chat.subagentRecallCheck") : settings?.available ? (
              <span className="text-success inline-flex items-center gap-1">
                <IconCheck size={14} aria-hidden />
                {t("settings.subagentPersistenceAvailable")}
              </span>
            ) : (
              <span className="text-warning">
                {t("settings.subagentPersistenceUnavailable", { reason: settings?.reason || error || t("chat.subagentPersistenceState.unavailable") })}
              </span>
            )}
          </div>
        </div>
      </div>

      {settings ? (
        <div className="settings-row">
          <div className="settings-row-copy">
            <div className="settings-row-title">{t("settings.subagentPersistenceQuota")}</div>
            <div className="settings-row-desc">
              {t("settings.subagentPersistenceQuotaDesc", {
                days: settings.retentionDays,
                sessions: settings.maxSessionSnapshots,
                single: formatBytes(settings.maxSnapshotBytes),
                total: formatBytes(settings.maxTotalBytes),
              })}
            </div>
          </div>
        </div>
      ) : null}

      <div className="settings-row">
        <div className="settings-row-copy">
          <div className="settings-row-title">{t("settings.subagentPersistenceClear")}</div>
          <div className="settings-row-desc">{t("settings.subagentPersistenceClearDesc")}</div>
        </div>
        <div className="settings-row-control flex items-center gap-2">
          {confirmingClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("settings.subagentPersistenceClearConfirm")}
              </span>
              <Button
                variant="secondary"
                className="text-destructive"
                disabled={clearing}
                aria-busy={clearing || undefined}
                onClick={() => void handleClear()}
              >
                <IconTrash size={14} aria-hidden />
                {t("settings.subagentPersistenceClear")}
              </Button>
              <Button
                variant="secondary"
                disabled={clearing}
                onClick={() => setConfirmingClear(false)}
              >
                {t("settings.subagentPersistenceCancel")}
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              disabled={loading || clearing || toggling || !settings}
              onClick={() => {
                setMessage(null);
                setError(null);
                setConfirmingClear(true);
              }}
            >
              <IconTrash size={14} aria-hidden />
              {t("settings.subagentPersistenceClear")}
            </Button>
          )}
        </div>
      </div>

      {message ? (
        <div className="settings-row" role="status">
          <div className="text-xs text-success">{message}</div>
        </div>
      ) : null}
      {error ? (
        <div className="settings-row" role="alert">
          <div className="text-xs text-destructive">{error}</div>
        </div>
      ) : null}
    </div>
  );
}
