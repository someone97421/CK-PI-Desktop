import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// `restoreTranscriptReadingPosition` escapes the id with the browser-only
// `CSS.escape`; this suite runs the function directly in Node.
globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
const { restoreTranscriptReadingPosition } = await import(
  "../src/lib/transcript-reading-position.ts"
);

/*
  Bookmarks anchor the outer row of a transcript entry, which stays mounted
  while its process drawer is folded. A missing row is reported as missing so
  the caller can fall back to the newest turn; reapplying the absolute offset
  landed near the top once folded rows shortened the transcript.
*/

/** Minimal stand-ins for the two DOM objects the function touches. */
function fakeScroller({ scrollTop = 0, top = 0 } = {}) {
  return {
    scrollTop,
    getBoundingClientRect: () => ({ top, bottom: top + 600, left: 0, right: 800 }),
    // `transcriptHasLayout` needs a real box.
    clientHeight: 600,
    scrollHeight: 1200,
    offsetHeight: 600,
  };
}
function fakeContent({ row = null, selectors = [] } = {}) {
  return {
    querySelector: (selector) => {
      selectors.push(selector);
      return row;
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    offsetHeight: 1200,
  };
}

const bookmark = (overrides = {}) => ({
  pinned: false,
  messageId: "m-late",
  offset: 24,
  scrollTop: 480,
  windowSize: 60,
  ...overrides,
});

test("an anchored outer row restores by its rect", () => {
  const scroller = fakeScroller({ scrollTop: 100, top: 0 });
  const selectors = [];
  const row = {
    getBoundingClientRect: () => ({ top: 140, bottom: 200, height: 60, left: 0, right: 800 }),
    offsetHeight: 60,
  };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row, selectors }), bookmark()),
    "aligned",
  );
  // 100 + (140 - 0) - 24 = 216
  assert.equal(scroller.scrollTop, 216);
  assert.deepEqual(selectors, ['[data-reading-anchor="m-late"]']);
});

test("a missing anchored row is reported instead of reapplying the absolute offset", () => {
  const scroller = fakeScroller({ scrollTop: 0, top: 0 });
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row: null }), bookmark({ scrollTop: 480 })),
    "missing",
  );
  assert.equal(scroller.scrollTop, 0);
});

test("a mounted row without height waits for layout", () => {
  const scroller = fakeScroller({ scrollTop: 0, top: 0 });
  const collapsed = {
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0, left: 0, right: 800 }),
    offsetHeight: 0,
  };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row: collapsed }), bookmark({ scrollTop: 300 })),
    "unavailable",
  );
  assert.equal(scroller.scrollTop, 0);
});

test("a bookmark without an anchor uses its offset only when it is usable", () => {
  const scroller = fakeScroller();
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent(), bookmark({ messageId: undefined, scrollTop: 320 })),
    "aligned",
  );
  assert.equal(scroller.scrollTop, 320);
  for (const scrollTop of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(
      restoreTranscriptReadingPosition(fakeScroller(), fakeContent(), bookmark({ messageId: undefined, scrollTop })),
      "missing",
      `scrollTop ${scrollTop} must not be applied`,
    );
  }
});

test("a pane with no layout is refused outright", () => {
  // A hidden pane reports no box; applying any offset there would corrupt the
  // bookmark it is supposed to protect.
  const scroller = { scrollTop: 0, clientHeight: 0, scrollHeight: 0, offsetHeight: 0, getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, fakeContent({ row: null }), bookmark()),
    "unavailable",
  );
});
