import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { resolveFontScale } from "../../../packages/shared/src/font-size.ts";
import { resetModeAppearance } from "../../../packages/shared/src/appearance.ts";

const moduleUrl = new URL("../src/lib/appearance.ts", import.meta.url);
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === moduleUrl.href) {
      if (specifier === "./fonts") return nextResolve("./fonts.ts", context);
      if (specifier === "@pi-desktop/shared") {
        return nextResolve(new URL("../../../packages/shared/src/appearance.ts", import.meta.url).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
const { appearancePalette, resolveAppearance, applyAppearance, accentForeground } =
  await import(moduleUrl.href).finally(() => resolution.deregister());

test("unconfigured themes do not introduce overrides; legacy UI fonts remain defaults", () => {
  assert.deepEqual(resolveAppearance({ theme: "dark" }, "dark").tokens, {});
  const legacy = resolveAppearance({ theme: "light", fontFamily: "Legacy, sans-serif" }, "light");
  assert.deepEqual(legacy.tokens, { "--font-sans": "Legacy, sans-serif" });
  assert.equal(legacy.background, undefined);
  assert.equal(legacy.typography, false);
});

test("system uses the resolved mode and plugin themes never inherit new settings", () => {
  const appearance = { light: { background: "#abc", ui: { weight: 500 } }, dark: { accent: "#567890" } };
  assert.equal(resolveAppearance({ theme: "system", appearance }, "light").background, "#AABBCC");
  assert.equal(resolveAppearance({ theme: "system", appearance }, "dark").tokens["--ds-accent"], "#567890");
  assert.deepEqual(resolveAppearance({ theme: "plugin:missing", appearance }, "light").tokens, {});
  assert.deepEqual(resolveAppearance({ theme: "plugin:installed", appearance, fontFamily: "Legacy" }, "dark").tokens, { "--font-sans": "Legacy" });
});

test("palette derives complete surfaces without changing semantic status colors", () => {
  const palette = appearancePalette("dark", { background: "#112233", foreground: "#EEDDCC", accent: "#ABCDEF" });
  for (const key of ["--ds-bg-primary", "--ds-bg-sidebar", "--ds-bg-hover", "--ds-text-muted", "--ds-border-default", "--accent-400", "--gray-750"]) assert.match(palette[key], /^#[a-f\d]{6}$/i);
  for (const key of ["--ds-success", "--ds-error", "--ds-warning"]) assert.equal(palette[key], undefined);
  assert.equal(palette["--ds-bg-primary"], "#112233");
  assert.equal(palette["--ds-text-primary"], "#EEDDCC");
});

test("accent and hover text both meet 4.5:1 contrast", () => {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const accent of ["#000000", "#FFFFFF", "#777777", "#FF0000", "#00FF00", "#0000FF", "#ABCDE0"]) {
    const palette = appearancePalette("light", { accent });
    assert.equal(palette["--ds-on-accent"], accentForeground(accent));
    for (const background of [accent, palette["--ds-accent-hover"]]) {
      const values = [luminance(background), luminance(palette["--ds-on-accent"])].sort((a, b) => a - b);
      assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5);
    }
  }
});

test("font scopes remain independent with legacy and monospace fallbacks", () => {
  const { tokens } = resolveAppearance({ theme: "light", fontFamily: "Legacy", appearance: { light: {
    ui: { family: "UI Face", weight: 500 }, content: { weight: 600 }, code: { family: "'Code Face', sans-serif", weight: 300 },
  } } }, "light");
  assert.match(tokens["--font-sans"], /^UI Face,/);
  assert.match(tokens["--appearance-content-font"], /^Legacy,/);
  assert.match(tokens["--font-mono"], /^'Code Face', ui-monospace,/);
  assert.equal(tokens["--appearance-ui-weight"], "500");
  assert.equal(tokens["--appearance-content-weight"], "600");
  assert.equal(tokens["--appearance-code-weight"], "300");
});

test("switch cleanup removes every owned token but leaves fontScale and plugin properties", () => {
  const values = new Map([["--font-scale", "1.25"], ["--plugin-test", "keep"]]);
  const root = { style: { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) } };
  const dark = resolveAppearance({ theme: "dark", appearance: { dark: { accent: "#123456", ui: { family: "Inter" } } } }, "dark");
  const cleanup = applyAppearance(root, dark.tokens);
  assert.equal(values.get("--ds-accent"), "#123456");
  cleanup();
  applyAppearance(root, resolveAppearance({ theme: "plugin:test" }, "light").tokens);
  assert.deepEqual([...values], [["--font-scale", "1.25"], ["--plugin-test", "keep"]]);
});

test("all eight languages declare the same appearance keys", async () => {
  let expected;
  for (const locale of ["en", "zh-CN"]) {
    const text = await readFile(new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url), "utf8");
    const keys = [...text.matchAll(/^\s+(appearance\w+):/gm)].map((match) => match[1]).sort();
    expected ??= keys;
    assert.equal(keys.length, 33);
    assert.deepEqual(keys, expected);
  }
});

test("system appearance changes update overrides and native background; cleanup detaches the listener", async () => {
  const source = await readFile(new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url), "utf8");
  const start = source.indexOf('    const preference = settings?.theme ?? "system";');
  const end = source.indexOf("  }, [settings?.theme, settings?.appearance", start);
  assert.ok(start >= 0 && end > start);
  const body = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = new Map();
  const attributes = new Set();
  const root = {
    dataset: {},
    style: { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) },
    toggleAttribute: (key, on) => on ? attributes.add(key) : attributes.delete(key),
    removeAttribute: (key) => attributes.delete(key),
  };
  let listener;
  const mq = { matches: true, addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => { listener = undefined; } };
  const calls = [];
  const effect = new Function("settings", "pluginThemes", "document", "window", "api", "resolveAppearance", "applyAppearance", "isThemeColorScheme", "PLUGIN_THEME_STYLE_ID", body);
  const cleanup = effect({ theme: "system", appearance: { light: { background: "#EEEEEE" }, dark: { background: "#111111", code: { weight: 600 } } } }, [],
    { documentElement: root, getElementById: () => null }, { matchMedia: () => mq },
    { setWindowBackgroundColor: (...args) => { calls.push(args); return Promise.resolve(); } },
    resolveAppearance, applyAppearance, (value) => ["light", "dark", "system"].includes(value), "pi-plugin-theme");
  assert.equal(root.dataset.theme, "light");
  assert.equal(values.get("--ds-bg-primary"), "#EEEEEE");
  mq.matches = false;
  listener();
  assert.equal(root.dataset.theme, "dark");
  assert.equal(values.get("--appearance-code-weight"), "600");
  assert.deepEqual(calls, [["light", "#EEEEEE"], ["dark", "#111111"]]);
  cleanup();
  assert.equal(listener, undefined);
  assert.equal(values.size, 0);
  assert.equal(attributes.size, 0);
});

test("settings page delegates saving and error subscriptions to renderer-owned state", async () => {
  const source = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /await saveSettingsPatch\(patch\)/);
  assert.match(source, /useSyncExternalStore\(subscribeSettingsSaveError, getSettingsSaveError\)/);
  assert.doesNotMatch(source, /persistedSettings|saveQueue|saveRevision/);
});

test("bold inline code keeps the code scope's relative weight for either nesting order", async () => {
  const css = await readFile(new URL("../src/styles/appearance.css", import.meta.url), "utf8");
  assert.match(css, /:is\(code, pre, \.font-mono, \.code-block-lang\)\s*\{[^}]*--font-weight-semibold:\s*min\(1000, calc\(var\(--appearance-code-weight, 400\) \+ 200\)\)/s);
  assert.match(css, /:root\[data-appearance-typography\] :is\(strong, b\)\s*\{\s*font-weight: var\(--font-weight-semibold\);/);
  assert.match(css, /:root\[data-appearance-typography\] :is\(strong, b\) code\s*\{\s*font-weight: var\(--font-weight-semibold\);/);
});

test("appearance edits merge against the latest store, not a stale rendered panel", async () => {
  const source = await readFile(new URL("../src/components/settings/AppearancePanels.tsx", import.meta.url), "utf8");
  const updateStart = source.indexOf("  const update = (");
  const updateEnd = source.indexOf("\n  };", updateStart) + "\n  };".length;
  const fontStart = source.indexOf("              const updateFont = (");
  const fontEnd = source.indexOf("\n              };", fontStart) + "\n              };".length;
  const compile = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const rendered = { theme: "system", fontFamily: "Legacy", fontScale: 1.25, appearance: {} };
  let settings = rendered;
  const writes = [];
  const store = { getState: () => ({ settings }) };
  const save = async (patch) => {
    settings = { ...settings, ...patch };
    writes.push(settings);
  };
  const update = new Function("useAppStore", "settings", "saveSettings", "resetModeAppearance", `${compile(source.slice(updateStart, updateEnd))}\nreturn update;`)(store, rendered, save, resetModeAppearance);
  const updateFont = new Function("useAppStore", "update", "mode", "scope", `${compile(source.slice(fontStart, fontEnd))}\nreturn updateFont;`)(store, update, "light", "ui");
  await update("dark", { background: "#123456" });
  await update("light", { accent: "#ABCDEF" });
  await updateFont({ family: "Inter" });
  await updateFont({ weight: 600 });
  assert.deepEqual(settings.appearance, {
    dark: { background: "#123456" },
    light: { accent: "#ABCDEF", ui: { family: "Inter", weight: 600 } },
  });
  await update("light", {}, true);
  assert.deepEqual(settings.appearance, { light: {}, dark: { background: "#123456" } });
  assert.equal(settings.fontFamily, "Legacy");
  assert.equal(settings.fontScale, 1.25);
  assert.equal(writes.length, 5);
});

test("launcher re-reads appearance on show without a broadcast and preserves read/patch race protection", async () => {
  const source = await readFile(new URL("../src/components/PluginLauncher.tsx", import.meta.url), "utf8");
  const start = source.indexOf("    let disposed = false;");
  const end = source.indexOf("  }, []);", start);
  assert.ok(start >= 0 && end > start);
  const body = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = new Map();
  const attributes = new Set();
  const root = {
    dataset: {},
    style: { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) },
    toggleAttribute: (key, on) => on ? attributes.add(key) : attributes.delete(key),
    removeAttribute: (key) => attributes.delete(key),
  };
  let onShown;
  let onSettings;
  let onSystem;
  const reads = [];
  const mq = {
    matches: true,
    addEventListener: (_, listener) => { onSystem = listener; },
    removeEventListener: () => { onSystem = undefined; },
  };
  const effect = new Function("document", "window", "api", "reset", "isThemeColorScheme", "resolveAppearance", "applyAppearance", "resolveFontScale", body);
  const cleanup = effect({ documentElement: root }, { matchMedia: () => mq }, {
    getSettings: () => new Promise((resolve) => reads.push(resolve)),
    onSettingsChanged: (listener) => { onSettings = listener; return () => { onSettings = undefined; }; },
    onPluginLauncherShown: (listener) => { onShown = listener; return () => { onShown = undefined; }; },
  }, () => {}, (value) => value === "light" || value === "dark", resolveAppearance, applyAppearance, resolveFontScale);

  onShown();
  const settings = { theme: "system", fontScale: 1.25, appearance: {
    light: { background: "#ABCDEF", ui: { family: "Inter", weight: 500 } },
    dark: { background: "#112233" },
  } };
  reads[1](settings);
  await Promise.resolve();
  reads[0]({ theme: "dark" });
  await Promise.resolve();
  assert.equal(root.dataset.theme, "light");
  assert.equal(values.get("--ds-bg-primary"), "#ABCDEF");
  assert.equal(values.get("--appearance-ui-weight"), "500");
  assert.equal(values.get("--font-scale"), "1.25");

  mq.matches = false;
  onSystem();
  assert.equal(root.dataset.theme, "dark");
  assert.equal(values.get("--ds-bg-primary"), "#112233");
  assert.equal(values.has("--appearance-ui-weight"), false);

  // A normal settings write sends no event here; the next show still picks it up.
  onShown();
  reads[2]({ theme: "light", appearance: { light: { accent: "#FEDCBA" } } });
  await Promise.resolve();
  assert.equal(values.get("--ds-accent"), "#FEDCBA");
  assert.equal(onSystem, undefined);

  // A patch during a read must beat that read's stale snapshot.
  onShown();
  onSettings({ theme: "plugin:example" });
  reads[3](settings);
  await Promise.resolve();
  assert.equal(values.has("--ds-accent"), false);
  assert.equal(attributes.has("data-appearance-colors"), false);

  onShown();
  cleanup();
  reads[4](settings);
  await Promise.resolve();
  assert.equal(values.size, 0);
  assert.equal(attributes.size, 0);
  assert.equal(onShown, undefined);
  assert.equal(onSettings, undefined);
  assert.equal(onSystem, undefined);
});
