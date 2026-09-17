import {
  APPEARANCE_CONTRAST_DEFAULT,
  APPEARANCE_CONTRAST_MAX,
  APPEARANCE_DEFAULT_COLORS,
  normalizeAppearance,
  normalizeHexColor,
  resolveAppearanceContrast,
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

/** WCAG 2.1 relative luminance of sRGB channels (0–255). */
function relativeLuminance(channels: number[]): number {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

/** Black or white, whichever contrasts more with the given luminance. */
function contrastInk(luminance: number): string {
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
}

export function accentForeground(hex: string): string {
  return contrastInk(relativeLuminance(rgb(hex)));
}

/**
 * Resolve CSS colours through the cascade, then rasterize one pixel to sRGB.
 * Canvas handles modern CSS colour spaces and composites translucent accents
 * over the theme's page background before the WCAG comparison.
 */
export function resolveAccentInk(root: HTMLElement, token = "--ds-accent"): string | undefined {
  const doc = root.ownerDocument;
  const view = doc?.defaultView;
  if (!doc?.createElement || !view?.getComputedStyle) return undefined;
  const probe = doc.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;left:-10000px;top:0;width:0;height:0;visibility:hidden;pointer-events:none";
  root.append(probe);
  try {
    probe.style.color = "var(--ds-bg-primary)";
    const background = view.getComputedStyle(probe).color;
    probe.style.color = `var(${token}, var(--ds-accent))`;
    const color = view.getComputedStyle(probe).color;
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.fillStyle = root.dataset.theme === "light" ? "#FFFFFF" : "#181818";
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return contrastInk(relativeLuminance(Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)));
    }
    const declared = normalizeHexColor(view.getComputedStyle(root).getPropertyValue(token).trim());
    return declared ? accentForeground(declared) : undefined;
  } finally {
    probe.remove();
  }
}

/** Normal and hover fills can have different brightness in contributed themes. */
export function accentInkTokens(root: HTMLElement): Record<string, string> {
  const tokens: Record<string, string> = {};
  const ink = resolveAccentInk(root);
  const hoverInk = resolveAccentInk(root, "--ds-accent-hover");
  if (ink) tokens["--ds-on-accent"] = ink;
  if (hoverInk) tokens["--ds-on-accent-hover"] = hoverInk;
  return tokens;
}

const CONTRAST_RANGE = APPEARANCE_CONTRAST_MAX - APPEARANCE_CONTRAST_DEFAULT;

/**
 * One slider drives two multipliers: fills move gently and borders harder, so a
 * boundary sharpens before a card turns into a slab of paint. The default is
 * exactly 1, i.e. the built-in sheet untouched.
 */
function contrastScale(contrast: number): { surface: number; border: number } {
  const offset = Math.min(1, Math.max(-1, (contrast - APPEARANCE_CONTRAST_DEFAULT) / CONTRAST_RANGE));
  return {
    surface: 1 + offset * (offset < 0 ? 0.75 : 0.9),
    border: 1 + offset * (offset < 0 ? 0.8 : 1.6),
  };
}

/**
 * The surface and border tokens the contrast slider rescales, with the mix
 * amount each one carries in `styles/tokens.css`. Those amounts are mirrored
 * here on purpose: the sheet has to keep painting the built-in look untouched,
 * so the slider exists only as a scaled copy of the same tint. Every entry is
 * the ink tint the sheet mixes — `var(--gray-0)` in dark and `#1a1c1f` in
 * light, which is what `--ds-text-primary` resolves to in each palette.
 */
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

/** Scaled separation overrides for the built-in sheets; empty at the baseline. */
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
  // Without custom colors the sheet owns every surface already, so only the
  // separation amounts can move.
  if (!customized) return separationTokens(mode, resolveAppearanceContrast(panel.contrast));
  const scale = contrastScale(resolveAppearanceContrast(panel.contrast));
  const defaults = APPEARANCE_DEFAULT_COLORS[mode];
  const bg = panel.background ?? defaults.background;
  const fg = panel.foreground ?? defaults.foreground;
  const accent = panel.accent ?? defaults.accent;
  // Fills move less than borders; text keeps its amount, so a low contrast
  // position cannot cost readability.
  const surface = (amount: number) => mix(bg, fg, Math.min(1, amount * scale.surface));
  const border = (amount: number) => mix(bg, fg, Math.min(1, amount * scale.border));
  const ink = (amount: number) => mix(bg, fg, amount);
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
  // Even a missing plugin must not inherit a built-in customization: a
  // contributed theme owns its own surfaces, so it gets neither the colors nor
  // the contrast position.
  const builtin = ["light", "dark", "system"].includes(settings.theme);
  const panel = builtin ? normalizeAppearance(settings.appearance)?.[mode] : undefined;
  const tokens = appearancePalette(mode, panel ?? {});
  const colors = Boolean(panel?.accent || panel?.background || panel?.foreground);
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
