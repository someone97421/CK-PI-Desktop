import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isThemeColorScheme, resolveFontScale, type AppSettings, type PluginSummary } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { applyAppearance, resolveAppearance } from "../lib/appearance";
import { searchLaunchablePlugins } from "../lib/plugin-launcher-search";
import {
  loadPluginLaunchHistory,
  rememberPluginLaunch,
} from "../lib/plugin-launcher-history";
import { IconArrowUpRight, IconPlug, IconSearch } from "./icons";

function monogram(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "P";
}

export function PluginLauncher() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>(() =>
    loadPluginLaunchHistory().map((record) => record.id),
  );
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const results = useMemo(
    () => searchLaunchablePlugins(plugins, query, recentIds).slice(0, 7),
    [plugins, query, recentIds],
  );

  const load = useCallback(async () => {
    if (loadPromiseRef.current) {
      await loadPromiseRef.current;
      return;
    }
    setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const result = await api.listPlugins();
        setPlugins(result.plugins);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    })();
    loadPromiseRef.current = request;
    try {
      await request;
    } finally {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null;
    }
  }, []);

  const reset = useEffectEvent(() => {
    setQuery("");
    setHighlighted(0);
    setOpeningId(null);
    setError(null);
    setRecentIds(loadPluginLaunchHistory().map((record) => record.id));
    inputRef.current?.focus();
    void load();
  });

  useEffect(() => {
    let disposed = false;
    let requestId = 0;
    let settings: Partial<AppSettings> = {};
    let pendingPatch: Partial<AppSettings> = {};
    let clearAppearance = () => {};
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      if (disposed) return;
      const preference = settings.theme ?? "system";
      const resolvedTheme = isThemeColorScheme(preference)
        ? preference
        : mediaQuery.matches
          ? "light"
          : "dark";
      const root = document.documentElement;
      root.dataset.theme = resolvedTheme;
      clearAppearance();
      const appearance = resolveAppearance({ ...settings, theme: preference }, resolvedTheme);
      clearAppearance = applyAppearance(root, appearance.tokens);
      root.toggleAttribute("data-appearance-colors", appearance.colors);
      root.toggleAttribute("data-appearance-typography", appearance.typography);
      root.style.setProperty("--font-scale", String(resolveFontScale(settings)));
      mediaQuery.removeEventListener("change", applyTheme);
      if (!isThemeColorScheme(preference)) {
        mediaQuery.addEventListener("change", applyTheme);
      }
    };
    const refreshSettings = async () => {
      const currentRequest = ++requestId;
      pendingPatch = {};
      try {
        const result = await api.getSettings();
        if (disposed || currentRequest !== requestId) return;
        // Events received during this read take precedence over its snapshot.
        settings = { ...result, ...pendingPatch };
        applyTheme();
      } catch {
        if (!disposed && currentRequest === requestId) applyTheme();
      }
    };
    const onShown = () => {
      // Warm-up may precede host readiness. Ordinary settings writes are not
      // broadcast to this window, so every show must read a fresh snapshot.
      void refreshSettings();
      reset();
    };
    const offSettings = api.onSettingsChanged((patch) => {
      if (disposed) return;
      const update = patch as Partial<AppSettings>;
      pendingPatch = { ...pendingPatch, ...update };
      settings = { ...settings, ...update };
      applyTheme();
    });
    const offShown = api.onPluginLauncherShown(onShown);
    applyTheme();
    onShown();

    return () => {
      disposed = true;
      offSettings();
      offShown();
      mediaQuery.removeEventListener("change", applyTheme);
      clearAppearance();
      document.documentElement.removeAttribute("data-appearance-colors");
      document.documentElement.removeAttribute("data-appearance-typography");
      document.documentElement.style.removeProperty("--font-scale");
    };
  }, []);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    if (highlighted < results.length) return;
    setHighlighted(Math.max(0, results.length - 1));
  }, [highlighted, results.length]);

  const openPlugin = async (plugin: PluginSummary | undefined) => {
    if (!plugin || openingId) return;
    setOpeningId(plugin.id);
    setError(null);
    try {
      await api.openPluginPanel(plugin.id);
      setRecentIds(rememberPluginLaunch(plugin.id).map((record) => record.id));
      await api.dismissPluginLauncher();
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
      setOpeningId(null);
    }
  };

  const emptyText = loading
    ? t("pluginLauncher.loading")
    : query.trim()
      ? t("pluginLauncher.noResults")
      : t("pluginLauncher.empty");

  return (
    <main className="plugin-launcher" aria-label={t("pluginLauncher.title")}>
      <section className="plugin-launcher-surface">
        <div className="plugin-launcher-search-row">
          <IconSearch size={18} aria-hidden />
          <input
            ref={inputRef}
            className="plugin-launcher-input"
            value={query}
            placeholder={t("pluginLauncher.placeholder")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="plugin-launcher-results"
            aria-activedescendant={
              results[highlighted]
                ? `plugin-launcher-option-${results[highlighted].id}`
                : undefined
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                void api.dismissPluginLauncher();
                return;
              }
              if (!results.length) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setHighlighted(
                  (current) => (current + delta + results.length) % results.length,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void openPlugin(results[highlighted]);
              }
            }}
          />
          <span className="plugin-launcher-shortcut" aria-hidden>
            {window.piDesktop?.platform === "darwin" ? "⌥ Space" : "Alt + Space"}
          </span>
        </div>

        <div
          id="plugin-launcher-results"
          className="plugin-launcher-results"
          role="listbox"
        >
          {results.length ? (
            results.map((plugin, index) => (
              <button
                id={`plugin-launcher-option-${plugin.id}`}
                key={plugin.id}
                type="button"
                role="option"
                aria-selected={highlighted === index}
                className={`plugin-launcher-option${
                  highlighted === index ? " active" : ""
                }`}
                disabled={openingId !== null}
                onPointerMove={() => setHighlighted(index)}
                onClick={() => void openPlugin(plugin)}
              >
                <span className="plugin-launcher-monogram" aria-hidden>
                  {monogram(plugin.name)}
                </span>
                <span className="plugin-launcher-option-copy">
                  <strong>{plugin.name}</strong>
                  <span>{plugin.description || plugin.id}</span>
                </span>
                <IconArrowUpRight size={15} aria-hidden />
              </button>
            ))
          ) : (
            <div className="plugin-launcher-empty" role="status">
              <IconPlug size={20} aria-hidden />
              <span>{emptyText}</span>
            </div>
          )}
        </div>

        <footer className="plugin-launcher-footer">
          <span>{t("pluginLauncher.navigateHint")}</span>
          <span>{t("pluginLauncher.openHint")}</span>
          <span>{t("pluginLauncher.dismissHint")}</span>
          {error ? <strong role="alert">{error}</strong> : null}
        </footer>
      </section>
    </main>
  );
}
