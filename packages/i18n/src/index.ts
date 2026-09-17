export { en, type EnglishCatalog } from "./locales/en/index.js";
export { default as enDefault } from "./locales/en/index.js";
export { zhCN } from "./locales/zh-CN/index.js";
export { default as zhCNDefault } from "./locales/zh-CN/index.js";

import { en, type EnglishCatalog } from "./locales/en/index.js";
import { zhCN } from "./locales/zh-CN/index.js";

export const defaultLocale = "en";

/**
 * Shipped UI locales. Native names are endonyms and must stay untranslated
 * in the picker (D073). English names are the stable sort/search labels.
 */
export const supportedLocales = [
  { id: "en", nativeName: "English", englishName: "English" },
  { id: "zh-CN", nativeName: "简体中文", englishName: "Chinese (Simplified)" },
] as const;

export type AppLocale = (typeof supportedLocales)[number]["id"];
export type AppLanguageSetting = "auto" | AppLocale;

export const catalogs: Record<AppLocale, EnglishCatalog> = {
  en,
  "zh-CN": zhCN,
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return supportedLocales.some((locale) => locale.id === value);
}

export function isAppLanguageSetting(
  value: string | null | undefined,
): value is AppLanguageSetting {
  return value === "auto" || isAppLocale(value);
}

export function localeInfo(id: AppLocale) {
  return supportedLocales.find((locale) => locale.id === id)!;
}

/** English first, then the other shipped locales by English name. */
export function listedLocales(): (typeof supportedLocales)[number][] {
  const english = supportedLocales.find((locale) => locale.id === "en")!;
  const rest = supportedLocales
    .filter((locale) => locale.id !== "en")
    .slice()
    .sort((a, b) => a.englishName.localeCompare(b.englishName, "en"));
  return [english, ...rest];
}

export function resolveLocale(input?: string | null): AppLocale {
  const raw = (input || "").trim();
  if (!raw) return "en";
  const lower = raw.replaceAll("_", "-").toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
  return "en";
}

export function flattenCatalog(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[path] = value;
    } else if (value && typeof value === "object") {
      Object.assign(out, flattenCatalog(value as Record<string, unknown>, path));
    }
  }
  return out;
}
