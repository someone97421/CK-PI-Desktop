import { normalizeHexColor } from "@pi-desktop/shared";
import { accentForeground, accentInkForChannels } from "../../shared/appearance-palette";
export { accentForeground, appearancePalette, resolveAppearance } from "../../shared/appearance-palette";

/** Resolve CSS colours through the cascade and rasterize them to sRGB. */
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
      return accentInkForChannels(Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3));
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

/** Own only our properties, so cleanup never removes fontScale or plugin CSS. */
export function applyAppearance(root: HTMLElement, tokens: Record<string, string>): () => void {
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  return () => {
    for (const key of Object.keys(tokens)) root.style.removeProperty(key);
  };
}
