import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hook = await readFile(
  new URL("../src/hooks/useSmoothText.ts", import.meta.url),
  "utf8",
);

test("streaming text batches renderer commits at 50 ms and stops when caught up", () => {
  assert.match(hook, /if \(elapsed < 50\)/);
  assert.match(hook, /if \(backlog <= 0\) \{[\s\S]*?rafRef\.current = null;/);
  assert.match(hook, /const exactAdvance = fractionalAdvanceRef\.current \+ speed \* dt/);
});

test("disabled reveal still batches streaming text and finished text flushes immediately", () => {
  assert.match(hook, /const advance = enabled \? Math\.floor\(exactAdvance\) : backlog/);
  assert.match(hook, /if \(!streaming\) return source;/);
  assert.doesNotMatch(hook, /if \(!enabled \|\| !streaming\) return/);
});

test("streaming cursor does not add a line to the last Markdown block", async () => {
  const css = await readFile(new URL("../src/styles/messages.css", import.meta.url), "utf8");
  assert.match(css, /\.assistant-turn-fragment\.smooth-cursor \.prose-chat::after\s*\{[^}]*position: absolute;/);
  assert.doesNotMatch(css, /\.smooth-cursor \.prose-chat > :last-child::after/);
});
