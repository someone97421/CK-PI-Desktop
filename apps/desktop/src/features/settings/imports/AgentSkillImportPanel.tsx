import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalSkillCandidate,
  ExternalSkillImportItem,
  ExternalSkillScanResult,
  ExternalSkillSourceKind,
} from "../../../lib/api";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { Badge } from "../../../components/ui";
import {
  ImportGroup,
  ImportIdle,
  ImportOption,
  ImportResults,
  ImportRow,
  ImportToolbar,
  groupBySource,
  toggleKey,
  useGroupDisclosure,
} from "../import-workbench";

const SKILL_SOURCE_KEY: Record<ExternalSkillSourceKind, string> = {
  "claude-user": "settings.importAgentScanSourceClaudeUser",
  "claude-project": "settings.importAgentScanSourceClaudeProject",
  "pi-user": "settings.importAgentScanSourcePiUser",
  "pi-project": "settings.importAgentScanSourcePiProject",
};

export function AgentSkillImportPanel({
  level,
  projectPath,
  onImported,
}: {
  level: "global" | "project";
  projectPath?: string;
  onImported: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [result, setResult] = useState<ExternalSkillScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [mode, setMode] = useState<"copy" | "link">("copy");
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ExternalSkillCandidate) =>
    `${candidate.source}:${candidate.sourcePath}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanExternalSkills(projectPath ? { projectPath } : undefined);
      setResult(res);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!result) return;
    const items: ExternalSkillImportItem[] = result.candidates
      .filter((candidate) => selected.has(keyOf(candidate)))
      .map((candidate) => ({
        source: candidate.source,
        sourcePath: candidate.sourcePath,
        shape: candidate.shape,
        rootDir: candidate.rootDir,
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
      }));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runExternalSkillsImport({
        level,
        ...(level === "project" && projectPath ? { projectPath } : {}),
        mode,
        items,
      });
      showToast(
        t("settings.importAgentScanResult", {
          imported: res.imported.length,
          skipped: res.skipped.length,
          failed: res.failed.length,
        }),
        { variant: res.failed.length > 0 ? "error" : "success" },
      );
      if (res.imported.length > 0) await onImported();
      // Refresh candidates so the imported entries are no longer selectable.
      await scan();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const groups = useMemo(() => groupBySource(result?.candidates ?? []), [result]);
  const allKeys = useMemo(
    () => (result?.candidates ?? []).map(keyOf),
    [result],
  );
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  return (
    <div className="import-workbench">
      {result === null ? (
        <ImportIdle
          description={t("settings.importAgentSkillsDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importAgentScanFoundSkills", {
              count: result.candidates.length,
            })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSelectAll")}
            onToggleAll={(on) => setSelected(on ? new Set(allKeys) : new Set())}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
            options={
              <ImportOption
                label={t("settings.importAgentScanMode")}
                value={mode}
                onChange={(id) => setMode(id as "copy" | "link")}
                hint={t("settings.importAgentScanModeHint")}
                options={[
                  { id: "copy", label: t("settings.importAgentScanModeCopy") },
                  { id: "link", label: t("settings.importAgentScanModeLink") },
                ]}
              />
            }
          />
          <ImportResults
            message={
              result.candidates.length === 0
                ? t("settings.importAgentScanNone")
                : undefined
            }
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => (
                <ImportGroup
                  key={group.id}
                  bodyId={`import-skill-group-${groupIndex}`}
                  name={t(
                    SKILL_SOURCE_KEY[group.id as ExternalSkillSourceKind] ??
                      "settings.importSourcePi",
                  )}
                  count={group.items.length}
                  countLabel={t("settings.importAgentScanFoundSkills", {
                    count: group.items.length,
                  })}
                  expanded={disclosure.isExpanded(group.id)}
                  onToggle={() => disclosure.toggle(group.id)}
                >
                  {group.items.map((candidate) => {
                    const key = keyOf(candidate);
                    return (
                      <ImportRow
                        key={key}
                        title={candidate.name || candidate.id}
                        meta={candidate.description || candidate.sourcePath}
                        checked={selected.has(key)}
                        onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                        badge={
                          <Badge tone="neutral">
                            {candidate.shape === "dir"
                              ? t("settings.importAgentScanShapeDir")
                              : t("settings.importAgentScanShapeFile")}
                          </Badge>
                        }
                      />
                    );
                  })}
                </ImportGroup>
              ))}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}
