import {
  APPEARANCE_DEFAULT_COLORS,
  normalizeAppearance,
  type AppSettings,
  type ModeAppearance,
} from "@pi-desktop/shared";
import { appearanceFontStack, DEFAULT_UI_FONT } from "./fonts";

function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

function mix(from: string, to: string, amount: number): string {
  const target = rgb(to);
  return `#${rgb(from).map((channel, i) => Math.round(channel + (target[i] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const linear = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function accentForeground(hex: string): string {
  const light = luminance(hex);
  return (light + 0.05) / 0.05 >= 1.05 / (light + 0.05) ? "#000000" : "#FFFFFF";
}

export function appearancePalette(mode: "light" | "dark", panel: ModeAppearance): Record<string, string> {
  if (!panel.accent && !panel.background && !panel.foreground) return {};
  const defaults = APPEARANCE_DEFAULT_COLORS[mode];
  const bg = panel.background ?? defaults.background;
  const fg = panel.foreground ?? defaults.foreground;
  const accent = panel.accent ?? defaults.accent;
  const surface = (amount: number) => mix(bg, fg, amount);
  const onAccent = accentForeground(accent);
  // Hover moves away from its text color, keeping the chosen text readable.
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
    "--ds-text-secondary": surface(0.78),
    "--ds-text-muted": surface(0.62),
    "--ds-text-faint": surface(0.46),
    "--ds-border-default": surface(0.16),
    "--ds-border-subtle": surface(0.09),
    "--ds-border-strong": surface(0.25),
    "--ds-tile": surface(0.035),
    "--ds-tile-hover": surface(0.065),
    "--ds-tile-deep": surface(0.09),
    "--ds-raised": surface(0.07),
    "--ds-accent": accent,
    "--ds-accent-hover": hover,
    "--ds-accent-soft": mix(accent, bg, 0.25),
    "--ds-on-accent": onAccent,
    "--ds-focus": accent,
    "--ds-info": surface(0.62),
    "--ds-settings-rail-bg": surface(0.025),
    "--ds-settings-field-bg": surface(0.06),
    "--ds-settings-nav-active": surface(0.12),
    "--ds-field-inset-bg": surface(0.05),
    "--ds-field-inset-focus-bg": surface(0.08),
    "--ds-switch-track-off": surface(0.15),
    "--ds-switch-track-off-hover": surface(0.22),
    "--ds-switch-ring-off": surface(0.3),
    "--ds-switch-knob-off": surface(0.65),
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
  // Even a missing plugin must not inherit a built-in customization.
  const builtin = ["light", "dark", "system"].includes(settings.theme);
  const panel = builtin ? normalizeAppearance(settings.appearance)?.[mode] : undefined;
  const tokens = appearancePalette(mode, panel ?? {});
  const colors = Object.keys(tokens).length > 0;
  const uiFamily = panel?.ui?.family || settings.fontFamily;
  if (uiFamily) tokens["--font-sans"] = panel?.ui?.family ? appearanceFontStack(uiFamily) : uiFamily;
  // Content defaults to the legacy global font, not a customized UI font.
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

/** Own only our properties, so cleanup never removes fontScale or plugin CSS. */
export function applyAppearance(root: HTMLElement, tokens: Record<string, string>): () => void {
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  return () => {
    for (const key of Object.keys(tokens)) root.style.removeProperty(key);
  };
}
