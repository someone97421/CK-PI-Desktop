import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assistantTurnPartsSource = await readFile(
  new URL("../src/features/chat/transcript/AssistantTurnParts.tsx", import.meta.url),
  "utf8",
);
const messagesCss = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const cursorSource = await readFile(
  new URL("../src/hooks/use-streaming-cursor.ts", import.meta.url),
  "utf8",
);

test("streaming cursor remains steady throughout active streaming without flapping", () => {
  assert.match(assistantTurnPartsSource, /const showCursor = streaming && enabled && Boolean\(displayContent\);/);
  assert.doesNotMatch(assistantTurnPartsSource, /displayContent\.length < \(message\.content \|\| ""\)\.length/);
});

test("streaming prose chat stabilizes line wrapping against orphan-rebalancing reflow", () => {
  assert.match(messagesCss, /\.assistant-turn-fragment\.streaming \.prose-chat\s*\{\s*text-wrap:\s*wrap;\s*\}/);
});

test("streaming cursor uses the measured leaf position without changing Markdown layout", () => {
  assert.match(assistantTurnPartsSource, /useStreamingCursor\(displayContent, showCursor\)/);
  assert.match(assistantTurnPartsSource, /ref=\{proseRef\}/);
  assert.match(messagesCss, /\.assistant-turn-fragment\.smooth-cursor \.prose-chat\[data-cursor-ready\]::after/);
  assert.match(messagesCss, /left: var\(--stream-cursor-x\)/);
  assert.match(messagesCss, /top: var\(--stream-cursor-y\)/);
  assert.match(cursorSource, /getClientRects\(\)/);
});
