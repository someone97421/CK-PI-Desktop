/** Bounds for work performed synchronously while rendering transcript content. */
export const MAX_SYNC_MARKDOWN_CODE_UNITS = 128 * 1024;
export const MAX_STREAMING_MARKDOWN_TAIL_CODE_UNITS = 32 * 1024;
export const MAX_SMOOTH_TEXT_CODE_UNITS = 32 * 1024;
export const MAX_HIGHLIGHT_CODE_UNITS = 100_000;
export const MAX_HIGHLIGHT_LINES = 800;
export const MAX_HIGHLIGHT_LINE_CODE_UNITS = 2_000;

export type HighlightLimitInspection = {
  within: boolean;
  lineCount: number;
  longestLine: number;
  reason?: "code-length" | "line-count" | "line-length";
};

/** Cheap raw-source guard; call before splitting, parsing, or normalizing code. */
export function inspectHighlightLimits(source: string): HighlightLimitInspection {
  if (source.length > MAX_HIGHLIGHT_CODE_UNITS) {
    return { within: false, lineCount: 0, longestLine: 0, reason: "code-length" };
  }

  let lineCount = 1;
  let lineLength = 0;
  let longestLine = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) {
      longestLine = Math.max(longestLine, lineLength);
      lineCount += 1;
      if (lineCount > MAX_HIGHLIGHT_LINES) {
        return { within: false, lineCount, longestLine, reason: "line-count" };
      }
      lineLength = 0;
    } else {
      lineLength += 1;
      if (lineLength > MAX_HIGHLIGHT_LINE_CODE_UNITS) {
        return {
          within: false,
          lineCount,
          longestLine: Math.max(longestLine, lineLength),
          reason: "line-length",
        };
      }
    }
  }
  return {
    within: true,
    lineCount,
    longestLine: Math.max(longestLine, lineLength),
  };
}

export function isWithinHighlightLimits(source: string): boolean {
  return inspectHighlightLimits(source).within;
}
