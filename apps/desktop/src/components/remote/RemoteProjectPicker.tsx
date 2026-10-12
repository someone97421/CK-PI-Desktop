import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RacpProjectSummary, RemoteHostBrowseProjectsResult, RemoteHostSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Field, Input, Select } from "../ui";

export type RemoteProjectSelection = {
  hostKey: string;
  hostLabel: string;
  projectId?: string;
  label?: string;
  path?: string;
};

export function RemoteProjectPicker({ busy, onChange }: {
  busy: boolean;
  onChange: (selection: RemoteProjectSelection | null) => void;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [hostKey, setHostKey] = useState("");
  const [projects, setProjects] = useState<RacpProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<RemoteHostBrowseProjectsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const browseGeneration = useRef(0);
  const selectionCallback = useRef(onChange);
  selectionCallback.current = onChange;

  useEffect(() => {
    let active = true;
    void api.listRemoteHosts().then(({ hosts }) => {
      if (!active) return;
      const connected = hosts.filter((host) => host.connected);
      setHosts(connected);
      setHostKey(connected[0]?.hostKey ?? "");
    }).catch((error: unknown) => {
      if (active) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current++; browseGeneration.current++; };
  }, []);

  useEffect(() => {
    const request = ++generation.current;
    ++browseGeneration.current;
    setProjects([]); setProjectId(""); setPath(""); setDirectory(null); setError("");
    selectionCallback.current(null);
    if (!hostKey) return;
    setLoading(true);
    void api.remoteHostProjects(hostKey).then(({ projects }) => {
      if (request === generation.current) setProjects(projects.filter((project) => !project.archived));
    }).catch((error: unknown) => {
      if (request === generation.current) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (request === generation.current) setLoading(false); });
    void browse(undefined);
    return () => { generation.current++; browseGeneration.current++; };
  }, [hostKey]);

  useEffect(() => {
    const host = hosts.find((host) => host.hostKey === hostKey);
    const project = projects.find((project) => project.id === projectId);
    selectionCallback.current(host && (project || path.startsWith("/")) ? {
      hostKey, hostLabel: host.label,
      ...(project ? { projectId: project.id, label: project.label } : { path }),
    } : null);
  }, [hosts, hostKey, projects, projectId, path]);

  async function browse(nextPath?: string) {
    const request = ++browseGeneration.current;
    setBrowsing(true); setError("");
    try {
      const result = await api.remoteHostBrowseProjects(hostKey, nextPath);
      if (request === browseGeneration.current) setDirectory(result);
    } catch (error) {
      if (request === browseGeneration.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === browseGeneration.current) setBrowsing(false);
    }
  }

  return <section className="project-create-dialog-section remote-project-picker" aria-busy={loading || browsing}>
    <Field label={t("remote:projectHost")}>
      <Select value={hostKey} disabled={busy || loading} onChange={(event) => { generation.current++; browseGeneration.current++; selectionCallback.current(null); setHostKey(event.target.value); }}>
        {!hosts.length ? <option value="">{t("remote:noConnectedHosts")}</option> : null}
        {hosts.map((host) => <option key={host.hostKey} value={host.hostKey}>{host.label}</option>)}
      </Select>
    </Field>
    {hosts.length > 0 ? <>
      <Field label={t("remote:project")}>
        <Select value={projectId} disabled={busy || loading} onChange={(event) => { setProjectId(event.target.value); setPath(""); }}>
          <option value="">{t("remote:chooseFolder")}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </Select>
      </Field>
      <Field label={t("remote:projectFolder")}>
        <Input value={path} placeholder={t("remote:pathPlaceholder")} disabled={busy} onChange={(event) => { setPath(event.target.value); setProjectId(""); }} />
      </Field>
      {path && !path.startsWith("/") ? <p role="alert">{t("remote:REMOTE_ABSOLUTE_PATH_REQUIRED")}</p> : null}
      <div className="remote-project-browser" aria-label={t("remote:browseFolders")}>
        <div className="remote-project-browser-actions">
          <Button type="button" disabled={busy || browsing} onClick={() => void browse(path.startsWith("/") ? path : undefined)}>{t("remote:browseFolders")}</Button>
          {directory?.parent ? <Button type="button" variant="ghost" disabled={busy || browsing} onClick={() => void browse(directory.parent)}>{t("remote:parent")}</Button> : null}
        </div>
        {directory ? <>
          <div className="remote-project-browser-path">{directory.path}</div>
          <Button type="button" disabled={busy || browsing} onClick={() => { setPath(directory.path); setProjectId(""); }}>{t("remote:useFolder")}</Button>
          <div className="remote-project-browser-entries">
            {directory.entries.map((entry) => <Button key={entry.path} type="button" variant="ghost" disabled={busy || browsing} onClick={() => void browse(entry.path)}>{entry.name}</Button>)}
          </div>
          {!directory.entries.length ? <p>{t("remote:emptyFiles")}</p> : null}
        </> : null}
      </div>
      <p className="project-create-dialog-clone-hint">{t("remote:projectNameHint")}</p>
    </> : null}
    {loading || browsing ? <p role="status">{t("remote:loading")}</p> : null}
    {error ? <p className="remote-project-error" role="alert">{error}</p> : null}
  </section>;
}
