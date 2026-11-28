import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createQueueSlice } = await import("../src/stores/slices/queue-slice.ts");
const { pendingRevisionPlan } = await import("../src/lib/plan-mode-state.ts");
const { submitWithLatestDraftRestore } = await import("../src/features/chat/composer/hooks/submit-with-latest-draft-restore.mjs");

function fixture(t, { accepts = true } = {}) {
  const plan = { id: "p1", sessionId: "s1", turnId: "t1", toolCallId: "c1", version: 1, kind: "plan", status: "pending" };
  const resolution = Promise.withResolvers();
  const rejected = { ...plan, version: 2, status: "rejected" };
  const state = {
    sessions: [{ id: "s1", mode: "plan" }], activeSessionId: "s1", runningSessions: {},
    pendingPlans: { s1: plan }, planCheckpoints: { s1: plan },
    resolvePlan: t.mock.fn(() => resolution.promise), sendPrompt: t.mock.fn(async () => accepts),
    showToast: t.mock.fn(),
  };
  const queue = createQueueSlice({ get: () => state });
  return {
    state, plan, resolution, sendPrompt: queue.sendPrompt,
    send: (draft, proposal = plan) => queue.sendPlanRevision(proposal, "Remove step two", draft),
    finishRejection(checkpoint = rejected) {
      state.planCheckpoints.s1 = checkpoint;
      delete state.pendingPlans.s1;
      resolution.resolve({ ok: true, state: "planning", proposal: rejected });
    },
  };
}

const draft = { text: "Remove step two", fileReferences: [{ path: "notes.txt", lineRange: { start: 2, end: 4 } }] };

test("sending twice rejects once and sends the original draft and references to the original session", async t => {
  const { state, send, sendPrompt, finishRejection } = fixture(t);
  const first = send(draft);
  assert.equal(await send(draft), false);
  assert.deepEqual(state.resolvePlan.mock.calls.map(call => call.arguments[0]), [
    { proposalId: "p1", sessionId: "s1", turnId: "t1", toolCallId: "c1", version: 1, action: "reject" },
  ]);
  delete state.pendingPlans.s1; // The host event can arrive before the resolution reply.
  assert.equal(await sendPrompt("Other text", undefined, "s1"), false);
  assert.equal(state.sendPrompt.mock.callCount(), 0);
  state.activeSessionId = "s2";
  finishRejection();
  assert.equal(await first, true);
  assert.deepEqual(state.sendPrompt.mock.calls[0].arguments, ["Remove step two", draft, "s1"]);
});

test("approval, checkpoint replacement, or rejection failure prevents revision delivery", async t => {
  for (const outcome of ["approved", "replaced", "failed"]) {
    const { state, plan, resolution, send, finishRejection } = fixture(t);
    const sending = send(draft);
    if (outcome === "replaced") finishRejection({ ...plan, id: "p2" });
    if (outcome === "failed") resolution.reject(new Error("unavailable"));
    if (outcome === "approved") resolution.resolve({ ok: true, state: "inactive",
      proposal: { ...plan, version: 2, status: "approved" } });
    assert.equal(await sending, false, outcome);
    assert.equal(state.sendPrompt.mock.callCount(), 0, outcome);
  }
});

test("delivery failure after rejection makes the submitted draft and its references available for retry", async t => {
  const { state, send, finishRejection } = fixture(t, { accepts: false });
  const restoreDraft = t.mock.fn();
  const sending = submitWithLatestDraftRestore("s1", () => send(draft), () => restoreDraft(draft));
  finishRejection();
  assert.equal(await sending, false);
  assert.equal(state.planCheckpoints.s1.status, "rejected");
  assert.deepEqual(restoreDraft.mock.calls.map(call => call.arguments), [[draft]]);
});

test("a finishing turn, stale revision, or disallowed attachment leaves the plan pending", async t => {
  const { state, plan, send } = fixture(t);
  state.runningSessions.s1 = true;
  assert.equal(await send(), false);
  state.runningSessions.s1 = false;
  assert.equal(await send(undefined, { ...plan, version: 0 }), false);
  state.sessions[0].capabilities = { canAttach: false };
  assert.equal(await send(draft), false);
  assert.equal(state.resolvePlan.mock.callCount(), 0);
});

test("only the current editable local Plan checkpoint can be revised", async t => {
  const { state, plan, send } = fixture(t);
  const session = state.sessions[0];
  assert.equal(pendingRevisionPlan(session, plan, plan), plan);
  for (const [target, checkpoint, pending] of [
    [undefined, plan, plan],
    [{ ...session, mode: "agent" }, plan, plan],
    [{ ...session, source: "pi-native" }, plan, plan],
    [{ ...session, source: "remote" }, plan, plan],
    [{ ...session, capabilities: { canPrompt: false } }, plan, plan],
    [session, { ...plan, kind: "goal" }, plan],
    [session, { ...plan, status: "approved" }, plan],
    [session, plan, undefined],
    [session, plan, { ...plan, id: "p2" }],
    [session, plan, { ...plan, version: 2 }],
  ]) {
    assert.equal(pendingRevisionPlan(target, checkpoint, pending), undefined);
    state.sessions = target ? [target] : [];
    state.planCheckpoints.s1 = checkpoint;
    state.pendingPlans.s1 = pending;
    assert.equal(await send(), false);
  }
  assert.equal(state.resolvePlan.mock.callCount(), 0);
});

test("a browser projection cannot revise the host's local Plan checkpoint", async t => {
  const { state, plan, send } = fixture(t);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true, value: { documentElement: { dataset: { webRemote: "true" } } },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  });
  assert.equal(pendingRevisionPlan(state.sessions[0], plan, plan), undefined);
  assert.equal(await send(), false);
  assert.equal(state.resolvePlan.mock.callCount(), 0);
});
