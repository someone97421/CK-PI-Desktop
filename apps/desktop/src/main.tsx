import React from "react";
import ReactDOM from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog, resolveLocale } from "@pi-desktop/i18n";
import { remoteEn, remoteZh } from "./locales/remote";
import { MAC_TRAFFIC_LIGHT_EDGE_DIP } from "@pi-desktop/shared";
import { installScrollbarReveal } from "./lib/scrollbar-reveal";
import { initializeWebPreloadBridge } from "./lib/web-preload-bridge";
import "./styles/globals.css";

async function bootRenderer() {
  await initializeWebPreloadBridge();
  const [{ default: App }, { PluginLauncher }, { initLanguageSync, resolveOsLocale }] = await Promise.all([
    import("./App"), import("./components/PluginLauncher"), import("./lib/app-language"),
  ]);
  if (document.documentElement.dataset.webRemote === "true") {
    const { createRefreshCoordinator } = await import("./lib/refresh-coordinator");
    const refresh = createRefreshCoordinator(async () => {
      const [{ useAppStore }, { api }, { refreshRemoteSessionState }] = await Promise.all([
        import("./stores/app-store"), import("./lib/api"), import("./lib/remote-session-refresh"),
      ]);
      await refreshRemoteSessionState(useAppStore, api);
    });
    window.addEventListener("pi-desktop:remote-reconnected", () => { void refresh().catch(console.error); });
  }
  const rendererSurface = new URLSearchParams(window.location.search).get("surface");
  if (rendererSurface) document.documentElement.dataset.surface = rendererSurface;
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.platform = window.piDesktop?.platform ?? "darwin";
  if (document.documentElement.dataset.platform === "darwin") {
    document.documentElement.style.setProperty("--ds-traffic-light-edge", `${MAC_TRAFFIC_LIGHT_EDGE_DIP}px`);
  }
  installScrollbarReveal(document);

  const locale = resolveLocale(resolveOsLocale());
  const resources = Object.fromEntries(
    Object.entries(catalogs).map(([lng, catalog]) => [
      lng,
      { remote: lng === "zh-CN" ? remoteZh : remoteEn, translation: flattenCatalog(catalog as unknown as Record<string, unknown>) },
    ]),
  );
  void i18n.use(initReactI18next).init({
    lng: locale,
    fallbackLng: "en",
    resources,
    interpolation: { escapeValue: false },
  });
  initLanguageSync();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("root element missing");
  try {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        {rendererSurface === "plugin-launcher" ? <PluginLauncher /> : <App />}
      </React.StrictMode>,
    );
  } catch (error) {
    const crashCatalog = catalogs[resolveLocale(i18n.resolvedLanguage ?? i18n.language ?? locale)];
    const panel = document.createElement("div");
    panel.style.cssText = "padding:24px;font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#181818;color:#fff;height:100%";
    const heading = document.createElement("h1");
    heading.style.cssText = "margin:0 0 8px;font-size:16px";
    heading.textContent = crashCatalog.app.uiCrashed;
    const detail = document.createElement("pre");
    detail.style.cssText = "white-space:pre-wrap;color:#fca5a5";
    detail.textContent = String(error);
    panel.append(heading, detail);
    rootEl.replaceChildren(panel);
  }
}

void bootRenderer().catch((error: unknown) => {
  const root = document.getElementById("root");
  if (root) root.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
