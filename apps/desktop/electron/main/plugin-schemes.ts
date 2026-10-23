import { protocol } from "electron";
import { GEN_UI_SCHEME_PRIVILEGES } from "./gen-ui-protocol";
import { PLUGIN_ASSET_SCHEME_PRIVILEGES } from "./plugin-asset-protocol";
import { PLUGIN_RENDERER_SCHEME_PRIVILEGES } from "./plugin-renderer-protocol";
import { APPEARANCE_MEDIA_SCHEME_PRIVILEGES } from "./appearance-media-protocol";

/**
 * 在应用就绪前，一次性注册插件、外观资源和可视化协议权限。
 *
 * Electron accepts `registerSchemesAsPrivileged` once per process: a second
 * call replaces the secure/fetch/CORS scheme lists that child processes
 * inherit, so the renderer would quietly lose the privileges of whichever
 * scheme registered first. Each protocol module owns its privileges; this is
 * the one place that registers them, together.
 */
export function registerPluginSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    PLUGIN_ASSET_SCHEME_PRIVILEGES,
    PLUGIN_RENDERER_SCHEME_PRIVILEGES,
    APPEARANCE_MEDIA_SCHEME_PRIVILEGES,
    GEN_UI_SCHEME_PRIVILEGES,
  ]);
}
