import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalMcpCandidate,
  ExternalMcpImportItem,
  ExternalMcpScanResult,
  ExternalMcpSourceKind,
} from "../../../lib/api";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { externalMcpDisplayMeta } from "./import-format";
import { Badge } from "../../../components/ui";
import {
  ImportGroup,
  ImportIdle,
  ImportResults,
  ImportRow,
  ImportToolbar,
  groupBySource,
  toggleKey,
  useGroupDisclosure,
} from "../import-workbench";

const MCP_SOURCE_KEY: Record<ExternalMcpSourceKind, string> = {
  "claude-desktop": "settings.importAgentScanSourceClaudeDesktop",
  "claude-code": "settings.importAgentScanSourceClaudeCode",
  "cursor-global": "settings.importAgentScanSourceCursorGlobal",
  "cursor-project": "settings.importAgentScanSourceCursorProject",
  codex: "settings.importAgentScanSourceCodex",
  opencode: "settings.importAgentScanSourceOpenCode",
  "chatgpt-desktop": "settings.importAgentScanSourceChatgpt",
};

export function AgentMcpImportPanel({
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
  const [result, setResult] = useState<ExternalMcpScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ExternalMcpCandidate) =>
    `${candidate.source}:${candidate.id}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanExternalMcp(projectPath ? { projectPath } : undefined);
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
    const items: ExternalMcpImportItem[] = result.candidates
      .filter((candidate) => selected.has(keyOf(candidate)))
      .map((candidate) => ({
        source: candidate.source,
        sourcePath: candidate.sourcePath,
        id: candidate.id,
        rawKey: candidate.rawKey,
        label: candidate.label,
        description: candidate.description,
        transport: candidate.transport,
        command: candidate.command,
        args: candidate.args,
        env: candidate.env,
        url: candidate.url,
        headers: candidate.headers,
        disabled: candidate.disabled,
      }));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runExternalMcpImport({
        level,
        ...(level === "project" && projectPath ? { projectPath } : {}),
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
          description={t("settings.importAgentMcpDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importAgentScanFoundMcp", {
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
                  bodyId={`import-mcp-group-${groupIndex}`}
                  name={t(
                    MCP_SOURCE_KEY[group.id as ExternalMcpSourceKind] ??
                      "settings.importSourcePi",
                  )}
                  count={group.items.length}
                  countLabel={t("settings.importAgentScanFoundMcp", {
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
                        title={candidate.label || candidate.id}
                        meta={externalMcpDisplayMeta(candidate)}
                        checked={selected.has(key)}
                        onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                        badge={
                          <Badge tone="neutral">
                            {candidate.transport === "http"
                              ? t("settings.importAgentScanTransportHttp")
                              : t("settings.importAgentScanTransportStdio")}
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
