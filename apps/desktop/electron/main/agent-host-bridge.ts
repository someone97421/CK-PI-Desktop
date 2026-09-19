import {
  AgentHost,
  RacpError,
  type ApprovalPort,
  type Principal,
  type QueueEntryView,
  type RuntimePort,
  type TurnStartRequest,
  type TurnSteerRequest,
} from "@pi-desktop/agent-host";
import {
  createHostQueueStore,
  createHostSessionPort,
  listPendingToolRequests,
} from "@pi-desktop/host-runtime";
import type {
  AgentEventEnvelope,
  AgentQueueChangedEvent,
  AgentQueuePushRequest,
  AgentQueueSteerRequest,
  AskToolResolution,
  QueuedTurnSummary,
  RacpApprovalResult,
  RacpPermissionMode,
} from "@pi-desktop/shared";
import { IPC, isGlobalPermissionMode } from "@pi-desktop/shared";
import type { QueuedSteeringJournal } from "./queued-steering-receipts";

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;

// Main-process only: a renderer cannot serialize this token over Electron IPC.
export const QUEUED_STEERING_DURABILITY = Symbol("queued-steering-durability");

type HostLike = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export type AgentHostBridgeOptions = {
  invoke: IpcInvoke;
  channels: typeof IPC.invoke;
  getHost: () => HostLike | null;
  /** Runtime-side busy state the event stream cannot see (active turn map,
   * manual compaction). */
  isSessionBusy?: (sessionId: string) => boolean;
  /** Renderer fan-out for queue changes (`agent/event/queueChanged`). */
  onQueueChange?: (event: AgentQueueChangedEvent) => void;
  /**
   * One approval (tool, Plan or Goal) was decided, wherever the decision came
   * from. The state itself stays in the Agent Host; this is only the "re-read
   * it" signal for the clients that mirror it, so a second device stops
   * showing an approval that is already gone.
   */
  onApprovalResolved?: (event: { sessionId: string; approvalId: string }) => void;
  /** The same signal for an Ask-tool question that was answered. */
  onInputResolved?: (event: { sessionId: string; inputId: string }) => void;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  /**
   * Durable journal for queue-entry steering. Optional: without it a transfer
   * is protected only inside the live process.
   */
  steeringJournal?: QueuedSteeringJournal;
};

/** The local desktop: the SSH-paired owner device of its own Host. */
export const DESKTOP_PRINCIPAL: Principal = {
  subject: "desktop",
  roles: ["owner"],
  pairedDevice: true,
};

/**
 * Electron Main's adapter around the headless Agent Host module (rollout R1,
 * D374/D375). The module wraps the existing registered IPC handlers through
 * `invokeIpc` rather than the renderer, `host.proxy`, or host-core RPC, so the
 * local permission and persistence behavior is reused unchanged. Later steps
 * move handler logic into the module; the wire contract does not change.
 */
export function createAgentHostBridge(options: AgentHostBridgeOptions) {
  const abortingSessions = new Set<string>();
  const resolvingViaModule = new Set<string>();

  const requireHost = (): HostLike => {
    const host = options.getHost();
    if (!host) throw new RacpError("AGENT_UNAVAILABLE", "host is not running", { retriable: true });
    return host;
  };

  const runtime: RuntimePort = {
    async prompt(request: TurnStartRequest) {
      try {
        const summary = await sessions.get(request.sessionId);
        // A per-turn ceiling that differs from the session's stored mode is
        // refused. `agent.prompt`'s `permissionMode` override is not yet
        // enforced — the sidecar records nothing and host-core `session.beginTurn`
        // has no per-turn override — so a narrower ceiling would silently run at
        // the session's stored mode (e.g. a remote viewer capped at `ask`
        // starting a turn in an `auto` session). Until the enforcement gate
        // exists, any mismatch fails closed.
        if (
          summary &&
          summary.permissionMode !== request.effectivePermissionMode
        ) {
          throw new RacpError(
            "FORBIDDEN",
            "the local runtime cannot apply a per-turn permission ceiling yet",
            {
              details: {
                sessionPermissionMode: summary.permissionMode,
                effectivePermissionMode: request.effectivePermissionMode,
              },
            },
          );
        }
        const result = (await options.invoke(options.channels.agentPrompt, [
          {
            sessionId: request.sessionId,
            content: request.content,
            ...(request.sessionMessageId ? { sessionMessageId: request.sessionMessageId } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
          },
        ])) as { accepted?: boolean; turnId: string };
        return { turnId: result.turnId };
      } catch (error) {
        if (request.sessionMessageId) {
          try {
            await requireHost().call("session.collaboration.fail", {
              messageId: request.sessionMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch (persistenceError) {
            options.log("warn", "collaboration dispatch failure persistence failed", {
              sessionId: request.sessionId,
              messageId: request.sessionMessageId,
              error: String(persistenceError),
            });
          }
        }
        throw error;
      }
    },
    /**
     * Deliver one more user message into a running turn (`send now` keeps the
     * promoted messages adjacent). This is the same channel the Composer's
     * Alt+Enter uses, so admission, attachments, and persistence are unchanged.
     */
    async steer(request: TurnSteerRequest) {
      try {
        const result = (await options.invoke(options.channels.agentSteer, [
          {
            sessionId: request.sessionId,
            expectedTurnId: request.turnId,
            content: request.content,
            ...(request.sessionMessageId ? { messageId: request.sessionMessageId } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
          },
          QUEUED_STEERING_DURABILITY,
          request.queuedTurnId,
        ])) as { accepted?: boolean; turnId?: string } | undefined;
        return {
          accepted: result?.accepted === true,
          ...(result?.turnId ? { turnId: result.turnId } : {}),
        };
      } catch (error) {
        // A queue transfer must be able to tell "the runtime proved it never
        // accepted this input" (`steeringRejected` releases the entry) from an
        // unknown outcome (which quarantines it). Swallowing the failure here
        // would make an unknown result look like a release.
        options.log("warn", "agent host steer failed", {
          sessionId: request.sessionId,
          turnId: request.turnId,
          error: String(error),
        });
        throw error;
      }
    },
    async stop(sessionId: string) {
      const result = (await options.invoke(options.channels.agentStop, [{ sessionId }])) as
        | { requested?: boolean }
        | undefined;
      return { requested: result?.requested ?? true };
    },
    async abort(sessionId: string, turnId?: string) {
      abortingSessions.add(sessionId);
      try {
        await options.invoke(options.channels.agentAbort, [{ sessionId, ...(turnId ? { turnId } : {}) }]);
      } catch (error) {
        abortingSessions.delete(sessionId);
        throw error;
      }
    },
    async respondInput(resolution: AskToolResolution) {
      await options.invoke(options.channels.askToolResolve, [resolution]);
    },
    // Durable side of the queue transfer journal (see `queued-steering-receipts`).
    async steeringReceipts() {
      return (await options.steeringJournal?.list()) ?? [];
    },
    async settleSteeringReceipt(queuedTurnId: string) {
      await options.steeringJournal?.settle(queuedTurnId);
    },
    async completeSteeringReceipt(queuedTurnId: string) {
      await options.steeringJournal?.complete(queuedTurnId);
    },
    isBusy(sessionId: string) {
      return options.isSessionBusy?.(sessionId) ?? false;
    },
  };

  const approvals: ApprovalPort = {
    async resolveTool(requestId, decision) {
      resolvingViaModule.add(requestId);
      try {
        await options.invoke(options.channels.toolResolvePermission, [{ requestId, decision }]);
      } finally {
        resolvingViaModule.delete(requestId);
      }
    },
    async resolveContract(input) {
      // The plans.resolve handler needs the submitting turn and tool call,
      // which only the host's pending proposal row carries.
      const host = requireHost();
      const pending = await host.call<{ plans?: Array<{ id: string; turnId?: string; toolCallId?: string }> }>(
        "plans.pending",
        { sessionId: input.sessionId },
      );
      const proposal = (pending.plans ?? []).find((candidate) => candidate.id === input.proposalId);
      if (!proposal) throw new RacpError("NOT_FOUND", `proposal ${input.proposalId} is not pending`);
      resolvingViaModule.add(input.proposalId);
      try {
        await options.invoke(options.channels.plansResolve, [
          {
            proposalId: input.proposalId,
            sessionId: input.sessionId,
            turnId: proposal.turnId ?? "",
            toolCallId: proposal.toolCallId ?? "",
            action: input.action,
            ...(input.version !== undefined ? { version: input.version } : {}),
            ...(input.permissionMode ? { targetPermissionMode: input.permissionMode } : {}),
          },
        ]);
      } finally {
        resolvingViaModule.delete(input.proposalId);
      }
    },
    listPendingTools: (sessionId) => listPendingToolRequests(options.getHost, sessionId),
  };

  // Session reads and the persisted turn queue (schema v15, ADR 0213) go
  // straight to host-core; the same ports serve the headless Host.
  const sessions = createHostSessionPort(options.getHost);
  const queueStore = createHostQueueStore(options.getHost);

  const agentHost = new AgentHost({
    runtime,
    sessions,
    approvals,
    queueStore,
    onQueueChange: (sessionId, entries) => {
      options.onQueueChange?.({ sessionId, entries: entries.map(toQueueSummary) });
    },
  });

  function sessionOfApproval(approvalId: string): string | undefined {
    return agentHost.approvals.get(approvalId)?.sessionId;
  }

  function notifyApprovalResolved(sessionId: string | undefined, approvalId: string): void {
    if (!sessionId) return;
    try {
      options.onApprovalResolved?.({ sessionId, approvalId });
    } catch (error) {
      options.log("warn", "approval-resolved notification failed", { sessionId, approvalId, error: String(error) });
    }
  }

  /** The desktop's queue operations, all under the owner principal. */
  const queue = {
    /**
     * "Send now" on one durable queue entry while the session runs: the Host
     * delivers it into the live turn and removes it only after the runtime
     * acknowledged the input.
     */
    async steer(request: AgentQueueSteerRequest) {
      return forIpc(() => agentHost.steerQueuedTurn(DESKTOP_PRINCIPAL, request));
    },
    async push(request: AgentQueuePushRequest): Promise<QueuedTurnSummary> {
      const result = await forIpc(() =>
        agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: request.sessionId,
          admission: "queue",
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
          input: {
            text: request.content,
            ...(request.sessionMessageId ? { sessionMessageId: request.sessionMessageId } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
          },
          context: { requestId: `desktop-queue-${Date.now().toString(36)}` },
        }),
      );
      const entry = agentHost.queueEntries(request.sessionId).find((candidate) => candidate.turn.id === result.turn.id);
      return entry
        ? toQueueSummary(entry)
        : {
            id: result.turn.id,
            sessionId: request.sessionId,
            content: request.content,
            ...(request.sessionMessageId ? { sessionMessageId: request.sessionMessageId } : {}),
            ...(request.attachments ? { attachments: request.attachments } : {}),
            position: 0,
            createdAt: new Date().toISOString(),
          };
    },
    list(sessionId: string): QueuedTurnSummary[] {
      return agentHost.queueEntries(sessionId).map(toQueueSummary);
    },
    async remove(turnId: string): Promise<void> {
      const turn = agentHost.getTurn(turnId);
      const entry = agentHost.queueEntries(turn.sessionId).find((candidate) => candidate.turn.id === turnId);
      if (entry?.sessionMessageId) {
        await requireHost().call("session.collaboration.cancel", {
          sessionId: turn.sessionId,
          messageId: entry.sessionMessageId,
        });
      }
      await forIpc(() => agentHost.cancelTurn(DESKTOP_PRINCIPAL, turnId));
    },
    async cancelSessionMessage(sessionId: string, messageId: string): Promise<boolean> {
      return forIpc(() => agentHost.cancelSessionMessage(DESKTOP_PRINCIPAL, sessionId, messageId));
    },
    async prioritize(turnId: string): Promise<void> {
      await forIpc(() => agentHost.prioritizeTurn(DESKTOP_PRINCIPAL, turnId));
    },
    async reorder(
      turnId: string,
      direction: "up" | "down",
    ): Promise<{ moved: boolean }> {
      return forIpc(() => agentHost.reorderTurn(DESKTOP_PRINCIPAL, turnId, direction));
    },
  };

  return {
    agentHost,
    queue,
    /** A ledger stores the actual durable turn, which can differ from a queue ID. */
    async interruptSessionMessage(sessionId: string, turnId: string): Promise<boolean> {
      const result = await options.invoke(options.channels.agentAbort, [{ sessionId, turnId }]) as { aborted?: boolean } | undefined;
      return result?.aborted !== false;
    },
    /** Feed one normalized runtime event; `agent_end` after an abort is `turn.interrupted`. */
    ingest(envelope: AgentEventEnvelope): void {
      const interrupted =
        envelope.event.type === "agent_end" && abortingSessions.has(envelope.sessionId);
      if (envelope.event.type === "agent_end" || envelope.event.type === "error") {
        abortingSessions.delete(envelope.sessionId);
      }
      try {
        agentHost.ingest(envelope, { interrupted });
      } catch (error) {
        options.log("warn", "agent host ingest failed", {
          sessionId: envelope.sessionId,
          type: envelope.event.type,
          error: String(error),
        });
      }
    },
    /** The desktop card or an IPC caller settled an approval outside the module. */
    settleApproval(
      approvalId: string,
      outcome: { decision?: RacpApprovalResult["decision"]; permissionMode?: string },
    ): void {
      // The session is read before the settle: afterwards the approval is gone
      // from the pending set, and the notification still has to name it.
      const sessionId = sessionOfApproval(approvalId);
      if (resolvingViaModule.has(approvalId)) {
        // A Remote Agent caller resolved this through the IPC channel; the
        // module's own bookkeeping already ran, so only the redundant settle is
        // skipped. Other clients still need the decision.
        notifyApprovalResolved(sessionId, approvalId);
        return;
      }
      const permissionMode = isGlobalPermissionMode(outcome.permissionMode)
        ? (outcome.permissionMode as RacpPermissionMode)
        : undefined;
      try {
        agentHost.settleApprovalExternally(approvalId, {
          ...(outcome.decision ? { decision: outcome.decision } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        });
      } catch (error) {
        options.log("warn", "agent host settle failed", { approvalId, error: String(error) });
      }
      notifyApprovalResolved(sessionId, approvalId);
    },
    /**
     * One Ask-tool question was answered (or skipped). The IPC handler that
     * owns `asktool.resolve` calls this: the answer travels to the sidecar, and
     * the session-scoped subscribers are told to re-read the pending set so a
     * second device does not keep asking a question that is gone.
     */
    notifyInputResolved(event: { sessionId: string; inputId: string }): void {
      const sessionId = String(event?.sessionId ?? "").trim();
      const inputId = String(event?.inputId ?? "").trim();
      if (!sessionId || !inputId) return;
      try {
        agentHost.settleInputExternally(sessionId, inputId);
        options.onInputResolved?.({ sessionId, inputId });
      } catch (error) {
        options.log("warn", "input-resolved notification failed", {
          sessionId,
          inputId,
          error: String(error),
        });
      }
    },
    /**
     * The runtime settled one turn. Main is authoritative here: a real abort can
     * lose its terminal event (`isStaleTerminalEvent` drops a terminal event for
     * a turn main no longer owns, and the runtime need not emit one), and a turn
     * left active in the Host would hold the queue forever.
     */
    endTurn(
      sessionId: string,
      turnId: string,
      status: "completed" | "failed" | "interrupted" | "canceled",
      error?: { code: string; message: string; retriable: boolean; traceId: string },
    ): void {
      abortingSessions.delete(sessionId);
      try {
        agentHost.endTurn(sessionId, turnId, status, error ? { error } : {});
      } catch (error_) {
        options.log("warn", "agent host end turn failed", {
          sessionId,
          turnId,
          status,
          error: String(error_),
        });
      }
    },
    markAborting(sessionId: string): void {
      abortingSessions.add(sessionId);
    },
  };
}

export type AgentHostBridge = ReturnType<typeof createAgentHostBridge>;

/** Surface a module error through the IPC error contract (`errorCode`). */
async function forIpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RacpError) {
      throw Object.assign(new Error(error.message), {
        errorCode: error.code,
        details: error.details,
      });
    }
    throw error;
  }
}

function toQueueSummary(entry: QueueEntryView): QueuedTurnSummary {
  return {
    id: entry.turn.id,
    sessionId: entry.turn.sessionId,
    content: entry.content,
    ...(entry.sessionMessageId ? { sessionMessageId: entry.sessionMessageId } : {}),
    ...(entry.attachments ? { attachments: entry.attachments } : {}),
    position: entry.turn.queuePosition ?? 0,
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    createdAt: entry.turn.startedAt ?? new Date().toISOString(),
  };
}
