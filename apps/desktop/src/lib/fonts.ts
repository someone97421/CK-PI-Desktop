import type { FontFaceMetadata, FontMetadata } from "@pi-desktop/shared";

/**
 * Global UI font model for the Settings picker.
 *
 * A selection is stored as a CSS `font-family` stack string in
 * `AppSettings.fontFamily`. Only installed system families are offered — the
 * app ships no fonts of its own — and every stack keeps system CJK fallbacks
 * so Chinese text stays readable when the selected family has no CJK glyphs.
 */
/**
 * CJK fallback tier appended to every custom stack. All three families are
 * provided by the platform; the app bundles no CJK face of its own.
 */
const CJK_FALLBACK = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
export const DEFAULT_UI_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ${CJK_FALLBACK}`;
export const DEFAULT_CODE_FONT = `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", "Microsoft YaHei", monospace`;

export function appearanceFontStack(family: string, code = false): string {
  // Picker stacks include CJK sans fonts; keep the chosen face but put mono
  // fallbacks before those fonts when the chosen code font is unavailable.
  const selected = code ? family.match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,]+)(?:\s*)/)?.[0] ?? family : family;
  return `${selected}, ${code ? DEFAULT_CODE_FONT : DEFAULT_UI_FONT}`;
}

export type FontOption = {
  /** CSS stack persisted on selection; `""` selects the system default. */
  value: string;
  /** Readable family name shown in the picker. */
  label: string;
  /** Family used to render the picker preview in the chosen face. */
  family: string;
  group: "default" | "system" | "custom";
};

/** Quote a bare family name for use inside a CSS font-family stack. */
export function cssFamilyForName(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Extract the first readable family name from a CSS stack. */
export function readableFontFamily(stack: string): string {
  const first = stack.match(/^\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,]+)/)?.[1]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "").replace(/\\([\da-f]{1,6})\s?|\\(.)/gi,
    (_, hex: string | undefined, escaped: string) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : escaped);
}

function systemStack(family: string): string {
  return `${cssFamilyForName(family)}, ${CJK_FALLBACK}`;
}

/**
 * Build the picker options: the system default, then installed system
 * families. The current stored stack is re-added first when it no longer
 * matches any known option — the family was uninstalled, or the stack names
 * one of the bundled faces an earlier build shipped and this one no longer
 * does.
 */
export function buildFontOptions(
  systemFonts: readonly string[],
  selected: string | undefined,
): FontOption[] {
  const options: FontOption[] = [
    { value: "", label: "System default", family: "", group: "default" },
    ...systemFonts.map((family) => ({
      value: systemStack(family),
      label: family,
      family,
      group: "system" as const,
    })),
  ];
  const known = new Set(options.map((option) => option.value));
  if (selected && !known.has(selected)) {
    options.unshift({
      value: selected,
      label: readableFontFamily(selected),
      family: readableFontFamily(selected),
      group: "custom",
    });
  }
  return options;
}

let cachedSystemFonts: { fonts: string[]; at: number } | null = null;
let pendingSystemFonts: Promise<string[]> | null = null;

/** Installed system font families, shared by all six appearance rows. */
export async function loadSystemFonts(): Promise<string[]> {
  if (cachedSystemFonts && Date.now() - cachedSystemFonts.at < 60_000) return cachedSystemFonts.fonts;
  pendingSystemFonts ??= import("./api")
    .then(({ api }) => api.listSystemFonts())
    .finally(() => {
      pendingSystemFonts = null;
    });
  const fonts = await pendingSystemFonts;
  cachedSystemFonts = { fonts, at: Date.now() };
  return fonts;
}

const metadataCache = new Map<string, { metadata: FontMetadata; at: number }>();
const metadataPending = new Map<string, Promise<FontMetadata>>();
const genericFamilies = new Set(["", "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "fangsong", "emoji", "-apple-system", "blinkmacsystemfont", "inherit", "initial", "unset", "revert"]);

/** Resolve only the leading family, never claim the fallback stack is a face. */
export async function loadFontMetadata(stack: string): Promise<FontMetadata> {
  const family = readableFontFamily(stack);
  const key = family.normalize("NFC").toLowerCase();
  if (genericFamilies.has(key)) return { family, source: "generic", status: "unavailable", faces: [] };
  const cached = metadataCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.metadata;
  const pending = metadataPending.get(key);
  if (pending) return pending;
  const task = (async () => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      const metadata = await Promise.race([
        import("./api").then(({ api }) => api.getFontMetadata(family)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Font metadata timeout")), 25_000); }),
      ]);
      if (metadataCache.size >= 256) metadataCache.delete(metadataCache.keys().next().value!);
      metadataCache.set(key, { metadata, at: Date.now() });
      return metadata;
    } catch {
      const metadata: FontMetadata = { family, source: "system", status: "unavailable", faces: [] };
      if (metadataCache.size >= 256) metadataCache.delete(metadataCache.keys().next().value!);
      metadataCache.set(key, { metadata, at: Date.now() });
      return metadata;
    } finally {
      clearTimeout(timer!);
    }
  })().finally(() => metadataPending.delete(key));
  metadataPending.set(key, task);
  return task;
}

/** CSS matches width before style/weight: for normal, try <=5 descending, then >5 ascending. */
export function weightFaces(metadata: FontMetadata): FontFaceMetadata[] {
  const widths = metadata.faces.map((face) => face.width);
  const narrower = widths.filter((width) => width <= 5);
  const width = narrower.length ? Math.max(...narrower) : Math.min(...widths);
  const faces = metadata.faces.filter((face) => face.width === width && face.style === "normal");
  return faces.sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name))
    .filter((face, i, all) => all.findIndex((candidate) => candidate.weight === face.weight &&
      candidate.variable === face.variable && candidate.wght?.min === face.wght?.min && candidate.wght?.max === face.wght?.max) === i);
}

export function supportsFontWeight(faces: readonly FontFaceMetadata[], weight: number): boolean {
  return Number.isFinite(weight) && weight >= 1 && weight <= 1000 && faces.some((face) =>
    face.wght ? weight >= face.wght.min && weight <= face.wght.max : weight === face.weight,
  );
}
