import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { projectPlanHistory, planSubmission } = await import("../src/lib/plan-history.ts");
const { upsertLiveSessionMessage, mergeLiveSessionMessages } = await import("../src/lib/session-transcript.ts");
const proposal = (overrides = {}) => ({ id: "p1", sessionId: "s1", toolCallId: "c1", kind: "plan", title: "API plan", markdown: "# Exact\n- text  \n", status: "pending", version: 1, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", ...overrides });
const row = (p = proposal()) => ({ id: "tool-" + p.toolCallId, role: "tool", content: "submitted", toolName: p.kind === "goal" ? "SubmitGoal" : "SubmitPlan", toolCallId: p.toolCallId, toolResult: { details: { proposal: p } } });

test("authoritative approvals override immutable pending snapshots and stale echoes", () => {
  const pending = row();
  const approved = proposal({ status: "approved", version: 2 });
  const history = projectPlanHistory([pending], [{ proposal: approved, superseded: false }], "s1");
  assert.equal(planSubmission(history[0]).status, "approved");
  assert.equal(pending.toolResult.details.proposal.status, "pending");
  assert.equal(upsertLiveSessionMessage(history, pending)[0].planHistory.proposal.status, "approved");
  assert.equal(mergeLiveSessionMessages([pending], history)[0].planHistory.proposal.status, "approved");
  const stale = projectPlanHistory([pending], [{ proposal: proposal(), superseded: false }], "s1");
  assert.equal(mergeLiveSessionMessages(stale, history)[0].planHistory.proposal.version, 2);
});

test("new revisions supersede old submissions without losing approved state or affecting Goal", () => {
  const first = proposal({ status: "approved", version: 2 });
  const goal = proposal({ id: "g1", toolCallId: "gc1", kind: "goal" });
  const messages = projectPlanHistory([row(first), row(goal)], [{ proposal: first, superseded: false }, { proposal: goal, superseded: false }], "s1");
  const second = proposal({ id: "p2", toolCallId: "c2", createdAt: "2026-10-04T00:01:00.000Z" });
  const next = projectPlanHistory(messages, [{ proposal: second, superseded: false }], "s1");
  assert.equal(next[0].planHistory.superseded, true);
  assert.equal(next[0].planHistory.proposal.status, "approved");
  assert.equal(next[0].planHistory.proposal.markdown, first.markdown);
  assert.equal(next[1].planHistory.superseded, false);
  assert.equal(projectPlanHistory(next, [{ proposal: first, superseded: false }], "s1")[0].planHistory.superseded, true);
});

test("history is scoped by session, exact call and host tool; snapshot fallback does not invent current state", () => {
  const messages = [row(), { ...row(), toolName: "plugin:SubmitPlan" }, { ...row(), toolCallId: "other" }];
  assert.strictEqual(projectPlanHistory(messages, [{ proposal: proposal({ sessionId: "other" }), superseded: false }], "s1"), messages);
  const next = projectPlanHistory(messages, [{ proposal: proposal({ status: "rejected" }), superseded: false }], "s1");
  assert.equal(next[0].planHistory.proposal.status, "rejected");
  assert.equal(next[1].planHistory, undefined);
  assert.equal(next[2].planHistory, undefined);
  assert.equal(planSubmission(messages[1]), undefined);
  assert.equal(planSubmission(messages[2]), undefined);
  assert.equal(planSubmission(messages[0]).markdown, proposal().markdown);
  assert.equal(messages[0].planHistory, undefined);
});
