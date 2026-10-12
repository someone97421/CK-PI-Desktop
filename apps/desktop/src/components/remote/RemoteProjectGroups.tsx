import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import type { RemoteProjectEntry, RemoteProjectGroup } from "../../lib/remote-project-catalog";
import { useAppStore } from "../../stores/app-store";
import { IconFolder, IconNewProject } from "../icons";
import { Button, TooltipButton } from "../ui";

/** The same project/chat hierarchy, keyed by Host identity rather than local paths. */
export function RemoteProjectGroups({ groups, renderSessions }: {
  groups: RemoteProjectGroup[]; renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const open = async (project: RemoteProjectEntry) => {
    if (busy) return;
    setBusy(project.key);
    try { await useAppStore.getState().newSession({ remoteProject: project }); }
    catch (error) { useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { setBusy(null); }
  };
  return <>{groups.map(({ project, sessions }) => <section className="sidebar-session-group" key={project.key}>
    <div className="sidebar-session-group-header">
      <Button variant="ghost" className="sidebar-session-group-title" disabled={busy !== null}
        title={`${project.hostLabel} · ${project.label}`} onClick={() => void open(project)}>
        <IconFolder size={13} aria-hidden /><span>{project.label} · {project.hostLabel}</span>
      </Button>
      <TooltipButton tooltip={t("nav.newTask")} ariaLabel={`${t("nav.newTask")}: ${project.label} · ${project.hostLabel}`}
        disabled={busy !== null} onClick={() => void open(project)}><IconNewProject size={14} /></TooltipButton>
    </div>
    {renderSessions(sessions)}
  </section>)}</>;
}
