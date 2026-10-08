import { useEffect, useId, useRef, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { highlightService, resolveLang, themeForMode, type ThemeMode } from "../lib/shiki";

type Result = { code: string; lang: string; theme: string; tokens: ThemedToken[][] | null };

/** 原文立即可见；只接受当前请求的结果，语法状态与解析全部留在 Worker。 */
export function useHighlightedTokens(code: string, lang: string, mode: ThemeMode): ThemedToken[][] | null {
  const owner = useId();
  const resolved = resolveLang(lang);
  const theme = themeForMode(mode);
  const previous = useRef<Result | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => () => highlightService.release(owner), [owner]);
  useEffect(() => {
    if (!resolved) {
      previous.current = null;
      setResult(null);
      return;
    }
    let current = true;
    const cancel = highlightService.request(owner, code, resolved, theme, (tokens) => {
      if (!current) return;
      const old = previous.current;
      // structured clone 会复制 token；恢复未变前缀的引用以保留逐行 memo。
      if (tokens && old?.tokens && old.lang === resolved && old.theme === theme) {
        const before = old.code.split("\n");
        const after = code.split("\n");
        for (let i = 0; i < Math.min(before.length, after.length); i++) {
          if (before[i] !== after[i]) break;
          tokens[i] = old.tokens[i];
        }
      }
      const next = { code, lang: resolved, theme, tokens };
      previous.current = next;
      setResult(next);
    });
    return () => { current = false; cancel(); };
  }, [owner, code, resolved, theme]);
  return result?.code === code && result.lang === resolved && result.theme === theme ? result.tokens : null;
}
