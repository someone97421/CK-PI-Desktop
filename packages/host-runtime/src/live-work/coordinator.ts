import { LiveWorkOperationLedger, type LiveWorkOperation } from "./operation-ledger.js";
import { parseLiveWorkIntent, type LiveWorkIntent } from "./intent.js";
import type { LiveWorkSelectionOption } from "@pi-desktop/shared";

export type WorkSnapshot = {
  sessionId: string;
  mode: "agent" | "plan" | "goal";
  state: "idle" | "running" | "waiting-permission" | "waiting-input" | "finalizing" | "unavailable";
  activeTurnId?: string;
  queue: Array<{ queueEntryId: string; position: number; summary: string }>;
  observedAt: number;
};

export type WorkAdmission =
  | { status: "started"; turnId: string }
  | { status: "queued"; queueEntryId: string }
  | { status: "steered"; turnId: string };

export interface LiveWorkPort {
  snapshot(sessionId: string): Promise<WorkSnapshot>;
  submit(input: { sessionId: string; text: string; userMessageId: string; voiceOrigin: { callId: string; operationId: string }; idempotencyKey: string }): Promise<WorkAdmission>;
  steer(input: { sessionId: string; expectedTurnId: string; text: string; userMessageId: string; voiceOrigin: { callId: string; operationId: string } }): Promise<{ accepted: boolean }>;
  enqueue(input: { sessionId: string; text: string; userMessageId: string; voiceOrigin: { callId: string; operationId: string }; idempotencyKey: string }): Promise<{ queueEntryId: string }>;
  stop(input: { callId: string; sessionId: string; expectedTurnId: string; urgency: "graceful" | "immediate" }): Promise<{ status: "requested" | "already-terminal" | "stale-target" | "unsupported" }>;
  cancelQueued(input: { callId: string; sessionId: string; queueEntryId: string }): Promise<{ status: "canceled" | "already-delivered" | "not-found" | "unknown" }>;
  listProjects(input: { callId: string; workBindingRevision: number; query?: string; action: "none" | "create" }): Promise<LiveWorkSelectionOption[]>;
  listSessions(input: { callId: string; workBindingRevision: number; query?: string }): Promise<LiveWorkSelectionOption[]>;
  openSelection(input: { callId: string; workBindingRevision: number; selectionRef: string }): Promise<{ status: "opened" | "ambiguous" | "expired" | "unavailable" }>;
}

export type LiveWorkCandidate = {
  callId: string;
  workBindingRevision: number;
  workSessionId: string;
  providerRequestId: string;
  instruction: string;
  observedTurnId?: string;
};

export type ProviderReceipt =
  | { status: "received"; operationId: string; providerRequestId: string; execution: "not_started" }
  | { status: "rejected"; providerRequestId: string; code: string };

export type LocalReceiptDelivery =
  | { status: "sent"; deliveryId: string }
  | { status: "not-sent" | "unknown"; deliveryId: string; code: string };

export type LiveWorkOperationUpdate = {
  operation: LiveWorkOperation;
  intent?: LiveWorkIntent;
  message?: string;
};

export type LiveWorkCoordinatorOptions = {
  resolveIntent: (input: {
    candidate: LiveWorkCandidate;
    snapshot: WorkSnapshot;
    recentOperations: Array<Pick<LiveWorkOperation, "operationId" | "instruction" | "admission" | "execution" | "selections">>;
  }) => Promise<unknown>;
  workPort: LiveWorkPort;
  onOperation?: (update: LiveWorkOperationUpdate) => void;
  onAnnouncementPolicy?: (input: { callId: string; policy: "normal" | "silent" }) => void;
  now?: () => number;
  classifyTimeoutMs?: number;
};

type CallState = {
  workSessionId: string;
  workBindingRevision: number;
  ledger: LiveWorkOperationLedger;
  tail: Promise<void>;
  closed: boolean;
  turnExecutions: Map<string, LiveWorkOperation["execution"]>;
};

/**
 * Bounded call-scoped admission and intent routing. It records and routes work
 * through the supplied DesktopWorkPort; it does not own an Agent runtime.
 */
export class LiveWorkCoordinator {
  private readonly calls = new Map<string, CallState>();
  private readonly now: () => number;
  private readonly classifyTimeoutMs: number;

  constructor(private readonly options: LiveWorkCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.classifyTimeoutMs = options.classifyTimeoutMs ?? 8_000;
  }

  openCall(input: { callId: string; workSessionId: string; workBindingRevision: number }): void {
    if (!input.callId || !input.workSessionId || !Number.isSafeInteger(input.workBindingRevision) || input.workBindingRevision < 1) {
      throw new Error("Live work scope is invalid");
    }
    this.calls.set(input.callId, {
      workSessionId: input.workSessionId,
      workBindingRevision: input.workBindingRevision,
      ledger: new LiveWorkOperationLedger(input),
      tail: Promise.resolve(),
      closed: false,
      turnExecutions: new Map(),
    });
  }

  async receiveCandidate(
    candidate: LiveWorkCandidate,
    deliverReceipt: (receipt: ProviderReceipt) => Promise<LocalReceiptDelivery>,
  ): Promise<void> {
    const call = this.calls.get(candidate.callId);
    if (!call || call.closed || call.workBindingRevision !== candidate.workBindingRevision || call.workSessionId !== candidate.workSessionId) {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_NOT_BOUND" });
      return;
    }
    const registered = call.ledger.registerCandidate(candidate.providerRequestId, candidate.instruction);
    if (registered.status === "replayed") {
      return;
    }
    if (registered.status === "conflict") {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_REQUEST_CONFLICT" });
      return;
    }
    if (registered.status === "capacity") {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_CAPACITY_EXCEEDED" });
      return;
    }
    if (registered.status === "invalid") {
      await deliverReceipt({ status: "rejected", providerRequestId: candidate.providerRequestId, code: "LIVE_WORK_INVALID_REQUEST" });
      return;
    }

    const operation = registered.operation;
    call.ledger.update(candidate.providerRequestId, { admission: "reviewing" });
    this.publish(call, candidate.providerRequestId);
    let localReceipt: LocalReceiptDelivery;
    try {
      localReceipt = await deliverReceipt({
        status: "received",
        operationId: operation.operationId,
        providerRequestId: candidate.providerRequestId,
        execution: "not_started",
      });
    } catch {
      localReceipt = { status: "unknown", deliveryId: operation.operationId, code: "LIVE_WORK_FEEDBACK_UNDELIVERED" };
    }
    if (localReceipt.status !== "sent") {
      call.ledger.update(candidate.providerRequestId, {
        admission: localReceipt.status === "unknown" ? "unknown" : "rejected",
      });
      this.publish(call, candidate.providerRequestId, "The receipt could not be delivered; no work was dispatched.");
      return;
    }

    const ordered = call.tail.then(() => this.classifyAndRoute(call, candidate));
    call.tail = ordered.catch(() => undefined);
    await ordered;
  }

  closeCall(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.closed = true;
    for (const operation of call.ledger.values()) {
      if (operation.admission === "received" || operation.admission === "reviewing" || operation.admission === "dispatching") {
        call.ledger.update(operation.providerRequestId, { admission: "withdrawn" });
        this.publish(call, operation.providerRequestId);
      }
    }
    this.calls.delete(callId);
  }

  getOperation(callId: string, operationId: string): LiveWorkOperation | undefined {
    return this.calls.get(callId)?.ledger.getByOperationId(operationId);
  }

  listOperations(callId: string): LiveWorkOperation[] {
    return this.calls.get(callId)?.ledger.values() ?? [];
  }

  findOperationByTurn(input: { sessionId: string; turnId: string; idempotencyKey?: string }): { callId: string; operationId: string } | undefined {
    for (const [callId, call] of this.calls) {
      if (call.workSessionId !== input.sessionId) continue;
      const operation = call.ledger.values().find((candidate) =>
        candidate.workSessionId === input.sessionId &&
        (matchesTurn(candidate, input.turnId, input.idempotencyKey) || candidate.turnId === input.turnId),
      );
      if (operation) return { callId, operationId: operation.operationId };
    }
    return undefined;
  }

  reportTurnResult(input: { callId: string; operationId: string; summary: string }): void {
    const call = this.calls.get(input.callId);
    const operation = call?.ledger.getByOperationId(input.operationId);
    if (!call || !operation || operation.workSessionId !== call.workSessionId) return;
    call.ledger.update(operation.providerRequestId, {
      summary: input.summary.slice(0, 480),
      resultSummary: input.summary.slice(0, 480),
    });
    this.publish(call, operation.providerRequestId, input.summary.slice(0, 480));
  }

  reportTurnTerminal(input: {
    sessionId: string;
    runtimeTurnId: string;
    turnId: string;
    idempotencyKey?: string;
    status: "completed" | "failed" | "interrupted" | "canceled";
  }): void {
    const execution = input.status === "completed"
      ? "completed"
      : input.status === "failed"
        ? "failed"
        : input.status === "interrupted"
          ? "interrupted"
          : "canceled";
    for (const call of this.calls.values()) {
      if (call.workSessionId !== input.sessionId) continue;
      rememberExecution(call, input.runtimeTurnId, execution, input.idempotencyKey);
      rememberExecution(call, input.turnId, execution, input.idempotencyKey);
    }
    for (const call of this.calls.values()) {
      for (const operation of call.ledger.values()) {
        if (
          operation.workSessionId !== input.sessionId ||
          (!matchesTurn(operation, input.runtimeTurnId, input.idempotencyKey) &&
            !matchesTurn(operation, input.turnId, input.idempotencyKey)) ||
          !isInFlight(operation.execution)
        ) continue;
        rememberExecution(call, operation.queueEntryId ?? input.turnId, execution, voiceIdempotencyKey(operation.callId, operation.operationId));
        call.ledger.update(operation.providerRequestId, { execution });
        this.publish(call, operation.providerRequestId);
      }
    }
  }

  /** 队列投递完成后，继续跟踪实际接收引导的执行轮次。 */
  reportQueueTransferred(input: { sessionId: string; queueEntryId: string; turnId: string; idempotencyKey?: string }): void {
    for (const call of this.calls.values()) {
      if (call.workSessionId !== input.sessionId) continue;
      for (const operation of call.ledger.values()) {
        if (!matchesTurn(operation, input.queueEntryId, input.idempotencyKey)) continue;
        const execution = call.turnExecutions.get(input.turnId) ?? "running";
        rememberExecution(call, input.queueEntryId, execution, input.idempotencyKey);
        call.ledger.update(operation.providerRequestId, { turnId: input.turnId, execution });
        this.publish(call, operation.providerRequestId);
      }
    }
  }

  reportTurnStarted(input: { sessionId: string; turnId: string; idempotencyKey?: string }): void {
    for (const call of this.calls.values()) {
      if (call.workSessionId === input.sessionId) rememberExecution(call, input.turnId, "running", input.idempotencyKey);
    }
    this.updateMatchingTurn(input.sessionId, input.turnId, "running", input.idempotencyKey);
  }

  reportTurnWaiting(input: { sessionId: string; turnId: string; state: "waiting-permission" | "waiting-input"; idempotencyKey?: string }): void {
    for (const call of this.calls.values()) {
      if (call.workSessionId === input.sessionId) rememberExecution(call, input.turnId, input.state, input.idempotencyKey);
    }
    this.updateMatchingTurn(input.sessionId, input.turnId, input.state, input.idempotencyKey);
  }

  private async classifyAndRoute(call: CallState, candidate: LiveWorkCandidate): Promise<void> {
    const operation = call.ledger.get(candidate.providerRequestId);
    if (!operation || call.closed) return;
    let initial: WorkSnapshot;
    try {
      initial = await this.options.workPort.snapshot(candidate.workSessionId);
    } catch {
      this.reject(call, candidate.providerRequestId, "The bound work session is unavailable.");
      return;
    }
    if (initial.sessionId !== candidate.workSessionId || initial.state === "unavailable") {
      this.reject(call, candidate.providerRequestId, "The bound work session is unavailable.");
      return;
    }
    candidate = {
      ...candidate,
      ...(!candidate.observedTurnId && initial.activeTurnId ? { observedTurnId: initial.activeTurnId } : {}),
    };
    const recentOperations = call.ledger.values()
      .filter((item) => item.providerRequestId !== candidate.providerRequestId)
      .slice(-8)
      .map(({ operationId, instruction, admission, execution, selections }) => ({ operationId, instruction, admission, execution, ...(selections ? { selections } : {}) }));
    const rawIntent = await this.withTimeout(
      this.options.resolveIntent({ candidate, snapshot: initial, recentOperations }),
      this.classifyTimeoutMs,
    ).catch(() => null);
    const intent = parseLiveWorkIntent(rawIntent);
    if (!intent) {
      call.ledger.update(candidate.providerRequestId, {
        intent: { kind: "clarify", question: "I could not confirm what you want me to do. Please clarify." },
      });
      this.reject(call, candidate.providerRequestId, "I could not confirm what you want me to do. Please clarify.");
      return;
    }
    if (call.closed) return;
    call.ledger.update(candidate.providerRequestId, { intent });
    if (intent.kind === "conversation") {
      this.acceptWithoutExecution(call, candidate.providerRequestId, "This is a Live conversation; no work was started.");
      return;
    }
    if (intent.kind === "clarify") {
      this.reject(call, candidate.providerRequestId, intent.question);
      return;
    }
    if (intent.kind === "speech-only") {
      this.options.onAnnouncementPolicy?.({ callId: candidate.callId, policy: intent.automaticAnnouncements });
      this.acceptWithoutExecution(call, candidate.providerRequestId, "Announcement preference updated for this call.");
      return;
    }
    if (intent.kind === "query-status" || intent.kind === "query-result" || intent.kind === "query-queue") {
      const fresh = await this.safeSnapshot(candidate.workSessionId);
      if (!fresh) {
        this.reject(call, candidate.providerRequestId, "The bound work session status is unavailable.");
        return;
      }
      if (intent.kind === "query-result") {
        const target = intent.operationRef
          ? call.ledger.getByOperationId(intent.operationRef)
          : [...call.ledger.values()].reverse().find((item) => isTerminalExecution(item.execution));
        if (intent.operationRef && !target) {
          this.reject(call, candidate.providerRequestId, "That work result is not available in this call.");
          return;
        }
        this.acceptWithoutExecution(call, candidate.providerRequestId, formatResult(target));
        return;
      }
      if (intent.kind === "query-status" && intent.operationRef) {
        const target = call.ledger.getByOperationId(intent.operationRef);
        if (!target) {
          this.reject(call, candidate.providerRequestId, "That work operation is not available in this call.");
          return;
        }
        this.acceptWithoutExecution(call, candidate.providerRequestId, formatOperationStatus(target));
        return;
      }
      this.acceptWithoutExecution(call, candidate.providerRequestId, formatStatus(fresh, intent));
      return;
    }
    if (intent.kind === "stop-current") {
      const fresh = await this.safeSnapshot(candidate.workSessionId);
      const expectedTurnId = candidate.observedTurnId;
      if (!fresh || !expectedTurnId || fresh.activeTurnId !== expectedTurnId || !isBusy(fresh.state)) {
        this.reject(call, candidate.providerRequestId, "The observed task has ended; nothing else was stopped.");
        return;
      }
      const result = await this.options.workPort.stop({ callId: candidate.callId, sessionId: candidate.workSessionId, expectedTurnId, urgency: intent.urgency }).catch(() => null);
      if (result?.status === "requested") this.accepted(call, candidate.providerRequestId, "Task stop requested.", expectedTurnId);
      else this.reject(call, candidate.providerRequestId, result?.status === "already-terminal" ? "The observed task has already ended." : "The stop request was not accepted.");
      return;
    }
    if (intent.kind === "cancel-queued") {
      const target = call.ledger.getByOperationId(intent.operationRef);
      if (!target?.queueEntryId) {
        this.reject(call, candidate.providerRequestId, "That queued operation is not available to cancel.");
        return;
      }
      const result = await this.options.workPort.cancelQueued({ callId: candidate.callId, sessionId: candidate.workSessionId, queueEntryId: target.queueEntryId }).catch(() => null);
      if (result?.status === "canceled") {
        call.ledger.update(target.providerRequestId, { execution: "canceled", admission: "withdrawn" });
        this.acceptWithoutExecution(call, candidate.providerRequestId, "Queued work was canceled.");
      } else this.reject(call, candidate.providerRequestId, "That queued operation has already been delivered or is unavailable.");
      return;
    }
    if (intent.kind === "list-projects" || intent.kind === "list-sessions") {
      const selections = intent.kind === "list-projects"
        ? await this.options.workPort.listProjects({
            callId: candidate.callId,
            workBindingRevision: candidate.workBindingRevision,
            ...(intent.query ? { query: intent.query } : {}),
            action: "none",
          })
        : await this.options.workPort.listSessions({
            callId: candidate.callId,
            workBindingRevision: candidate.workBindingRevision,
            ...(intent.query ? { query: intent.query } : {}),
          });
      call.ledger.update(candidate.providerRequestId, { selections });
      this.acceptWithoutExecution(call, candidate.providerRequestId, selections.length
        ? "I found matching projects or sessions. Choose an item in the Live panel to open or use it."
        : "No matching projects or sessions were found.");
      return;
    }
    if (intent.kind === "open-session") {
      const selection = call.ledger.values().flatMap((item) => item.selections ?? [])
        .find((item) => item.kind === "session" && item.selectionRef === intent.selectionRef);
      if (!selection) {
        this.reject(call, candidate.providerRequestId, "That session choice expired. Ask to list sessions again.");
        return;
      }
      if (selection.duplicateLabel) {
        this.reject(call, candidate.providerRequestId, "Several sessions have the same label. Choose the intended session in the Live panel.");
        return;
      }
      const result = await this.options.workPort.openSelection({
        callId: candidate.callId,
        workBindingRevision: candidate.workBindingRevision,
        selectionRef: intent.selectionRef,
      });
      if (result.status === "opened") this.acceptWithoutExecution(call, candidate.providerRequestId, "Opened the selected session. The work call remains bound to its original session.");
      else if (result.status === "ambiguous") this.reject(call, candidate.providerRequestId, "Several sessions have the same label. Choose the intended session in the Live panel.");
      else this.reject(call, candidate.providerRequestId, "That session choice expired or is no longer available. Ask to list sessions again.");
      return;
    }
    if (intent.kind === "create-session") {
      const availableProjects = call.ledger.values().flatMap((item) => item.selections ?? [])
        .filter((item) => item.kind === "project");
      const selectedProject = intent.projectRef
        ? availableProjects.find((item) => item.selectionRef === intent.projectRef)
        : undefined;
      const selections = selectedProject
        ? [{ ...selectedProject, action: "create" as const }]
        : await this.options.workPort.listProjects({
            callId: candidate.callId,
            workBindingRevision: candidate.workBindingRevision,
            action: "create",
          });
      call.ledger.update(candidate.providerRequestId, { selections });
      this.acceptWithoutExecution(call, candidate.providerRequestId, selections.length
        ? "Choose a registered project in the Live panel to create a session. This will not change the current work-call binding."
        : "No registered projects are available for a new session.");
      return;
    }

    const fresh = await this.safeSnapshot(candidate.workSessionId);
    if (!fresh || fresh.mode !== "agent" || fresh.state === "finalizing" || fresh.state === "unavailable") {
      this.reject(call, candidate.providerRequestId, "The selected work session cannot accept this request now.");
      return;
    }
    if (call.closed) return;
    call.ledger.update(candidate.providerRequestId, { admission: "dispatching" });
    this.publish(call, candidate.providerRequestId);
    try {
      if (intent.kind === "steer-current") {
        const expectedTurnId = candidate.observedTurnId;
        if (!expectedTurnId || fresh.activeTurnId !== expectedTurnId || !isBusy(fresh.state)) {
          this.reject(call, candidate.providerRequestId, "The observed task has ended; the addition was not sent.");
          return;
        }
        const result = await this.options.workPort.steer({
          sessionId: candidate.workSessionId,
          expectedTurnId,
          text: candidate.instruction,
          userMessageId: operation.userMessageId!,
          voiceOrigin: { callId: candidate.callId, operationId: operation.operationId },
        });
        if (!result.accepted) {
          this.reject(call, candidate.providerRequestId, "The observed task did not accept the addition.");
          return;
        }
        call.ledger.update(candidate.providerRequestId, {
          admission: "accepted",
          execution: rememberedExecution(call, expectedTurnId, voiceIdempotencyKey(candidate.callId, operation.operationId)) ?? "running",
          turnId: expectedTurnId,
        });
        this.publish(call, candidate.providerRequestId, "Addition delivered to the current task.");
        return;
      }
      const shouldQueue = intent.kind === "queue-task" || (intent.kind === "new-task" && isBusy(fresh.state) && intent.relationToActive === "independent");
      if (intent.kind === "new-task" && isBusy(fresh.state) && intent.relationToActive !== "independent") {
        this.reject(call, candidate.providerRequestId, "Should this be added to the current task or queued as separate work?");
        return;
      }
      if (shouldQueue) {
        const result = await this.options.workPort.enqueue({
          sessionId: candidate.workSessionId,
          text: candidate.instruction,
          userMessageId: operation.userMessageId!,
          voiceOrigin: { callId: candidate.callId, operationId: operation.operationId },
          idempotencyKey: `voice:${candidate.callId}:${operation.operationId}`,
        });
        call.ledger.update(candidate.providerRequestId, {
          admission: "accepted",
          execution: rememberedExecution(call, result.queueEntryId, voiceIdempotencyKey(candidate.callId, operation.operationId)) ?? "queued",
          queueEntryId: result.queueEntryId,
        });
        this.publish(call, candidate.providerRequestId, "Work accepted by the Host queue.");
        return;
      }
      const result = await this.options.workPort.submit({
        sessionId: candidate.workSessionId,
        text: candidate.instruction,
        userMessageId: operation.userMessageId!,
        voiceOrigin: { callId: candidate.callId, operationId: operation.operationId },
        idempotencyKey: `voice:${candidate.callId}:${operation.operationId}`,
      });
      call.ledger.update(candidate.providerRequestId, {
        admission: "accepted",
        execution: result.status === "queued"
          ? rememberedExecution(call, result.queueEntryId, voiceIdempotencyKey(candidate.callId, operation.operationId)) ?? "queued"
          : rememberedExecution(call, result.turnId, voiceIdempotencyKey(candidate.callId, operation.operationId)) ?? "running",
        ...(result.status === "queued" ? { queueEntryId: result.queueEntryId } : { turnId: result.turnId }),
      });
      this.publish(call, candidate.providerRequestId, result.status === "queued" ? "Work accepted by the Host queue." : "Work started in the bound session.");
    } catch {
      call.ledger.update(candidate.providerRequestId, { admission: "unknown", execution: "not-started" });
      this.publish(call, candidate.providerRequestId, "The admission result is unknown. Do not submit this operation again.");
    }
  }

  private async safeSnapshot(sessionId: string): Promise<WorkSnapshot | null> {
    try {
      const snapshot = await this.options.workPort.snapshot(sessionId);
      return snapshot.sessionId === sessionId && snapshot.state !== "unavailable" ? snapshot : null;
    } catch {
      return null;
    }
  }

  private acceptWithoutExecution(call: CallState, providerRequestId: string, message: string): void {
    call.ledger.update(providerRequestId, {
      admission: "accepted",
      execution: "not-started",
      summary: message.slice(0, 480),
    });
    this.publish(call, providerRequestId, message);
  }

  private accepted(call: CallState, providerRequestId: string, message: string, turnId?: string): void {
    call.ledger.update(providerRequestId, { admission: "accepted", execution: "running", ...(turnId ? { turnId } : {}) });
    this.publish(call, providerRequestId, message);
  }

  private reject(call: CallState, providerRequestId: string, message: string): void {
    call.ledger.update(providerRequestId, { admission: "rejected", execution: "not-started" });
    this.publish(call, providerRequestId, message);
  }

  private publish(call: CallState, providerRequestId: string, message?: string): void {
    if (message) {
      call.ledger.update(providerRequestId, { summary: message.slice(0, 480) });
    }
    const operation = call.ledger.get(providerRequestId);
    if (operation) this.options.onOperation?.({ operation, ...(operation.intent ? { intent: operation.intent } : {}), ...(message ? { message } : {}) });
  }

  private updateMatchingTurn(
    sessionId: string,
    turnId: string,
    execution: LiveWorkOperation["execution"],
    idempotencyKey?: string,
  ): void {
    for (const call of this.calls.values()) {
      if (call.workSessionId !== sessionId) continue;
      for (const operation of call.ledger.values()) {
        if (
          !matchesTurn(operation, turnId, idempotencyKey) ||
          !isInFlight(operation.execution)
        ) continue;
        call.ledger.update(operation.providerRequestId, { execution, turnId });
        this.publish(call, operation.providerRequestId);
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Live work intent timed out")), milliseconds);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
  }
}

function isBusy(state: WorkSnapshot["state"]): boolean {
  return state === "running" || state === "waiting-permission" || state === "waiting-input";
}

function isInFlight(execution: LiveWorkOperation["execution"]): boolean {
  return execution === "queued" || execution === "running" || execution === "waiting-permission" || execution === "waiting-input";
}

function matchesTurn(operation: LiveWorkOperation, turnId: string, idempotencyKey?: string): boolean {
  return operation.turnId === turnId || operation.queueEntryId === turnId ||
    (idempotencyKey !== undefined && idempotencyKey === voiceIdempotencyKey(operation.callId, operation.operationId));
}

function voiceIdempotencyKey(callId: string, operationId: string): string {
  return `voice:${callId}:${operationId}`;
}

function rememberExecution(
  call: CallState,
  turnId: string,
  execution: LiveWorkOperation["execution"],
  idempotencyKey?: string,
): void {
  const prior = call.turnExecutions.get(turnId);
  if (isTerminalExecution(prior) && !isTerminalExecution(execution)) return;
  call.turnExecutions.set(turnId, execution);
  if (idempotencyKey) {
    const idempotencyAlias = `idempotency:${idempotencyKey}`;
    const priorAlias = call.turnExecutions.get(idempotencyAlias);
    if (!isTerminalExecution(priorAlias) || isTerminalExecution(execution)) {
      call.turnExecutions.set(idempotencyAlias, execution);
    }
  }
  while (call.turnExecutions.size > 64) call.turnExecutions.delete(call.turnExecutions.keys().next().value as string);
}

function rememberedExecution(call: CallState, turnId: string, idempotencyKey: string): LiveWorkOperation["execution"] | undefined {
  return call.turnExecutions.get(`idempotency:${idempotencyKey}`) ?? call.turnExecutions.get(turnId);
}

function isTerminalExecution(execution: LiveWorkOperation["execution"] | undefined): boolean {
  return execution === "completed" || execution === "failed" || execution === "interrupted" || execution === "canceled";
}

function formatStatus(snapshot: WorkSnapshot, intent: LiveWorkIntent): string {
  if (intent.kind === "query-queue") {
    return snapshot.queue.length
      ? `There are ${snapshot.queue.length} queued work item${snapshot.queue.length === 1 ? "" : "s"}.`
      : "The Host work queue is empty.";
  }
  if (snapshot.state === "idle") return "The bound work session is idle.";
  if (snapshot.state === "running") return "The bound work session is running.";
  if (snapshot.state === "waiting-permission") return "The work session is waiting for a permission decision in the desktop UI.";
  if (snapshot.state === "waiting-input") return "The work session is waiting for input in the desktop UI.";
  return "The bound work session status is unavailable.";
}

function formatOperationStatus(operation: LiveWorkOperation): string {
  if (operation.execution === "queued") return "That work operation is queued.";
  if (operation.execution === "running") return "That work operation is running.";
  if (operation.execution === "waiting-permission") return "That work operation is waiting for a permission decision in the desktop UI.";
  if (operation.execution === "waiting-input") return "That work operation is waiting for input in the desktop UI.";
  if (isTerminalExecution(operation.execution)) return `That work operation is ${operation.execution}.`;
  if (operation.admission === "unknown") return "The admission result for that work operation is still unknown.";
  if (operation.admission === "rejected") return operation.summary ?? "That work operation was not accepted.";
  return "That work operation has not started.";
}

function formatResult(operation: LiveWorkOperation | undefined): string {
  if (!operation) return "No completed work result is recorded for this call.";
  if (!isTerminalExecution(operation.execution)) return "That work operation has not finished yet.";
  if (operation.summary) return operation.summary;
  if (operation.execution === "completed") return "The task ended. Detailed results are available in the bound work session.";
  if (operation.execution === "failed") return "The task failed. The work session contains the error details.";
  if (operation.execution === "interrupted") return "The task was interrupted. Review any completed changes in the work session.";
  return "The task was canceled. Review any completed changes in the work session.";
}
