// 仅由高亮 Worker 加载；同步语法解析不得在界面线程执行。
import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { inspectHighlightLimits } from "./render-content-limits.ts";
import { beginRenderDiagnostic } from "./render-diagnostics.ts";
import { resolveLang } from "./shiki-languages.ts";
import { LANGUAGE_DEFINITIONS } from "./shiki-grammars.ts";
export { resolveLang, SUPPORTED_LANGUAGES, themeForMode } from "./shiki-languages.ts";

let highlighter: HighlighterCore | null = null;
let creating: Promise<HighlighterCore> | null = null;
const readyLangs = new Set<string>();
const loading = new Map<string, Promise<void>>();

function getHighlighterInstance(): Promise<HighlighterCore> {
  creating ??= createHighlighterCore({
    themes: [
      import("shiki/themes/one-light.mjs"),
      import("shiki/themes/one-dark-pro.mjs"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((instance) => {
    highlighter = instance;
    return instance;
  });
  return creating;
}

/** 加载失败由 Worker 返回纯文本；同一语法只加载一次。 */
export function ensureLang(lang: string): Promise<void> {
  const resolved = resolveLang(lang);
  if (!resolved) return Promise.resolve();
  let pending = loading.get(resolved);
  if (!pending) {
    pending = getHighlighterInstance()
      .then((instance) => instance.loadLanguage(LANGUAGE_DEFINITIONS[resolved].load()))
      .then(() => { readyLangs.add(resolved); });
    loading.set(resolved, pending);
  }
  return pending;
}

export type LineCache = {
  lang: string;
  theme: string;
  /** Source lines already tokenized. */
  lines: string[];
  /** Tokens per line; rows are reused by reference for unchanged lines. */
  tokens: ThemedToken[][];
  /** Grammar state at the end of each line, chaining line i into i+1. */
  states: (GrammarState | undefined)[];
};

/**
 * Incrementally tokenize `code`, reusing every line before the first
 * divergence from `prev`. Returns null while the language is not ready
 * (caller renders plain text). Returns `prev` unchanged when the code is
 * identical, so referential equality can skip re-renders.
 */
export function tokenizeIncremental(
  prev: LineCache | null,
  code: string,
  lang: string,
  theme: string,
): LineCache | null {
  const finishDiagnostic = beginRenderDiagnostic("code-highlight", {
    sourceLength: code.length,
  });
  if (!highlighter || !readyLangs.has(lang)) {
    finishDiagnostic({ reason: "language-unavailable" });
    return null;
  }
  const limits = inspectHighlightLimits(code);
  if (!limits.within) {
    finishDiagnostic({ longestLine: limits.longestLine, inputNodeCount: limits.lineCount, reason: limits.reason });
    return null;
  }

  const lines = code.split("\n");
  const cache =
    prev && prev.lang === lang && prev.theme === theme ? prev : null;
  const reusable = cache
    ? Math.min(cache.lines.length, lines.length)
    : 0;

  let start = 0;
  while (start < reusable && cache!.lines[start] === lines[start]) start += 1;

  if (cache && start === lines.length && cache.lines.length === lines.length) {
    finishDiagnostic({
      longestLine: limits.longestLine,
      inputNodeCount: lines.length,
      reason: "cache-hit",
    });
    return cache;
  }

  const outLines = cache ? cache.lines.slice(0, start) : [];
  const outTokens = cache ? cache.tokens.slice(0, start) : [];
  const outStates = cache ? cache.states.slice(0, start) : [];

  for (let i = start; i < lines.length; i += 1) {
    const grammarState = i > 0 ? outStates[i - 1] : undefined;
    const rows = highlighter.codeToTokensBase(lines[i], {
      lang,
      theme,
      grammarState,
      includeExplanation: false,
    });
    outLines.push(lines[i]);
    outTokens.push(rows[0] ?? []);
    outStates.push(highlighter.getLastGrammarState(rows));
  }

  finishDiagnostic({ longestLine: limits.longestLine, inputNodeCount: lines.length });
  return { lang, theme, lines: outLines, tokens: outTokens, states: outStates };
}
