import {
  APPEARANCE_CONTRAST_DEFAULT,
  APPEARANCE_CONTRAST_MAX,
  APPEARANCE_DEFAULT_COLORS,
  APPEARANCE_DEFAULT_CONTRAST,
  normalizeAppearance,
  resolveAppearanceContrast,
  type AppSettings,
  type ModeAppearance,
} from "@pi-desktop/shared";

import { appearanceFontStack, DEFAULT_UI_FONT } from "./font-stacks.ts";

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

function mix(from: string, to: string, amount: number): string {
  const target = rgb(to);
  return `#${rgb(from).map((channel, i) => Math.round(channel + (target[i] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

export function accentInkForChannels(channels: number[]): string {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
}

export function accentForeground(hex: string): string {
  return accentInkForChannels(rgb(hex));
}

const CONTRAST_RANGE = APPEARANCE_CONTRAST_MAX - APPEARANCE_CONTRAST_DEFAULT;

function contrastScale(contrast: number): { surface: number; border: number } {
  const offset = Math.min(1, Math.max(-1, (contrast - APPEARANCE_CONTRAST_DEFAULT) / CONTRAST_RANGE));
  return {
    surface: 1 + offset * (offset < 0 ? 0.75 : 0.9),
    border: 1 + offset * (offset < 0 ? 0.8 : 1.6),
  };
}

const SEPARATION_TOKENS: Record<
  string,
  { group: "surface" | "border"; dark: number; light: number }
> = {
  "--ds-tile": { group: "surface", dark: 3.5, light: 3.5 },
  "--ds-tile-hover": { group: "surface", dark: 6, light: 6 },
  "--ds-tile-deep": { group: "surface", dark: 8, light: 8 },
  "--ds-bg-hover": { group: "surface", dark: 6, light: 5 },
  "--ds-bg-active": { group: "surface", dark: 10, light: 8 },
  "--ds-bg-chip": { group: "surface", dark: 6, light: 4 },
  "--ds-border-subtle": { group: "border", dark: 5, light: 5 },
  "--ds-border-default": { group: "border", dark: 8, light: 8 },
  "--ds-border-strong": { group: "border", dark: 14, light: 12 },
};

function separationTokens(mode: "light" | "dark", contrast: number): Record<string, string> {
  if (contrast === APPEARANCE_CONTRAST_DEFAULT) return {};
  const scale = contrastScale(contrast);
  const tokens: Record<string, string> = {};
  for (const [token, entry] of Object.entries(SEPARATION_TOKENS)) {
    const amount = entry[mode] * (entry.group === "border" ? scale.border : scale.surface);
    tokens[token] =
      `color-mix(in oklab, var(--ds-text-primary) ${Number(Math.min(100, amount).toFixed(3))}%, transparent)`;
  }
  return tokens;
}

export function appearancePalette(mode: "light" | "dark", panel: ModeAppearance): Record<string, string> {
  const customized = Boolean(panel.accent || panel.background || panel.foreground);
  if (!customized) return separationTokens(mode, resolveAppearanceContrast(panel.contrast));
  const scale = contrastScale(resolveAppearanceContrast(panel.contrast));
  const defaults = APPEARANCE_DEFAULT_COLORS[mode];
  const bg = panel.background ?? defaults.background;
  const fg = panel.foreground ?? defaults.foreground;
  const accent = panel.accent ?? defaults.accent;
  const surface = (amount: number) => mix(bg, fg, Math.min(1, amount * scale.surface));
  const border = (amount: number) => mix(bg, fg, Math.min(1, amount * scale.border));
  const ink = (amount: number) => mix(bg, fg, amount);
  const onAccent = accentForeground(accent);
  const hover = mix(accent, onAccent === "#000000" ? "#FFFFFF" : "#000000", 0.12);
  const tokens: Record<string, string> = {
    "--ds-bg-primary": bg,
    "--ds-bg-sidebar": surface(0.025),
    "--ds-bg-secondary": surface(0.04),
    "--ds-bg-tertiary": surface(0.07),
    "--ds-bg-inset": surface(0.09),
    "--ds-bg-under": surface(0.025),
    "--ds-bg-dock": surface(0.04),
    "--ds-bg-dock-raised": surface(0.02),
    "--ds-bg-elevated": surface(0.06),
    "--ds-bg-elevated-opaque": surface(0.06),
    "--ds-bg-elevated-primary": surface(0.04),
    "--ds-bg-composer": surface(0.04),
    "--ds-bg-hover": surface(0.08),
    "--ds-bg-active": surface(0.12),
    "--ds-bg-chip": surface(0.08),
    "--ds-text-primary": fg,
    "--ds-text-secondary": ink(0.78),
    "--ds-text-muted": ink(0.62),
    "--ds-text-faint": ink(0.46),
    "--ds-border-default": border(0.16),
    "--ds-border-subtle": border(0.09),
    "--ds-border-strong": border(0.25),
    "--ds-tile": surface(0.035),
    "--ds-tile-hover": surface(0.065),
    "--ds-tile-deep": surface(0.09),
    "--ds-raised": surface(0.07),
    "--ds-accent": accent,
    "--ds-accent-hover": hover,
    "--ds-accent-soft": mix(accent, bg, 0.25),
    "--ds-on-accent": onAccent,
    "--ds-focus": accent,
    "--ds-info": ink(0.62),
    "--ds-settings-rail-bg": surface(0.025),
    "--ds-settings-field-bg": surface(0.06),
    "--ds-settings-nav-active": surface(0.12),
    "--ds-field-inset-bg": surface(0.05),
    "--ds-field-inset-focus-bg": surface(0.08),
    "--ds-switch-track-off": surface(0.15),
    "--ds-switch-track-off-hover": surface(0.22),
    "--ds-switch-ring-off": surface(0.3),
    "--ds-switch-knob-off": ink(0.65),
    "--ds-switch-knob-on": onAccent,
    "--ds-sidebar-glass-tint": surface(0.025),
    "--ds-sidebar-glass-sheen-top": "transparent",
    "--ds-sidebar-glass-sheen-bottom": "transparent",
  };
  const light = mode === "light" ? bg : fg;
  const dark = mode === "light" ? fg : bg;
  for (const step of [0, 50, 75, 100, 300, 500, 550, 600, 700, 750, 800, 900, 1000]) {
    tokens[`--gray-${step}`] = mix(light, dark, step / 1000);
  }
  for (const step of [50, 100, 300, 400, 900]) {
    tokens[`--accent-${step}`] = mix(accent, bg, step === 400 ? 0 : step / 1000);
  }
  return tokens;
}

export function resolveAppearance(settings: Pick<AppSettings, "theme" | "appearance" | "fontFamily">, mode: "light" | "dark") {
  const builtin = ["light", "dark", "system"].includes(settings.theme);
  const panel = builtin ? {
    ...APPEARANCE_DEFAULT_COLORS[mode],
    contrast: APPEARANCE_DEFAULT_CONTRAST[mode],
    ...normalizeAppearance(settings.appearance)?.[mode],
  } : undefined;
  const tokens = appearancePalette(mode, panel ?? {});
  const colors = Boolean(panel?.accent || panel?.background || panel?.foreground);
  const uiFamily = panel?.ui?.family || settings.fontFamily;
  if (uiFamily) tokens["--font-sans"] = panel?.ui?.family ? appearanceFontStack(uiFamily) : uiFamily;
  if (panel?.content?.family || panel?.ui?.family) {
    const family = panel?.content?.family || settings.fontFamily;
    tokens["--appearance-content-font"] = family ? appearanceFontStack(family) : DEFAULT_UI_FONT;
  }
  if (panel?.code?.family) tokens["--font-mono"] = appearanceFontStack(panel.code.family, true);
  for (const scope of ["ui", "content", "code"] as const) {
    const weight = panel?.[scope]?.weight;
    if (weight) tokens[`--appearance-${scope}-weight`] = String(weight);
  }
  return {
    tokens,
    colors,
    typography: Boolean(panel?.ui?.weight || panel?.content?.weight || panel?.code?.weight || panel?.code?.family),
    background: colors ? tokens["--ds-bg-primary"] : undefined,
  };
}
