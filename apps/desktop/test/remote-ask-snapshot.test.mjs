import assert from "node:assert/strict";
import test from "node:test";
import { trackAskSnapshot } from "../src/lib/pending-asks.ts";

const ask = (id, sessionId = "s") => ({
  requestId: id, sessionId, toolCallId: `call-${id}`,
  questions: [{ question: "保留 `artifacts` 吗？", options: ["保留", { label: "清理", description: "删除独立技能包" }] }],
  autoSelect: { startedAt: 1000, deadlineAt: 2000 },
});

test("late join restores the original pending card and preserves its draft", () => {
  const pending = ask("a");
  const stale = ask("b");
  const other = ask("c", "other");
  const draft = { index: 0, answers: [] };
  const tracker = trackAskSnapshot("s");
  tracker.observe({ sessionId: "s", event: { type: "asktool_request", request: pending } });
  const result = tracker.reconcile([pending], { s: [stale], other: [other] }, { a: draft, b: draft });
  assert.deepEqual(result, { pendingAsks: { s: [pending], other: [other] }, askDrafts: { a: draft } });
});

test("a stale read cannot reopen a completed question or replace a newer question", () => {
  const old = ask("old");
  const next = ask("next");
  for (const terminal of [{ type: "tool_end", toolCallId: old.toolCallId }, { type: "agent_end" }]) {
    const tracker = trackAskSnapshot("s");
    tracker.observe({ sessionId: "s", event: terminal });
    tracker.observe({ sessionId: "s", event: { type: "asktool_request", request: next } });
    tracker.observe({ sessionId: "elsewhere", event: { type: "agent_end" } });
    assert.deepEqual(tracker.reconcile([old], {}, {}).pendingAsks, { s: [next] });
  }
  assert.deepEqual(trackAskSnapshot("s").reconcile([], { s: [old] }, { old: {} }), { pendingAsks: {}, askDrafts: {} });
});
