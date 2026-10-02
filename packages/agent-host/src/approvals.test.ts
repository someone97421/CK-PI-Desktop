import { describe, expect, it } from "vitest";
import type { PlanningStateEvent, ToolPermissionRequest } from "@pi-desktop/shared";

import { ApprovalBroker, type ApprovalPort, type PendingToolRequest } from "./approvals.js";
import type { Clock } from "./ports.js";

class FixedClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
}

class FakeApprovalPort implements ApprovalPort {
  tool: Array<{ requestId: string; decision: string }> = [];
  contract: Array<Record<string, unknown>> = [];
  pending: PendingToolRequest[] = [];
  async resolveTool(requestId: string, decision: "allow-once" | "allow-session" | "deny"): Promise<void> {
    this.tool.push({ requestId, decision });
  }
  async resolveContract(input: Record<string, unknown>): Promise<void> {
    this.contract.push(input);
  }
  async listPendingTools(): Promise<PendingToolRequest[]> {
    return this.pending;
  }
}

const toolRequest: ToolPermissionRequest = {
  requestId: "req_1",
  sessionId: "s1",
  toolCallId: "call_1",
  toolName: "Bash",
  argsPreview: { command: "ls" },
  risk: "high",
  reason: "high risk",
};

const principal = { subject: "user", roles: ["approver" as const] };

describe("ApprovalBroker", () => {
  it("offers the local tool vocabulary and resolves once", async () => {
    const port = new FakeApprovalPort();
    const clock = new FixedClock();
    const broker = new ApprovalBroker(port, clock);
    const request = broker.fromToolPermission(toolRequest, { turnId: "t1", revision: 3, lifetimeMs: 1_000, allowSession: false });
    expect(request.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(request.summary).toBe("Bash: high risk");
    expect(request.expiresAt).toBe(new Date(1_001_000).toISOString());
    const withSession = new ApprovalBroker(port, clock).fromToolPermission(toolRequest, {
      turnId: "t1",
      revision: 3,
      lifetimeMs: 1_000,
      allowSession: true,
    });
    expect(withSession.allowedDecisions).toEqual(["allow-once", "allow-session", "deny"]);

    const result = await broker.resolve(
      { approvalId: "req_1", decision: "allow-once", context: { requestId: "r", expectedRevision: 3 } },
      principal,
      4,
    );
    expect(result).toMatchObject({ approvalId: "req_1", status: "resolved", decision: "allow-once", alreadyResolved: false, revision: 4 });
    expect(port.tool).toEqual([{ requestId: "req_1", decision: "allow-once" }]);
    const again = await broker.resolve(
      { approvalId: "req_1", decision: "deny", context: { requestId: "r2" } },
      principal,
      5,
    );
    expect(again.alreadyResolved).toBe(true);
    expect(again.decision).toBe("allow-once");
    expect(port.tool).toHaveLength(1);
    expect(broker.list()).toEqual([]);
  });

  it("fails closed on expiry, stale revision, and unoffered decisions", async () => {
    const port = new FakeApprovalPort();
    const clock = new FixedClock();
    const broker = new ApprovalBroker(port, clock);
    broker.fromToolPermission(toolRequest, { turnId: "t1", revision: 3, lifetimeMs: 1_000, allowSession: false });
    await expect(
      broker.resolve({ approvalId: "req_1", decision: "allow-once", context: { requestId: "r", expectedRevision: 2 } }, principal, 4),
    ).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    await expect(
      broker.resolve({ approvalId: "req_1", decision: "allow-session", context: { requestId: "r" } }, principal, 4),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      broker.resolve({ approvalId: "missing", decision: "deny", context: { requestId: "r" } }, principal, 4),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    clock.current += 2_000;
    expect(broker.list()).toEqual([]);
    await expect(
      broker.resolve({ approvalId: "req_1", decision: "deny", context: { requestId: "r" } }, principal, 4),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(broker.result("req_1")?.status).toBe("expired");
    expect(port.tool).toEqual([]);
  });

  it("turns an awaiting_approval planning state into a contract approval that needs a mode", async () => {
    const port = new FakeApprovalPort();
    const broker = new ApprovalBroker(port, new FixedClock());
    const planning: PlanningStateEvent = {
      sessionId: "s1",
      state: "awaiting_approval",
      kind: "goal",
      proposalId: "prop_1",
      title: "Ship it",
      question: "Proceed?",
      version: 2,
    };
    const request = broker.fromPlanningState(planning, { turnId: "t1", revision: 7, lifetimeMs: 1_000 });
    expect(request).toMatchObject({
      id: "prop_1",
      kind: "goal",
      title: "Ship it",
      allowedDecisions: ["approve", "reject"],
      allowedPermissionModes: ["ask", "accept-edits", "auto"],
    });
    expect(broker.fromPlanningState({ sessionId: "s1", state: "planning" }, { turnId: "t1", revision: 7, lifetimeMs: 1 })).toBeNull();
    await expect(
      broker.resolve({ approvalId: "prop_1", decision: "approve", context: { requestId: "r" } }, principal, 8),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const result = await broker.resolve(
      { approvalId: "prop_1", decision: "approve", permissionMode: "accept-edits", context: { requestId: "r" } },
      principal,
      8,
    );
    expect(result.permissionMode).toBe("accept-edits");
    expect(port.contract).toEqual([
      { proposalId: "prop_1", sessionId: "s1", action: "approve", permissionMode: "accept-edits", version: 2 },
    ]);
  });

  it("settles externally and cancels a session's open requests", async () => {
    const port = new FakeApprovalPort();
    const broker = new ApprovalBroker(port, new FixedClock());
    broker.fromToolPermission(toolRequest, { turnId: "t1", revision: 1, lifetimeMs: 1_000, allowSession: false });
    broker.fromToolPermission({ ...toolRequest, requestId: "req_2", sessionId: "s2" }, { turnId: "t2", revision: 1, lifetimeMs: 1_000, allowSession: false });
    const settled = broker.settle("req_1", { status: "resolved", decision: "deny", revision: 2 });
    expect(settled.decision).toBe("deny");
    const again = await broker.resolve({ approvalId: "req_1", decision: "allow-once", context: { requestId: "r" } }, principal, 3);
    expect(again.alreadyResolved).toBe(true);
    expect(port.tool).toEqual([]);
    expect(broker.cancelForSession("s2", 4).map((result) => result.status)).toEqual(["canceled"]);
    expect(broker.list()).toEqual([]);
  });

  it("syncs open host requests for a late attach without duplicating known ones", async () => {
    const port = new FakeApprovalPort();
    port.pending = [{ ...toolRequest, createdAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-10T00:02:00.000Z" }];
    const broker = new ApprovalBroker(port, new FixedClock(Date.parse("2026-09-10T00:01:00.000Z")));
    const synced = await broker.syncPendingTools("s1", { turnId: "t1", revision: 1, lifetimeMs: 1, allowSession: false });
    expect(synced).toHaveLength(1);
    expect(synced[0]!.expiresAt).toBe("2026-09-10T00:02:00.000Z");
    await broker.syncPendingTools("s1", { turnId: "t1", revision: 1, lifetimeMs: 1, allowSession: false });
    expect(broker.list("s1")).toHaveLength(1);
  });

  it("keeps desktop tools pending past the local lease without renewing the RACP lease", async () => {
    const port = new FakeApprovalPort();
    const clock = new FixedClock();
    const broker = new ApprovalBroker(port, clock);
    const context = { turnId: "t1", revision: 3, lifetimeMs: 120_000, allowSession: false };
    port.pending = [{ ...toolRequest, createdAt: new Date(clock.current).toISOString() }];
    const original = broker.fromToolPermission(toolRequest, context);
    clock.current += 121_000;
    expect(broker.list("s1")).toEqual([]);
    const desktop = await broker.listHostPendingTools("s1", context);
    expect(desktop).toHaveLength(1);
    expect(desktop[0]).toMatchObject({ id: "req_1", turnId: "t1", revision: 3, allowedDecisions: ["allow-once", "deny"] });
    expect(desktop[0]).not.toHaveProperty("expiresAt");
    expect(broker.get("req_1")?.expiresAt).toBe(original.expiresAt);
    await expect(broker.resolve({ approvalId: "req_1", decision: "deny", context: { requestId: "r" } }, principal, 4))
      .rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(await broker.listHostPendingTools("s1", context)).toHaveLength(1);
    expect(broker.result("req_1")?.status).toBe("expired");
    expect(port.tool).toEqual([]);
  });

  it("recovers missed requests, respects Host deadlines and forgets requests the Host closed", async () => {
    const port = new FakeApprovalPort();
    const clock = new FixedClock();
    const broker = new ApprovalBroker(port, clock);
    const context = { turnId: "t1", revision: 3, allowSession: false };
    port.pending = [
      { ...toolRequest, createdAt: new Date(clock.current - 121_000).toISOString() },
      { ...toolRequest, requestId: "expired", createdAt: "", expiresAt: new Date(clock.current - 1).toISOString() },
      { ...toolRequest, requestId: "future", createdAt: "", expiresAt: new Date(clock.current + 1_000).toISOString() },
      { ...toolRequest, requestId: "other-session", sessionId: "s2", createdAt: "" },
    ];
    expect((await broker.listHostPendingTools("s1", context)).map((request) => request.id)).toEqual(["req_1", "future"]);
    expect(broker.getForDesktop("req_1")?.sessionId).toBe("s1");
    expect(broker.list()).toEqual([]);
    clock.current += 121_000;
    expect((await broker.listHostPendingTools("s1", context)).map((request) => request.id)).toEqual(["req_1"]);
    port.pending = [];
    expect(await broker.listHostPendingTools("s1", context)).toEqual([]);
    expect(broker.getForDesktop("req_1")).toBeUndefined();
  });

  it.each(["resolved", "canceled"] as const)("does not resurrect %s requests in stale Host reads", async (status) => {
    const port = new FakeApprovalPort();
    const broker = new ApprovalBroker(port, new FixedClock());
    const context = { turnId: "t1", revision: 3, lifetimeMs: 120_000, allowSession: false };
    port.pending = [{ ...toolRequest, createdAt: "" }];
    await broker.listHostPendingTools("s1", context);
    if (status === "canceled") broker.cancelForSession("s1", 4);
    else broker.settle("req_1", { status, decision: "deny", revision: 4 });
    expect(await broker.listHostPendingTools("s1", context)).toEqual([]);
    expect(await broker.syncPendingTools("s1", context)).toEqual([]);
    expect(broker.getForDesktop("req_1")).toBeUndefined();
    expect(broker.result("req_1")?.status).toBe(status);
    expect(port.tool).toEqual([]);
  });

  it("does not restore a request when the turn ends while Host pending is being read", async () => {
    const port = new FakeApprovalPort();
    const broker = new ApprovalBroker(port, new FixedClock());
    let finish!: (requests: PendingToolRequest[]) => void;
    port.listPendingTools = () => new Promise((resolve) => { finish = resolve; });
    const read = broker.listHostPendingTools("s1", { turnId: "t1", revision: 3, allowSession: false });
    broker.cancelForSession("s1", 4);
    finish([{ ...toolRequest, createdAt: "" }]);
    expect(await read).toEqual([]);
    expect(broker.getForDesktop("req_1")).toBeUndefined();
  });

  it("does not let an older Host read resurrect a request a newer refresh removed", async () => {
    const port = new FakeApprovalPort();
    const broker = new ApprovalBroker(port, new FixedClock());
    const context = { turnId: "t1", revision: 3, allowSession: false };
    port.pending = [{ ...toolRequest, createdAt: "" }];
    await broker.listHostPendingTools("s1", context);
    let finish!: (requests: PendingToolRequest[]) => void;
    port.listPendingTools = () => new Promise((resolve) => { finish = resolve; });
    const oldRead = broker.listHostPendingTools("s1", context);
    port.listPendingTools = async () => [];
    expect(await broker.listHostPendingTools("s1", context)).toEqual([]);
    finish([{ ...toolRequest, createdAt: "" }]);
    expect(await oldRead).toEqual([]);
    expect(broker.getForDesktop("req_1")).toBeUndefined();
  });
});
