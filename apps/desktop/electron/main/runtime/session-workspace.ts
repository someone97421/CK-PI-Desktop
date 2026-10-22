import type { HostProcess } from "../host-process";

export async function resolveSessionWorkspace(
  host: HostProcess,
  sessionId: string,
): Promise<{ path: string; project: boolean; isolated?: boolean; parent?: string }> {
  const { session } = await host.call<{
    session?: { projectPath?: string | null; temporaryWorkspacePath?: string | null; worktree?: unknown };
  }>("session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 });
  if (!session) throw new Error("session not found");
  if (session.worktree) {
    const location = await host.call<{ path?: string }>("worktree.location", { sessionId });
    const path = location.path?.trim();
    if (!path) throw new Error("isolated worktree location unavailable");
    const projectPath = session.projectPath?.trim();
    const parent = projectPath && !projectPath.startsWith("remote-project:") ? projectPath : undefined;
    return { path, project: true, isolated: true, ...(parent ? { parent } : {}) };
  }
  const path = session.projectPath?.trim() || session.temporaryWorkspacePath?.trim();
  if (path) return { path, project: !!session.projectPath?.trim() };
  const scratch = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
  return { path: scratch.path, project: false };
}
