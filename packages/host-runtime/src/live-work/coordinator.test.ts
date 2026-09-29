import { describe, expect, it } from "vitest";
import { LiveWorkCoordinator, type LiveWorkCandidate, type LiveWorkPort, type WorkSnapshot } from "./coordinator.js";
import { parseLiveWorkIntent } from "./intent.js";

function build(input: {
  intent: unknown;
  snapshot?: Partial<WorkSnapshot>;
  onSubmit?: (request: Parameters<LiveWorkPort["submit"]>[0]) => ReturnType<LiveWorkPort["submit"]>;
}): { coordinator: LiveWorkCoordinator; calls: string[]; snapshot: WorkSnapshot } {
  const calls: string[] = [];
  const snapshot: WorkSnapshot = {
    sessionId: "session-a",
    mode: "agent",
    state: "idle",
    queue: [],
    observedAt: 1,
    ...input.snapshot,
  };
  const workPort: LiveWorkPort = {
    snapshot: async (sessionId) => ({ ...snapshot, sessionId }),
    submit: async (request) => {
      calls.push(`submit:${request.text}:${request.userMessageId}`);
      if (input.onSubmit) return input.onSubmit(request);
      return { status: "started", turnId: "turn-1" };
    },
    steer: async (request) => {
      calls.push(`steer:${request.expectedTurnId}:${request.text}`);
      return { accepted: true };
    },
    enqueue: async (request) => {
      calls.push(`queue:${request.text}:${request.idempotencyKey}`);
      return { queueEntryId: "queue-1" };
    },
    stop: async (request) => {
      calls.push(`stop:${request.expectedTurnId}:${request.urgency}`);
      return { status: "requested" };
    },
    cancelQueued: async (request) => {
      calls.push(`cancel:${request.queueEntryId}`);
      return { status: "canceled" };
    },
    listProjects: async (request) => [{ selectionRef: "project-ref", kind: "project", action: request.action, label: "Demo" }],
    listSessions: async () => [{ selectionRef: "session-ref", kind: "session", action: "open", label: "Demo / Chat" }],
    openSelection: async () => ({ status: "opened" }),
  };
  let next = 0;
  const coordinator = new LiveWorkCoordinator({
    resolveIntent: async ({ candidate }) => typeof input.intent === "function"
      ? (input.intent as (candidate: LiveWorkCandidate) => unknown)(candidate)
      : input.intent,
    workPort,
    now: () => ++next,
    onOperation: ({ operation }) => calls.push(`state:${operation.admission}:${operation.execution}`),
  });
  coordinator.openCall({ callId: "call-1", workSessionId: "session-a", workBindingRevision: 2 });
  return { coordinator, calls, snapshot };
}

const candidate = {
  callId: "call-1",
  workBindingRevision: 2,
  workSessionId: "session-a",
  providerRequestId: "provider-1",
  instruction: "Inspect the login flow, and only fix a confirmed bug.",
};

describe("LiveWorkCoordinator", () => {
  it("delivers a received receipt before classifying and submits the original text once", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false } });
    const order: string[] = [];
    await subject.coordinator.receiveCandidate(candidate, async (receipt) => {
      order.push(`receipt:${receipt.status}`);
      return { status: "sent", deliveryId: "delivery-1" };
    });
    expect(order).toEqual(["receipt:received"]);
    expect(subject.calls).toContain(`submit:${candidate.instruction}:` + subject.coordinator.getOperation("call-1", subject.coordinator.listOperations("call-1")[0]!.operationId)?.userMessageId);
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({ admission: "accepted", execution: "running", turnId: "turn-1" });
  });

  it("does not dispatch if the local provider receipt was not sent", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false } });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "not-sent", deliveryId: "delivery-1", code: "closed" }));
    expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("uses the Host queue for an explicitly independent task while busy", async () => {
    const subject = build({
      intent: { kind: "new-task", relationToActive: "independent", explicitRepeat: false },
      snapshot: { state: "running", activeTurnId: "turn-current" },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("queue:"))).toBe(true);
    expect(subject.calls.some((call) => call.startsWith("steer:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({ admission: "accepted", execution: "queued", queueEntryId: "queue-1" });
  });

  it("keeps a terminal event that arrives before submit returns", async () => {
    let subject: ReturnType<typeof build>;
    subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      onSubmit: async (request) => {
        subject.coordinator.reportTurnTerminal({
          sessionId: "session-a",
          runtimeTurnId: "turn-early",
          turnId: "turn-early",
          idempotencyKey: request.idempotencyKey,
          status: "completed",
        });
        return { status: "started", turnId: "turn-early" };
      },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      admission: "accepted",
      execution: "completed",
      turnId: "turn-early",
    });
    const operation = subject.coordinator.listOperations("call-1")[0]!;
    expect(subject.coordinator.findOperationByTurn({ sessionId: "session-a", turnId: "turn-early" })).toEqual({
      callId: "call-1",
      operationId: operation.operationId,
    });
    subject.coordinator.reportTurnResult({ callId: "call-1", operationId: operation.operationId, summary: "Updated the login validation." });
    expect(subject.coordinator.getOperation("call-1", operation.operationId)?.summary).toBe("Updated the login validation.");
  });

  it("answers a result query from the recorded operation without starting another turn", async () => {
    const subject = build({
      intent: (request: typeof candidate) => request.providerRequestId === "provider-query"
        ? { kind: "query-result" }
        : { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    const original = subject.coordinator.listOperations("call-1")[0]!;
    subject.coordinator.reportTurnTerminal({
      sessionId: "session-a",
      runtimeTurnId: original.turnId!,
      turnId: original.turnId!,
      status: "completed",
    });
    subject.coordinator.reportTurnResult({
      callId: "call-1",
      operationId: original.operationId,
      summary: "Updated the login validation.",
    });

    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-query", instruction: "What did the task change?" }, async () => ({ status: "sent", deliveryId: "delivery-2" }));

    const query = subject.coordinator.listOperations("call-1")[1]!;
    expect(query).toMatchObject({ admission: "accepted", execution: "not-started", summary: "Updated the login validation." });
    expect(subject.calls.filter((call) => call.startsWith("submit:"))).toHaveLength(1);
  });

  it("asks for clarification when a busy new task has no explicit relationship", async () => {
    const subject = build({
      intent: { kind: "new-task", relationToActive: "unspecified", explicitRepeat: false },
      snapshot: { state: "running", activeTurnId: "turn-current" },
    });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:") || call.startsWith("steer:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("rejects a stale steer without falling back to prompt or queue", async () => {
    const subject = build({ intent: { kind: "steer-current" }, snapshot: { state: "running", activeTurnId: "turn-new" } });
    await subject.coordinator.receiveCandidate({ ...candidate, observedTurnId: "turn-old" }, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:") || call.startsWith("steer:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.admission).toBe("rejected");
  });

  it("deduplicates the same provider request and rejects parameter conflicts", async () => {
    const subject = build({ intent: { kind: "conversation" } });
    let deliveries = 0;
    const deliver = async () => {
      deliveries += 1;
      return { status: "sent" as const, deliveryId: `delivery-${deliveries}` };
    };
    await subject.coordinator.receiveCandidate(candidate, deliver);
    await subject.coordinator.receiveCandidate(candidate, deliver);
    await subject.coordinator.receiveCandidate({ ...candidate, instruction: "a different request" }, deliver);
    expect(subject.coordinator.listOperations("call-1")).toHaveLength(1);
    expect(deliveries).toBe(2);
  });

  it("fails closed on malformed classifier output and validates exact intent fields", async () => {
    const subject = build({ intent: { kind: "new-task", relationToActive: "independent", explicitRepeat: false, sessionId: "elsewhere" } });
    await subject.coordinator.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery-1" }));
    expect(subject.calls.some((call) => call.startsWith("submit:") || call.startsWith("queue:"))).toBe(false);
    expect(subject.coordinator.listOperations("call-1")[0]?.summary).toBe("I could not confirm what you want me to do. Please clarify.");
    expect(parseLiveWorkIntent({ kind: "stop-current", urgency: "immediate", turnId: "turn-1" })).toBeNull();
    expect(parseLiveWorkIntent({ kind: "stop-current", urgency: "immediate" })).toEqual({ kind: "stop-current", urgency: "immediate" });
  });

  it("does not dispatch a classifier result after the work call closes", async () => {
    let release: ((value: unknown) => void) | undefined;
    let resolverStarted: (() => void) | undefined;
    let submitted = false;
    const started = new Promise<void>((resolve) => { resolverStarted = resolve; });
    const delayed = new LiveWorkCoordinator({
      resolveIntent: () => new Promise((resolve) => { release = resolve; resolverStarted?.(); }),
      workPort: {
        snapshot: async (sessionId) => ({ sessionId, mode: "agent", state: "idle", queue: [], observedAt: 1 }),
        submit: async () => { submitted = true; throw new Error("must not dispatch"); },
        steer: async () => ({ accepted: false }),
        enqueue: async () => ({ queueEntryId: "queue" }),
        stop: async () => ({ status: "unsupported" }),
        cancelQueued: async () => ({ status: "not-found" }),
        listProjects: async () => [],
        listSessions: async () => [],
        openSelection: async () => ({ status: "expired" }),
      },
    });
    delayed.openCall({ callId: "call-1", workSessionId: "session-a", workBindingRevision: 2 });
    const running = delayed.receiveCandidate(candidate, async () => ({ status: "sent", deliveryId: "delivery" }));
    await started;
    delayed.closeCall("call-1");
    release?.({ kind: "new-task", relationToActive: "unspecified", explicitRepeat: false });
    await running;
    expect(submitted).toBe(false);
    expect(delayed.listOperations("call-1")).toEqual([]);
    expect(delayed.findOperationByTurn({ sessionId: "session-a", turnId: "late-turn" })).toBeUndefined();
  });

  it("lists session choices and opens only a call-scoped selection reference", async () => {
    let selectedRef = "";
    const subject = build({
      intent: (request: typeof candidate) => request.providerRequestId === "provider-list"
        ? { kind: "list-sessions" }
        : { kind: "open-session", selectionRef: selectedRef },
    });
    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-list" }, async () => ({ status: "sent", deliveryId: "receipt-list" }));
    const listing = subject.coordinator.listOperations("call-1")[0]!;
    selectedRef = listing.selections?.[0]?.selectionRef ?? "";
    expect(listing.selections).toEqual([{ selectionRef: "session-ref", kind: "session", action: "open", label: "Demo / Chat" }]);

    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-open" }, async () => ({ status: "sent", deliveryId: "receipt-open" }));
    expect(subject.coordinator.listOperations("call-1")[1]).toMatchObject({ admission: "accepted", summary: expect.stringContaining("remains bound") });
    expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });

  it("creates only a project choice and keeps the active call's bound session unchanged", async () => {
    const subject = build({ intent: { kind: "create-session" } });
    await subject.coordinator.receiveCandidate({ ...candidate, providerRequestId: "provider-create" }, async () => ({ status: "sent", deliveryId: "receipt-create" }));
    expect(subject.coordinator.listOperations("call-1")[0]).toMatchObject({
      workSessionId: "session-a",
      selections: [{ selectionRef: "project-ref", kind: "project", action: "create", label: "Demo" }],
    });
    expect(subject.calls.some((call) => call.startsWith("submit:"))).toBe(false);
  });
});
