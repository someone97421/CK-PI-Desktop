import { IPC, type PluginInlineViewMeta, type PluginInlineViewRequest } from "@pi-desktop/shared";
import { isPluginInlineNode } from "@pi-desktop/plugin-sdk";
import type { PluginRuntime } from "../plugin-runtime";
import type { IpcRegistrar } from "./types";

/** 内嵌内容走插件进程，宿主只公开已声明的位置和固定的渲染/操作通道。 */
export function registerPluginInlineViewIpc({
  registrar,
  plugins,
  pluginActiveInProject,
  currentWorkspacePath,
  getUpdaterLocale,
}: {
  registrar: IpcRegistrar;
  plugins: PluginRuntime;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  currentWorkspacePath: () => string | null;
  getUpdaterLocale: () => string;
}) {
  const available = (pluginId: string) => {
    const loaded = plugins.getLoaded(pluginId);
    return loaded?.permissions.has("ui.view") && loaded.permissions.has("desktop.control")
      && pluginActiveInProject(pluginId, currentWorkspacePath()) ? loaded : undefined;
  };

  registrar.handle(IPC.invoke.pluginInlineViews, async () => {
    const views: PluginInlineViewMeta[] = [];
    for (const loaded of plugins.listLoaded()) {
      const pluginId = loaded.manifest.id;
      if (!available(pluginId)) continue;
      for (const view of loaded.manifest.contributes?.inlineViews ?? []) {
        if (view.slot === "subagent.supervision") views.push({ pluginId, viewId: view.id, slot: view.slot });
      }
    }
    return views;
  });

  registrar.handle(IPC.invoke.pluginInlineView, async (request: PluginInlineViewRequest) => {
    const loaded = available(request.pluginId);
    const contribution = loaded?.manifest.contributes?.inlineViews?.find(
      (view) => view.id === request.viewId && view.slot === request.slot,
    );
    if (!loaded || !contribution) {
      if (request.action) throw new Error("Plugin inline view is unavailable");
      return null;
    }
    const context = request.context;
    if (!context || typeof context.sessionId !== "string" || !context.sessionId
      || typeof context.delegationId !== "string" || !context.delegationId
      || typeof context.running !== "boolean" || typeof context.live !== "boolean"
      || typeof context.compact !== "boolean"
      || (request.action !== undefined && (typeof request.action !== "string" || !request.action))) {
      throw new Error("Invalid inline view request");
    }
    const result = await plugins.invokePanelBridge(request.pluginId,
      request.action ? "inline.action" : "inline.render", {
        viewId: request.viewId,
        context: { ...context, locale: getUpdaterLocale() },
        ...(request.action ? { action: request.action } : {}),
      });
    // 插件停用、重载或项目切换后，旧调用的结果不能重新显示。
    if (available(request.pluginId) !== loaded) return null;
    if (!isPluginInlineNode(result)) throw new Error("Invalid plugin inline content");
    return result;
  });
}
