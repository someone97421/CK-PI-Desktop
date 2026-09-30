import type { HostProcess } from "../host-process";

export async function resolveSessionWorkspace(
  host: HostProcess,
  sessionId: string,
): Promise<{ path: string; project: boolean }> {
  const { session } = await host.call<{
    session?: { projectPath?: string | null; temporaryWorkspacePath?: string | null };
  }>("session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 });
  if (!session) throw new Error("session not found");
  const path = session.projectPath?.trim() || session.temporaryWorkspacePath?.trim();
  if (path) return { path, project: !!session.projectPath?.trim() };
  const scratch = await host.call<{ path: string }>("session.getScratchPath", { sessionId });
  return { path: scratch.path, project: false };
}
