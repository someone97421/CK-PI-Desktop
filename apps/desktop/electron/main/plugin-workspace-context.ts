import type { PluginWorkspaceInfo } from "@pi-desktop/shared";

export type PluginWorkspaceServices = {
  getWorkspacePath: () => string | null;
  getWorkspacePathForSession?: (sessionId: string) => string | null | Promise<string | null>;
  getWorkspaceInfo?: (workspacePath?: string | null) => PluginWorkspaceInfo | null;
};

/** 文件根与项目元数据共用宿主解析的会话目录。 */
export async function pluginWorkspacePath(services: PluginWorkspaceServices, sessionId?: string): Promise<string | null> {
  const scoped = sessionId ? await services.getWorkspacePathForSession?.(sessionId) : null;
  return scoped ?? services.getWorkspacePath();
}

const singleRoot = (path: string | null): PluginWorkspaceInfo | null => path
  ? { path, name: path.split(/[\\/]/).filter(Boolean).at(-1) || path }
  : null;

export async function pluginWorkspaceForCall(services: PluginWorkspaceServices, sessionId?: string): Promise<PluginWorkspaceInfo | null> {
  const scoped = sessionId ? await services.getWorkspacePathForSession?.(sessionId) : null;
  if (scoped != null) {
    const info = services.getWorkspaceInfo?.(scoped);
    return info?.path === scoped ? info : singleRoot(scoped);
  }
  const info = services.getWorkspaceInfo?.();
  return info !== undefined ? info : singleRoot(services.getWorkspacePath());
}
