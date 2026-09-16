import type { AppearanceFont, AppearanceSettings, ModeAppearance } from "./types/settings.js";

export const APPEARANCE_DEFAULT_COLORS = {
  light: { accent: "#1A1C1F", background: "#FFFFFF", foreground: "#1A1C1F" },
  dark: { accent: "#FFFFFF", background: "#181818", foreground: "#FFFFFF" },
} as const;

export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim();
  if (/^#[\da-f]{6}$/i.test(hex)) return hex.toUpperCase();
  if (/^#[\da-f]{3}$/i.test(hex)) {
    return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`.toUpperCase();
  }
  return undefined;
}

export function resetModeAppearance(value: AppearanceSettings | undefined, mode: "light" | "dark"): AppearanceSettings {
  const panel = { ...value?.[mode] };
  for (const key of ["accent", "background", "foreground", "ui", "content", "code"] as const) delete panel[key];
  return { ...value, [mode]: panel };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isAppearanceFontFamily = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 2048 && !/[;{}<>\u0000-\u001f]/.test(value);

export const isAppearanceFontWeight = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 900;

/** Validate known fields only; future optional settings survive older clients. */
export function isAppearanceSettings(value: unknown): value is AppearanceSettings {
  if (!isObject(value)) return false;
  for (const mode of ["light", "dark"] as const) {
    const panel = value[mode];
    if (panel === undefined) continue;
    if (!isObject(panel)) return false;
    for (const key of ["accent", "background", "foreground"] as const) {
      if (panel[key] !== undefined && !normalizeHexColor(panel[key])) return false;
    }
    for (const scope of ["ui", "content", "code"] as const) {
      const font = panel[scope];
      if (font === undefined) continue;
      if (!isObject(font)) return false;
      if (font.family !== undefined && !isAppearanceFontFamily(font.family)) return false;
      if (font.weight !== undefined && !isAppearanceFontWeight(font.weight)) return false;
    }
  }
  return true;
}

/** Corrupt optional fields must not prevent booting or saving unrelated settings. */
export function normalizeAppearance(value: unknown): AppearanceSettings | undefined {
  if (!isObject(value)) return undefined;
  const result: AppearanceSettings = { ...value };
  for (const mode of ["light", "dark"] as const) {
    const raw = value[mode];
    if (raw === undefined) continue;
    if (!isObject(raw)) { delete result[mode]; continue; }
    const panel: ModeAppearance = { ...raw };
    for (const key of ["accent", "background", "foreground"] as const) {
      const color = normalizeHexColor(raw[key]);
      if (color) panel[key] = color;
      else delete panel[key];
    }
    for (const scope of ["ui", "content", "code"] as const) {
      const font = raw[scope];
      if (!isObject(font)) { delete panel[scope]; continue; }
      const normalized: AppearanceFont = { ...font };
      if (isAppearanceFontFamily(font.family)) normalized.family = font.family;
      else delete normalized.family;
      if (isAppearanceFontWeight(font.weight)) normalized.weight = font.weight;
      else delete normalized.weight;
      panel[scope] = normalized;
    }
    result[mode] = panel;
  }
  return result;
}
