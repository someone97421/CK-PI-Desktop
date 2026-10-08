export const THEMES = { light: "one-light", dark: "one-dark-pro" } as const;
export type ThemeMode = keyof typeof THEMES;
type Theme = (typeof THEMES)[ThemeMode];

export function themeForMode(mode: ThemeMode): Theme {
  return THEMES[mode];
}

const LANGUAGE_ALIASES = {
  astro: [],
  bat: ["batch"],
  c: [],
  cpp: ["c++"],
  csharp: ["c#", "cs"],
  css: [],
  dart: [],
  diff: [],
  docker: ["dockerfile"],
  dotenv: [],
  go: [],
  graphql: ["gql"],
  groovy: [],
  hcl: [],
  html: [],
  ini: ["properties"],
  java: [],
  javascript: ["js", "cjs", "mjs"],
  json: [],
  jsonc: [],
  jsonl: [],
  jsx: [],
  kotlin: ["kt", "kts"],
  lua: [],
  make: ["makefile"],
  markdown: ["md"],
  mdx: [],
  mermaid: ["mmd"],
  nginx: [],
  php: [],
  powershell: ["ps", "ps1"],
  prisma: [],
  proto: ["protobuf"],
  python: ["py"],
  ruby: ["rb"],
  rust: ["rs"],
  scala: [],
  shellscript: ["bash", "sh", "shell", "zsh"],
  sql: [],
  svelte: [],
  swift: [],
  terraform: ["tf", "tfvars"],
  toml: [],
  tsx: [],
  typescript: ["ts", "cts", "mts"],
  vue: [],
  xml: [],
  yaml: ["yml"],
} as const;

type SupportedLanguage = keyof typeof LANGUAGE_ALIASES;

export const SUPPORTED_LANGUAGES = Object.freeze(
  Object.keys(LANGUAGE_ALIASES) as SupportedLanguage[],
);

const languageIds = new Map<string, SupportedLanguage>();
for (const id of SUPPORTED_LANGUAGES) {
  languageIds.set(id, id);
  for (const alias of LANGUAGE_ALIASES[id]) {
    languageIds.set(alias, id);
  }
}

const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext", "ansi"]);

/** Normalize a fence tag to a loadable Shiki language id, or null for plain. */
export function resolveLang(lang: string): SupportedLanguage | null {
  const id = lang.trim().toLowerCase();
  if (PLAIN_LANGS.has(id)) return null;
  return languageIds.get(id) ?? null;
}
