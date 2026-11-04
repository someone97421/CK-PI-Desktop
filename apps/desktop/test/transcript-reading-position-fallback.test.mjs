import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

// `restoreTranscriptReadingPosition` escapes the id with the browser-only
// `CSS.escape`; this suite runs the function directly in Node.
globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
const { captureTranscriptReadingPosition, restoreTranscriptReadingPosition } = await import(
  "../src/lib/transcript-reading-position.ts"
);

/*
  Bookmarks anchor the visible message and also record the outer row of its
  transcript entry, which stays mounted while its process drawer is folded. A
  missing row is reported as missing so the caller can fall back to the newest
  turn; reapplying the absolute offset landed near the top once folded rows
  shortened the transcript.
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

test("restore tries the message, the turn marker and then the outer entry row", () => {
  const scroller = fakeScroller({ scrollTop: 100, top: 0 });
  const selectors = [];
  const row = {
    getBoundingClientRect: () => ({ top: 140, bottom: 200, height: 60, left: 0, right: 800 }),
    offsetHeight: 60,
  };
  const content = {
    querySelector: (selector) => {
      selectors.push(selector);
      return selector.startsWith("[data-reading-anchor=") ? row : null;
    },
  };
  assert.equal(
    restoreTranscriptReadingPosition(scroller, content, bookmark({ anchorId: "turn", anchorOffset: 40 })),
    "aligned",
  );
  // The inner row unmounted with its folded drawer: 100 + (140 - 0) - 40 = 200
  assert.equal(scroller.scrollTop, 200);
  assert.deepEqual(selectors, [
    '[data-message-id="m-late"]',
    '[data-minimap-id="m-late"]',
    '[data-reading-anchor="turn"]',
  ]);
});

test("an anchored message row restores by its rect", () => {
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
  assert.deepEqual(selectors, ['[data-message-id="m-late"]']);
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

test("capture anchors the visible message, not its regroupable answer wrapper", () => {
  const scroller = fakeScroller({ scrollTop: 80 });
  const row = (dataset, top, height) => ({
    dataset,
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  });
  const wrapper = row({ minimapId: "old-group" }, -400, 1600);
  const previous = row({ messageId: "above" }, -400, 350);
  const visible = row({ messageId: "visible" }, -20, 800);
  const content = {
    querySelectorAll: selector => selector === "[data-message-id]"
      ? [previous, visible] : selector === "[data-minimap-id]" ? [wrapper] : [wrapper, previous, visible],
  };
  const position = captureTranscriptReadingPosition(scroller, content, false, 60);
  assert.equal(position.messageId, "visible");
  assert.equal(position.offset, -20);
  // Prepending the preceding half changes the group key, not this message id.
  const moved = row({ messageId: "visible" }, 6400, 800);
  assert.equal(restoreTranscriptReadingPosition(scroller, fakeContent({ row: moved }), position), "aligned");
  assert.equal(scroller.scrollTop, 6500);
});

test("capture retains a turn anchor when no visible message body is mounted", () => {
  const scroller = fakeScroller();
  const wrapper = { dataset: { minimapId: "tools-only" },
    getBoundingClientRect: () => ({ top: -20, bottom: 800, height: 820 }) };
  const content = { querySelectorAll: selector => selector === "[data-message-id]" ? [] : [wrapper] };
  assert.equal(captureTranscriptReadingPosition(scroller, content, false, 60).messageId, "tools-only");
});

test("restore prefers the actual message over a group with the same marker id", () => {
  const scroller = fakeScroller({ scrollTop: 80 });
  const content = { querySelector: selector => ({
    getBoundingClientRect: () => ({ top: selector.startsWith("[data-message-id=") ? 140 : 100, height: 600 }),
  }) };
  assert.equal(restoreTranscriptReadingPosition(scroller, content, bookmark({ offset: 20 })), "aligned");
  assert.equal(scroller.scrollTop, 200);
});

test("capture also records the outer entry row as a folded-drawer fallback", () => {
  const scroller = fakeScroller();
  const row = (dataset, top, height) => ({
    dataset,
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  });
  const entry = row({ readingAnchor: "turn" }, -300, 1200);
  const tool = row({ messageId: "tool" }, 40, 60);
  const content = {
    querySelectorAll: selector => selector === "[data-reading-anchor]" ? [entry]
      : selector === "[data-message-id]" ? [tool] : [],
  };
  const position = captureTranscriptReadingPosition(scroller, content, false, 60);
  assert.deepEqual(
    [position.messageId, position.offset, position.anchorId, position.anchorOffset],
    ["tool", 40, "turn", -300],
  );
});
