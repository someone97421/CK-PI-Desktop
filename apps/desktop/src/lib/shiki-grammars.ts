import type { LanguageInput } from "shiki/core";

type LanguageDefinition = {
  aliases?: readonly string[];
  load: () => LanguageInput;
};

// Explicit imports keep Vite from emitting Shiki's entire grammar catalog.
export const LANGUAGE_DEFINITIONS = {
  astro: { load: () => import("shiki/langs/astro.mjs") },
  bat: { aliases: ["batch"], load: () => import("shiki/langs/bat.mjs") },
  c: { load: () => import("shiki/langs/c.mjs") },
  cpp: { aliases: ["c++"], load: () => import("shiki/langs/cpp.mjs") },
  csharp: {
    aliases: ["c#", "cs"],
    load: () => import("shiki/langs/csharp.mjs"),
  },
  css: { load: () => import("shiki/langs/css.mjs") },
  dart: { load: () => import("shiki/langs/dart.mjs") },
  diff: { load: () => import("shiki/langs/diff.mjs") },
  docker: {
    aliases: ["dockerfile"],
    load: () => import("shiki/langs/docker.mjs"),
  },
  dotenv: { load: () => import("shiki/langs/dotenv.mjs") },
  go: { load: () => import("shiki/langs/go.mjs") },
  graphql: {
    aliases: ["gql"],
    load: () => import("shiki/langs/graphql.mjs"),
  },
  groovy: { load: () => import("shiki/langs/groovy.mjs") },
  hcl: { load: () => import("shiki/langs/hcl.mjs") },
  html: { load: () => import("shiki/langs/html.mjs") },
  ini: { aliases: ["properties"], load: () => import("shiki/langs/ini.mjs") },
  java: { load: () => import("shiki/langs/java.mjs") },
  javascript: {
    aliases: ["js", "cjs", "mjs"],
    load: () => import("shiki/langs/javascript.mjs"),
  },
  json: { load: () => import("shiki/langs/json.mjs") },
  jsonc: { load: () => import("shiki/langs/jsonc.mjs") },
  jsonl: { load: () => import("shiki/langs/jsonl.mjs") },
  jsx: { load: () => import("shiki/langs/jsx.mjs") },
  kotlin: {
    aliases: ["kt", "kts"],
    load: () => import("shiki/langs/kotlin.mjs"),
  },
  lua: { load: () => import("shiki/langs/lua.mjs") },
  make: {
    aliases: ["makefile"],
    load: () => import("shiki/langs/make.mjs"),
  },
  markdown: {
    aliases: ["md"],
    load: () => import("shiki/langs/markdown.mjs"),
  },
  mdx: { load: () => import("shiki/langs/mdx.mjs") },
  mermaid: {
    aliases: ["mmd"],
    load: () => import("shiki/langs/mermaid.mjs"),
  },
  nginx: { load: () => import("shiki/langs/nginx.mjs") },
  php: { load: () => import("shiki/langs/php.mjs") },
  powershell: {
    aliases: ["ps", "ps1"],
    load: () => import("shiki/langs/powershell.mjs"),
  },
  prisma: { load: () => import("shiki/langs/prisma.mjs") },
  proto: {
    aliases: ["protobuf"],
    load: () => import("shiki/langs/proto.mjs"),
  },
  python: { aliases: ["py"], load: () => import("shiki/langs/python.mjs") },
  ruby: { aliases: ["rb"], load: () => import("shiki/langs/ruby.mjs") },
  rust: { aliases: ["rs"], load: () => import("shiki/langs/rust.mjs") },
  scala: { load: () => import("shiki/langs/scala.mjs") },
  shellscript: {
    aliases: ["bash", "sh", "shell", "zsh"],
    load: () => import("shiki/langs/shellscript.mjs"),
  },
  sql: { load: () => import("shiki/langs/sql.mjs") },
  svelte: { load: () => import("shiki/langs/svelte.mjs") },
  swift: { load: () => import("shiki/langs/swift.mjs") },
  terraform: {
    aliases: ["tf", "tfvars"],
    load: () => import("shiki/langs/terraform.mjs"),
  },
  toml: { load: () => import("shiki/langs/toml.mjs") },
  tsx: { load: () => import("shiki/langs/tsx.mjs") },
  typescript: {
    aliases: ["ts", "cts", "mts"],
    load: () => import("shiki/langs/typescript.mjs"),
  },
  vue: { load: () => import("shiki/langs/vue.mjs") },
  xml: { load: () => import("shiki/langs/xml.mjs") },
  yaml: { aliases: ["yml"], load: () => import("shiki/langs/yaml.mjs") },
} as const satisfies Record<string, LanguageDefinition>;
