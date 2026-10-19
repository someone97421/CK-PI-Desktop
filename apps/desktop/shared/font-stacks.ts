export const CJK_FALLBACK = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
export const DEFAULT_UI_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, ${CJK_FALLBACK}`;
export const DEFAULT_CODE_FONT = `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", "Microsoft YaHei", monospace`;

export function appearanceFontStack(family: string, code = false): string {
  const selected = code ? family.match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,]+)(?:\s*)/)?.[0] ?? family : family;
  return `${selected}, ${code ? DEFAULT_CODE_FONT : DEFAULT_UI_FONT}`;
}
