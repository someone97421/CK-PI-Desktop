/**
 * Settings ▸ Import ▸ Sessions.
 *
 * The one kind that keeps its own destination: conversations scanned from the
 * other agent tools on this machine, grouped by source or project and imported
 * back into the projects they came from. Provider, skill and MCP imports live
 * inline on their own capability pages, next to the list they add to.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImportCandidate } from "../../../lib/api";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import {
  DEFAULT_IMPORT_GROUP_BY,
  formatImportDate,
  groupImportCandidates,
  type ImportGroupBy,
} from "../../../lib/import-groups";
import { Badge } from "../../../components/ui";
import {
  ImportGroup,
  ImportIdle,
  ImportOption,
  ImportResults,
  ImportRow,
  ImportToolbar,
  toggleKey,
  useGroupDisclosure,
} from "../import-workbench";

export function SessionImportPanel() {
  const { t, i18n } = useTranslation();
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const showToast = useAppStore((s) => s.showToast);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<ImportGroupBy>(DEFAULT_IMPORT_GROUP_BY);
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [codexCap, setCodexCap] = useState<number | null>(null);

  const keyOf = (candidate: ImportCandidate) =>
    `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportSessions();
      setCandidates(res.sessions);
      setCodexCap(typeof res.truncated?.codex === "number" ? res.truncated.codex : null);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runImportSessions(items);
      await refreshSessions({ revealImportedProjects: true });
      showToast(
        t("settings.importResult", {
          imported: res.imported,
          skipped: res.skipped,
          failed: res.failed,
        }),
        { variant: res.failed > 0 ? "error" : "success" },
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const importLabels = useMemo(
    () => ({
      noProject: t("settings.importNoProject"),
      sources: {
        "claude-code": t("settings.importSourceClaudeCode"),
        opencode: t("settings.importSourceOpenCode"),
        codex: t("settings.importSourceCodex"),
        pi: t("settings.importSourcePi"),
      } as Record<ImportCandidate["source"], string>,
    }),
    [t],
  );

  const groups = useMemo(
    () => groupImportCandidates(candidates ?? [], groupBy, importLabels),
    [candidates, groupBy, importLabels],
  );

  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="import-workbench">
      {candidates === null ? (
        <ImportIdle
          note={[
            importLabels.sources["claude-code"],
            importLabels.sources.opencode,
            importLabels.sources.codex,
            importLabels.sources.pi,
          ].join(" · ")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importFound", { count: candidates.length })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
            hint={codexCap != null ? t("settings.importCodexCapped", { limit: codexCap }) : undefined}
            options={
              <ImportOption
                label={t("settings.importGroupBy")}
                value={groupBy}
                onChange={(id) => {
                  setGroupBy(id as ImportGroupBy);
                  disclosure.reset();
                }}
                options={[
                  { id: "source", label: t("settings.importGroupBySource") },
                  { id: "path", label: t("settings.importGroupByPath") },
                ]}
              />
            }
          />
          <ImportResults
            message={candidates.length === 0 ? t("settings.importNone") : undefined}
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-session-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    path={group.projectPath}
                    count={group.items.length}
                    countLabel={t("settings.importSessionCount", {
                      count: group.items.length,
                    })}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      label: t("settings.importSelectGroup", { name: group.name }),
                      checked: groupSelected === groupKeys.length,
                      indeterminate:
                        groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.title}
                          meta={`${
                            candidate.messageCount === null
                              ? t("settings.importMessagesUnknown")
                              : t("settings.importMessages", {
                                  count: candidate.messageCount,
                                })
                          } · ${formatImportDate(
                            candidate.updatedAt,
                            i18n.resolvedLanguage || i18n.language,
                          )}`}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={
                            <Badge tone="neutral">
                              {importLabels.sources[candidate.source]}
                            </Badge>
                          }
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}
