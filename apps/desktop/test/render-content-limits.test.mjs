import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectHighlightLimits,
  isWithinHighlightLimits,
  MAX_HIGHLIGHT_CODE_UNITS,
  MAX_HIGHLIGHT_LINES,
  MAX_HIGHLIGHT_LINE_CODE_UNITS,
} from "../src/lib/render-content-limits.ts";

test("highlight boundaries are checked in UTF-16 units before splitting", () => {
  const maximumSource = ("x".repeat(999) + "\n").repeat(100);
  assert.equal(maximumSource.length, MAX_HIGHLIGHT_CODE_UNITS);
  assert.equal(isWithinHighlightLimits(maximumSource), true);
  assert.deepEqual(inspectHighlightLimits("x".repeat(MAX_HIGHLIGHT_CODE_UNITS + 1)), {
    within: false,
    lineCount: 0,
    longestLine: 0,
    reason: "code-length",
  });
  assert.equal(isWithinHighlightLimits("x".repeat(MAX_HIGHLIGHT_LINE_CODE_UNITS)), true);
  assert.equal(isWithinHighlightLimits("x".repeat(MAX_HIGHLIGHT_LINE_CODE_UNITS + 1)), false);
  assert.equal(isWithinHighlightLimits(Array.from({ length: MAX_HIGHLIGHT_LINES }, () => "x").join("\n")), true);
  assert.equal(isWithinHighlightLimits(Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "x").join("\n")), false);
});
