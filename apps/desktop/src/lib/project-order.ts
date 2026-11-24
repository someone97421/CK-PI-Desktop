import type { SessionSummary } from "@pi-desktop/shared";
import type { ProjectSort } from "./sidebar-preferences";

/**
 * One sidebar project group, flattened to the fields that decide its order.
 *
 * Local project groups and host-owned remote groups both sort through this, so
 * a remote group cannot drift up or down the list just because its sessions
 * arrived in a different array order from the host.
 */
export type ProjectOrderInput = {
  /** Stable identity; the last tie-break, so equal groups never swap places. */
  key: string;
  name: string;
  sessions: readonly Pick<SessionSummary, "createdAt" | "updatedAt">[];
  archived?: boolean;
  pinned?: boolean;
  /** Manual position. Only consulted for the `manual` sort. */
  manualOrder?: number | null;
  /** Local projects supply their own dates; remote groups fall back to session dates. */
  createdAt?: number | null;
  recentAt?: number | null;
};

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstSessionDate(
  sessions: ProjectOrderInput["sessions"],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions
    .map((session) => timestamp(session[field]))
    .filter((value) => value > 0);
  return values.length ? Math.min(...values) : null;
}

function lastSessionDate(
  sessions: ProjectOrderInput["sessions"],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions
    .map((session) => timestamp(session[field]))
    .filter((value) => value > 0);
  return values.length ? Math.max(...values) : null;
}

function compareOptionalDate(
  a: number | null,
  b: number | null,
  descending: boolean,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/**
 * Sidebar project order for a given sort mode.
 *
 * Archive and pin buckets take precedence. Manual order uses saved positions.
 * Date sorts use project dates when supplied and session dates otherwise.
 */
export function compareProjectGroups(
  a: ProjectOrderInput,
  b: ProjectOrderInput,
  sort: ProjectSort,
): number {
  const archiveOrder = Number(!!a.archived) - Number(!!b.archived);
  if (archiveOrder !== 0) return archiveOrder;
  const pinOrder = Number(!!b.pinned) - Number(!!a.pinned);
  if (pinOrder !== 0) return pinOrder;
  if (sort === "manual") {
    const byOrder =
      (a.manualOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.manualOrder ?? Number.MAX_SAFE_INTEGER);
    if (byOrder !== 0) return byOrder;
  } else if (sort === "name") {
    const byName = a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
    });
    if (byName !== 0) return byName;
  } else if (sort === "oldest" || sort === "created") {
    const createdAt = (group: ProjectOrderInput) => {
      if (sort === "oldest") return firstSessionDate(group.sessions, "createdAt");
      return group.createdAt === undefined
        ? lastSessionDate(group.sessions, "createdAt")
        : group.createdAt;
    };
    const byCreated = compareOptionalDate(createdAt(a), createdAt(b), sort === "created");
    if (byCreated !== 0) return byCreated;
  } else {
    const recentAt = (group: ProjectOrderInput) =>
      group.recentAt === undefined
        ? lastSessionDate(group.sessions, "updatedAt")
        : group.recentAt;
    const byRecent = compareOptionalDate(recentAt(a), recentAt(b), true);
    if (byRecent !== 0) return byRecent;
  }
  return a.key.localeCompare(b.key);
}
