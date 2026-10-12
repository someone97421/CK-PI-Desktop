import { useEffect, useMemo, useState } from "react";
import type { RemoteHostSummary, RacpProjectSummary } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { listRemoteProjects } from "../lib/remote-project-catalog";
import { useAppStore } from "../stores/app-store";

/** Read the Host catalog when an entry point opens; no remote paths enter local project state. */
export function useRemoteProjects(enabled: boolean) {
  const sessions = useAppStore((state) => state.sessions);
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [inventories, setInventories] = useState<{ hostKey: string; projects: RacpProjectSummary[] }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setBusy(true); setError(null);
    void (async () => {
      try {
        const result = await api.listRemoteHosts();
        const outcomes = await Promise.allSettled(result.hosts.filter((host) => host.connected).map(async (host) => ({
          hostKey: host.hostKey, projects: (await api.remoteHostProjects(host.hostKey)).projects,
        })));
        if (!live) return;
        setHosts(result.hosts);
        setInventories(outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []));
        const failed = outcomes.find((outcome) => outcome.status === "rejected");
        if (failed?.status === "rejected") setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
      } catch (caught) {
        if (live) setError(caught instanceof Error ? caught.message : String(caught));
      } finally { if (live) setBusy(false); }
    })();
    return () => { live = false; };
  }, [enabled]);
  const projects = useMemo(() => listRemoteProjects(hosts, inventories, sessions), [hosts, inventories, sessions]);
  return { projects, busy, error };
}
