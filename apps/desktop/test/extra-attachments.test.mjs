import assert from "node:assert/strict";
import test from "node:test";
import { getExtraMessageAttachments } from "../src/features/chat/transcript/extra-attachments.ts";

const attachments = [
  { kind: "file", name: "file.ts", ref: "docs/file.ts" },
  { kind: "image", name: "image.png", ref: "assets/image.png" },
  { kind: "session", name: "Session", ref: "session-1" },
];

test("long user text still deduplicates a later inline file against attachments", () => {
  const content = `${"a".repeat(80_000)} docs/file.ts`;
  assert.deepEqual(getExtraMessageAttachments(content, attachments, "/workspace"), [
    attachments[1],
    attachments[2],
  ]);
});

test("budgeted scanning preserves unresolved attachments instead of dropping them", () => {
  const content = `${"a".repeat(140_000)} docs/file.ts`;
  assert.deepEqual(
    getExtraMessageAttachments(content, attachments, "/workspace"),
    [attachments[0], attachments[1], attachments[2]],
  );
});
