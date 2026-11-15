import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectRecord, SessionSummary } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { IconFolder, IconPlus, IconRefresh } from "../../components/icons";
import { TemporaryWorkspacePicker } from "../../components/TemporaryWorkspacePicker";
import { TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";
import { groupRemoteProjectSessions } from "../../lib/remote-project-catalog";
import { normalizeProjectPath, sessionPinned } from "../../lib/sidebar-session-groups";
import { useAppStore } from "../../stores/app-store";
import { useRemoteLabels } from "./remote-labels";

type Group = { key: string; title: string; path: string | null; sessions: SessionSummary[]; create: () => Promise<void> };

function ProjectCard({ group, busy, openChat, children }: {
  group: Group; busy: boolean; openChat: (action?: () => Promise<void>) => Promise<void>; children?: ReactNode;
}) {
  const labels = useRemoteLabels();
  const { t } = useTranslation();
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const [limit, setLimit] = useState(3);
  const activeId = useAppStore((state) => state.activeSessionId);
  const sessionMeta = useAppStore((state) => state.sessionMeta);
  const pinned = group.sessions.filter((session) => sessionPinned(session, sessionMeta[session.id]));
  const regular = group.sessions.filter((session) => !sessionPinned(session, sessionMeta[session.id]));
  const visible = [...pinned, ...regular.slice(0, limit)];
  return <article className="remote-project-card">
    <div className="remote-project-card-heading">
      <button type="button" className="remote-project-heading" aria-expanded={expanded} aria-controls={id}
        onClick={() => { setExpanded(!expanded); setLimit(3); }} title={group.path ?? group.title}>
        <IconFolder size={18} aria-hidden />
        <span>{group.title}</span><span className="remote-count">{group.sessions.length}</span>
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
      </button>
      <TooltipButton type="button" className="remote-icon-button" tooltip={labels.newChat} ariaLabel={`${group.title}: ${labels.newChat}`}
        disabled={busy} onClick={() => void openChat(group.create)}><IconPlus size={18} /></TooltipButton>
    </div>
    <div id={id} hidden={!expanded}>
      {children}
      {visible.length ? <ul className="remote-session-list">{visible.map((session) => <li key={session.id}>
        <button type="button" className="remote-session" disabled={busy} aria-current={activeId === session.id ? "page" : undefined}
          onClick={() => void openChat(() => useAppStore.getState().selectSession(session.id))}>
          <span className="remote-session-title">{session.title || t("chat.untitledTask")}</span>
          {sessionPinned(session, sessionMeta[session.id]) ? <span aria-hidden>◆</span> : null}
          <span aria-hidden>›</span>
        </button>
      </li>)}</ul> : <span className="remote-empty hint">{labels.empty}</span>}
      {regular.length > limit && <button type="button" className="remote-more" onClick={() => setLimit((value) => value + 5)}>{labels.more} (+5)</button>}
    </div>
  </article>;
}

export function RemoteProjectLobby({ visible, busy, openChat }: {
  visible: boolean; busy: boolean; openChat: (action?: () => Promise<void>) => Promise<void>;
}) {
  const labels = useRemoteLabels();
  const { t } = useTranslation();
  const webRemote = document.documentElement.dataset.webRemote === "true";
  const sessions = useAppStore((state) => state.sessions);
  const openProjects = useAppStore((state) => state.openProjects);
  const projectMeta = useAppStore((state) => state.projectMeta);
  const sessionMeta = useAppStore((state) => state.sessionMeta);
  const sessionView = useAppStore((state) => state.sessionView);
  const activeId = useAppStore((state) => state.activeSessionId);
  const workspace = useAppStore((state) => state.workspace);
  const draftPath = useAppStore((state) => state.draftTemporaryWorkspacePath);
  const [remoteDirectory, setRemoteDirectory] = useState(() => !activeId && !workspace ? draftPath ?? "" : "");
  const [records, setRecords] = useState<ProjectRecord[]>([]);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (visible && !activeId && !workspace) setRemoteDirectory(draftPath ?? "");
  }, [visible, activeId, workspace, draftPath]);
  useEffect(() => {
    let canceled = false;
    void api.listProjects().then(({ projects }) => { if (!canceled) setRecords(projects); }).catch((error) => {
      if (!canceled) useAppStore.getState().showToast(String(error), { variant: "error" });
    });
    return () => { canceled = true; };
  }, [openProjects]);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const [result] = await Promise.all([api.listProjects(), useAppStore.getState().refreshSessions()]);
      setRecords(result.projects);
      useAppStore.getState().showToast(labels.refreshed);
    } catch (error) {
      useAppStore.getState().showToast(String(error), { variant: "error" });
    } finally { setRefreshing(false); }
  };
  const groups = useMemo(() => {
    const state = useAppStore.getState();
    const paths = new Map<string, string>();
    for (const project of [...openProjects, ...records]) {
      const path = normalizeProjectPath(project.path);
      if (path && !projectMeta[path]?.archived) paths.set(path, projectMeta[path]?.name || project.name || path.split(/[/\\]/).pop() || path);
    }
    for (const session of sessions) {
      if (session.source === "remote" || session.id.startsWith("remote:")) continue;
      const path = normalizeProjectPath(session.projectPath);
      if (path && !paths.has(path) && !projectMeta[path]?.archived) paths.set(path, projectMeta[path]?.name || path.split(/[/\\]/).pop() || path);
    }
    const result: Group[] = [{ key: "temporary", title: labels.temporary, path: null,
      sessions: state.getVisibleSessions({ projectPath: null }), create: () => state.newSession({ projectPath: null,
        ...(webRemote ? { temporaryWorkspacePath: remoteDirectory.trim() || undefined } : {}) }) }];
    for (const [path, title] of paths) result.push({ key: path, path, title,
      sessions: state.getVisibleSessions({ projectPath: path }), create: () => state.newSession({ projectPath: path }) });
    for (const group of groupRemoteProjectSessions(state.getVisibleSessions(), (a, b) => (b.lastUserMessageAt ?? b.createdAt ?? "").localeCompare(a.lastUserMessageAt ?? a.createdAt ?? ""))) {
      result.push({ key: `remote:${group.project.key}`, path: null, title: `${group.project.label} · ${group.project.hostLabel}`,
        sessions: group.sessions, create: () => state.newSession({ remoteProject: group.project }) });
    }
    return result;
  }, [sessions, openProjects, records, projectMeta, sessionMeta, sessionView, labels, webRemote, remoteDirectory]);
  const search = query.trim().toLocaleLowerCase();
  const filtered = groups.map((group) => ({ ...group, sessions: group.title.toLocaleLowerCase().includes(search) || group.path?.toLocaleLowerCase().includes(search)
    ? group.sessions : group.sessions.filter((session) => session.title?.toLocaleLowerCase().includes(search)) }))
    .filter((group) => group.key === "temporary" || !search || group.sessions.length || group.title.toLocaleLowerCase().includes(search) || group.path?.toLocaleLowerCase().includes(search));
  const chooseDirectory = async () => {
    if (webRemote || choosing || busy) return;
    setChoosing(true);
    try {
      const result = await api.pickProjectFolders({ single: true });
      const path = result.folders[0]?.trim();
      if (path) await openChat(() => useAppStore.getState().newSession({ projectPath: null, temporaryWorkspacePath: path }));
    } catch (error) { useAppStore.getState().showToast(String(error), { variant: "error" }); }
    finally { setChoosing(false); }
  };
  return <section className="remote-lobby" hidden={!visible} inert={!visible || busy ? true : undefined} aria-busy={busy || refreshing}>
    <header className="remote-lobby-header">
      <h1 ref={heading} tabIndex={-1}>{labels.projects}</h1>
      <TooltipButton type="button" className="remote-icon-button" tooltip={refreshing ? labels.refreshing : labels.refresh} ariaLabel={labels.refresh}
        disabled={refreshing || busy} onClick={() => void refresh()}><IconRefresh size={18} /></TooltipButton>
    </header>
    <div className="remote-lobby-search"><input type="search" value={query} placeholder={labels.search} aria-label={labels.search} onChange={(event) => setQuery(event.target.value)} /></div>
    {(activeId || useAppStore.getState().draftSessionId) && <button type="button" className="remote-continue" disabled={busy} onClick={() => void openChat()}>{labels.continueChat} ›</button>}
    <div className="remote-project-grid">
      {filtered.map((group) => <ProjectCard key={group.key} group={group} busy={busy} openChat={openChat}>
        {group.key === "temporary" && <div className="remote-temporary-actions">
          {webRemote ? <div className="remote-directory-field">
            <input type="text" value={remoteDirectory} disabled={busy} placeholder={labels.directory}
              aria-label={labels.directory} title={labels.directoryHint} autoComplete="off" autoCapitalize="none" spellCheck={false}
              onChange={(event) => setRemoteDirectory(event.target.value)} />
            <TooltipButton type="button" className="remote-icon-button" tooltip={t("chat.clearTemporaryWorkspace")}
              ariaLabel={t("chat.clearTemporaryWorkspace")} disabled={busy || !remoteDirectory} onClick={() => setRemoteDirectory("")}>×</TooltipButton>
          </div> : !activeId && !workspace ? <TemporaryWorkspacePicker path={draftPath} editable={!busy} /> :
            <TooltipButton type="button" className="remote-icon-button" tooltip={labels.chooseDirectory} ariaLabel={labels.chooseDirectory} disabled={busy || choosing}
              onClick={() => void chooseDirectory()}><IconFolder size={16} /></TooltipButton>}
        </div>}
      </ProjectCard>)}
    </div>
    {search && !filtered.some((group) => group.sessions.length) && <span className="remote-empty hint" role="status">{labels.noResults}</span>}
  </section>;
}
