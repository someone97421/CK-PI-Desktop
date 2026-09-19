import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentInstructionFile } from "@pi-desktop/shared";
import { displayAppVersion } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type {
  PiSyncAction,
  PiSyncPreview,
  PiSyncStatus,
} from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useUpdateState } from "../../hooks/use-update-state";
import { Button } from "../../components/ui";
import { IconFileText } from "../../components/icons";
import { ReleaseNotesDialog } from "../../components/ReleaseNotesDialog";
import { SettingsCard, SettingsRow } from "./primitives";

export function AgentInstructionsSection() {
  const { t } = useTranslation();
  const [global, setGlobal] = useState<AgentInstructionFile | null>(null);
  const [globalDraft, setGlobalDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getAgentInstructions().then((result) => {
      if (cancelled) return;
      setGlobal(result.global);
      setGlobalDraft(result.global.content);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.saveAgentInstructions("global", globalDraft);
      setGlobal(result.file);
    } finally {
      setSaving(false);
    }
  };

  const globalDirty = global !== null && globalDraft !== global.content;
  return (
    <div className="settings-stack">
      <SettingsCard title={t("settings.instructionsGlobal")}>
        <div className="settings-form-grid">
          <div className="settings-row-copy">
            <div className="settings-row-desc">{t("settings.instructionsGlobalDesc")}</div>
            <div className="settings-instruction-path">{global?.path ?? ""}</div>
          </div>
          <textarea
            className="field-textarea settings-instruction-editor"
            value={globalDraft}
            onChange={(event) => setGlobalDraft(event.target.value)}
            aria-label={t("settings.instructionsGlobal")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <div className="settings-panel-actions">
          <Button
            variant="primary"
            disabled={!globalDirty || saving}
            onClick={() => void save()}
          >
            {saving ? t("settings.saving") : t("settings.instructionsSave")}
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}

export function UpdatesRow({ currentVersion }: { currentVersion?: string }) {
  const { t } = useTranslation();
  const update = useUpdateState();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const closeReleaseNotes = useCallback(() => setReleaseNotesOpen(false), []);
  const disabled = !update || update.mode === "disabled";
  const busy = update?.status === "checking" || update?.status === "downloading";

  let action: ReactNode;
  if (update?.status === "downloaded") {
    action = (
      <Button
        variant="primary"
        onClick={() => void api.updatesInstall().catch(() => undefined)}
      >
        {t("updates.restart")}
      </Button>
    );
  } else if (update?.status === "available" && update.mode === "manual") {
    action = (
      <Button
        variant="secondary"
        onClick={() => void api.updatesOpenReleases().catch(() => undefined)}
      >
        {t("updates.viewRelease")}
      </Button>
    );
  } else {
    action = (
      <Button
        variant="secondary"
        disabled={disabled || busy}
        onClick={() => void api.updatesCheck().catch(() => undefined)}
      >
        {busy ? t("updates.checking") : t("updates.check")}
      </Button>
    );
  }

  let statusText: string | null = null;
  if (disabled) {
    statusText = t("updates.devDisabled");
  } else {
    switch (update.status) {
      case "checking":
        statusText = t("updates.checking");
        break;
      case "up-to-date":
        statusText = t("updates.upToDate");
        break;
      case "available":
        statusText = `${t("updates.available", { version: displayAppVersion(update.availableVersion) })}${
          update.mode === "manual" ? ` ${t("updates.manualHint")}` : ""
        }`;
        break;
      case "downloading":
        statusText = t("updates.downloading", {
          percent: update.progressPercent ?? 0,
        });
        break;
      case "downloaded":
        statusText = t("updates.downloaded", {
          version: displayAppVersion(update.availableVersion),
        });
        break;
      case "error":
        statusText = t("updates.error", { message: update.error ?? "" });
        break;
      default:
        statusText = null;
    }
  }

  const notes = update?.releaseNotes?.trim() || null;
  const showNotes =
    notes &&
    (update?.status === "available" ||
      update?.status === "downloading" ||
      update?.status === "downloaded");

  return (
    <SettingsRow title={t("updates.title")} description={t("updates.desc")}>
      <div className="flex flex-col items-end gap-1.5">
        <div className="update-settings-actions">
          <Button
            variant="secondary"
            onClick={() => setReleaseNotesOpen(true)}
          >
            <IconFileText size={14} />
            {t("updates.releaseNotes")}
          </Button>
          {action}
        </div>
        {statusText ? (
          <div className="text-right text-xs-plus text-text-muted">{statusText}</div>
        ) : null}
        {showNotes ? (
          <div className="update-settings-notes">
            <div className="update-settings-notes-label">{t("updates.whatsNew")}</div>
            <pre className="update-settings-notes-body">{notes}</pre>
          </div>
        ) : null}
      </div>
      {releaseNotesOpen ? (
        <ReleaseNotesDialog
          currentVersion={update?.currentVersion ?? currentVersion}
          availableVersion={update?.availableVersion}
          onClose={closeReleaseNotes}
        />
      ) : null}
    </SettingsRow>
  );
}

/**
 * Manual pi configuration sync (ADR 0257). Import runs through the existing
 * explicit model-config scan restricted to the `pi` source; export previews
 * the merge and only writes after the user confirms.
 */
export function PiConfigSyncPanel() {
  const { t } = useTranslation();
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);
  const [status, setStatus] = useState<PiSyncStatus | null>(null);
  const [preview, setPreview] = useState<PiSyncPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.getPiSyncStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const importFromPi = async () => {
    setBusy(true);
    try {
      const scan = await api.scanImportModelConfigs();
      const items = scan.providers.filter((candidate) => candidate.source === "pi");
      if (items.length === 0) {
        showToast(t("settings.importModelsNone"), { variant: "error" });
        return;
      }
      const result = await api.runImportModelConfigs(items);
      await refreshProviders();
      showToast(
        t("settings.importResult", {
          imported: result.imported,
          skipped: result.skipped,
          failed: result.failed,
        }),
        { variant: result.failed > 0 ? "error" : "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
      await loadStatus();
    }
  };

  const previewExport = async () => {
    setBusy(true);
    try {
      setPreview(await api.previewPiExport());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const applyExport = async () => {
    setBusy(true);
    try {
      const result = await api.exportPiConfig();
      setPreview(null);
      showToast(
        t("settings.piSyncDone", {
          applied: result.applied,
          skipped: result.skipped,
        }),
        { variant: result.ok ? "success" : "error" },
      );
      await loadStatus();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const actionLabel = (action: PiSyncAction["action"]) =>
    action === "create"
      ? t("settings.piSyncActionCreate")
      : action === "update"
        ? t("settings.piSyncActionUpdate")
        : action === "removed"
          ? t("settings.piSyncActionRemoved")
          : t("settings.piSyncActionUnchanged");

  const reasonLabel = (reason?: string) =>
    reason === "oauth-not-synced"
      ? t("settings.piSyncSkipOauth")
      : reason === "unresolved-value"
        ? t("settings.piSyncSkipUnresolved")
        : reason === "duplicate-key"
          ? t("settings.piSyncSkipDuplicate")
          : (reason ?? "");

  const available = status?.available === true;
  const drifted =
    status?.files.models.drifted === true ||
    status?.files.auth.drifted === true ||
    status?.files.settings.drifted === true;

  const statusText = !status || !available
    ? t("settings.piSyncUnavailable", { dir: status?.agentDir ?? "~/.pi/agent" })
    : `${t("settings.piSyncAvailable", { dir: status.agentDir })} · ${
        status.lastSyncedAt
          ? t("settings.piSyncLastSynced", { time: status.lastSyncedAt })
          : t("settings.piSyncNeverSynced")
      }`;

  return (
    <SettingsCard title={t("settings.piSyncTitle")}>
      <SettingsRow
        title={t("settings.piSyncTitle")}
        description={t("settings.piSyncDesc")}
      >
        <div className="import-toolbar-actions">
          <Button
            variant="secondary"
            disabled={busy || !available}
            onClick={() => void importFromPi()}
          >
            {t("settings.piSyncImportAction")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !available}
            onClick={() => void previewExport()}
          >
            {t("settings.piSyncExportAction")}
          </Button>
        </div>
      </SettingsRow>
      <div className="settings-row">
        <div className="settings-row-copy">
          <div className="settings-row-desc">{statusText}</div>
          {drifted ? (
            <div className="settings-row-desc">{t("settings.piSyncDrift")}</div>
          ) : null}
        </div>
      </div>
      {preview ? (
        <div className="import-groups">
          <div className="import-group">
            <div className="import-group-header">
              <span className="import-group-name">
                {t("settings.piSyncPreviewTitle")}
              </span>
              <div className="import-toolbar-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setPreview(null)}
                >
                  {t("settings.piSyncCancel")}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void applyExport()}
                >
                  {t("settings.piSyncConfirm")}
                </Button>
              </div>
            </div>
            <div className="import-group-body">
              {preview.blockers.map((blocker) => (
                <div key={blocker} className="settings-empty">
                  {blocker}
                </div>
              ))}
              {preview.actions.length === 0 && preview.skipped.length === 0 ? (
                <div className="settings-empty">
                  {t("settings.piSyncPreviewEmpty")}
                </div>
              ) : (
                [...preview.actions, ...preview.skipped].map((action, index) => (
                  <div
                    key={`${action.kind}:${action.key}:${index}`}
                    className="import-row"
                  >
                    <span className="import-row-main">
                      <span className="import-row-title">
                        {action.key}
                        {action.name ? ` · ${action.name}` : ""}
                      </span>
                      <span className="import-row-meta">
                        {actionLabel(action.action)}
                        {action.reason ? ` · ${reasonLabel(action.reason)}` : ""}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </SettingsCard>
  );
}
