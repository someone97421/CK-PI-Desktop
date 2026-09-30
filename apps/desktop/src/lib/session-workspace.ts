import type { SessionSummary } from "@pi-desktop/shared";

type SessionWorkspaceLike = Pick<SessionSummary, "projectPath"> & {
  temporaryWorkspacePath?: string;
};

/** Resolve a session's effective work root without turning a temporary root into a project. */
export function sessionWorkspacePath(
  session: SessionWorkspaceLike | null | undefined,
  fallback?: string | null,
): string | null {
  const projectPath = session?.projectPath?.trim();
  if (projectPath) return projectPath;
  const temporaryPath = session?.temporaryWorkspacePath?.trim();
  if (temporaryPath) return temporaryPath;
  const fallbackPath = fallback?.trim();
  return fallbackPath || null;
}
