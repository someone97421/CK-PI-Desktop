export type FileMenuContext = { path: string; sessionId?: string };
export type FileMenuAction = { id: string; label: string; run: () => Promise<void> };

declare global {
  interface Window {
    __piDesktopFileMenu?: { actions: (context: FileMenuContext) => FileMenuAction[] };
    __piDesktopReadRemoteFile?: (context: FileMenuContext) => Promise<{ blob: Blob; name: string; mimeType: string; previewUrl?: string }>;
  }
}

export function remoteFileMenuActions(context: FileMenuContext): FileMenuAction[] | null {
  if (document.documentElement.dataset.webRemote !== "true" || !window.__piDesktopFileMenu) return null;
  return window.__piDesktopFileMenu.actions(context);
}
