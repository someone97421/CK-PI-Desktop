import { describe, expect, it, vi } from "vitest";
import { SubagentPersistenceClient } from "./subagent-persistence-client.js";
import type { RuntimeHost } from "./host-client.js";
import type { SubagentBeginRequest, SubagentCommitRequest } from "./subagent-persistence.js";

function begin(id: string, execution = 1): SubagentBeginRequest {
  return { sessionId: "session", delegationId: id, expectedRevision: execution - 1,
    expectedExecution: execution - 1, nextExecution: execution, executionId: `${id}:${execution}`,
    instanceGeneration: 1, commandId: `${id}:${execution}`, commandDigest: "fixture", parentToolCallId: id };
}

describe("快照旁路客户端", () => {
  it("宿主一直不回复时，启动和内存续跑仍立即获准，退出有界", async () => {
    vi.useFakeTimers();
    const call = vi.fn(() => new Promise<never>(() => {}));
    const client = new SubagentPersistenceClient({ call } as unknown as RuntimeHost, "session");
    try {
      await expect(client.beginExecution(begin("task"))).resolves.toMatchObject({ execution: 1 });
      client.completeMemoryExecution("task", 1);
      await expect(client.beginExecution(begin("task", 2))).resolves.toMatchObject({ execution: 2 });
      const closing = client.flush();
      await vi.advanceTimersByTimeAsync(1_001);
      await closing;
      const callsAtClose = call.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(call).toHaveBeenCalledTimes(callsAtClose);
    } finally { vi.useRealTimers(); }
  });

  it("失败任务的存储队列不阻塞另一任务，并且保存重试有上限", async () => {
    const call = vi.fn(async (_method: string, req: any) => {
      if (req.operation === "capabilities") return { protocolVersion: 1, settings: { enabled: true, available: true } };
      if (req.operation === "claimSession") return { instanceGeneration: 1, available: true };
      if (req.operation === "beginExecution") return { revision: 1 };
      if (req.delegationId === "broken") throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
      return { durableReady: true, snapshotGeneration: 1 };
    });
    const client = new SubagentPersistenceClient({ call } as unknown as RuntimeHost, "session");
    const commit = (id: string) => ({ sessionId: "session", delegationId: id, expectedExecution: 1,
      executionId: `${id}:1`, expectedRevision: 1, instanceGeneration: 1, targetGeneration: 1, checkpoint: {} } as SubagentCommitRequest);
    for (const id of ["broken", "healthy"]) {
      await client.beginExecution(begin(id));
      client.completeMemoryExecution(id, 1);
    }
    const broken = client.commitSnapshot(commit("broken"));
    const healthy = client.commitSnapshot(commit("healthy"));
    await expect(broken).rejects.toThrow("disk unavailable");
    await expect(healthy).resolves.toMatchObject({ durableReady: true });
    expect(call.mock.calls.filter(([, req]) => req.operation === "commitSnapshot" && req.delegationId === "broken")).toHaveLength(2);
    await expect(client.beginExecution(begin("broken", 2))).resolves.toMatchObject({ execution: 2 });
    await client.flush();
  });

  it("本地停止后禁止继续执行，迟到的登记不能再发出保存", async () => {
    let registered!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { registered = resolve; });
    const call = vi.fn(async (_method: string, req: any) => {
      if (req.operation === "capabilities") return { protocolVersion: 1, settings: { enabled: true, available: true } };
      if (req.operation === "claimSession") return { instanceGeneration: 1, available: true };
      if (req.operation === "beginExecution") { started(); await gate; return { revision: 1 }; }
      return { status: "revoked", execution: 1 };
    });
    const client = new SubagentPersistenceClient({ call } as unknown as RuntimeHost, "session");
    await client.beginExecution(begin("task"));
    await began;
    const stopped = client.revokeExecution({ sessionId: "session", delegationId: "task", expectedExecution: 1, source: "user", reason: "stop" });
    await expect(client.beginExecution(begin("task", 2))).rejects.toThrow("任务状态或执行轮次已变化");
    registered();
    await stopped;
    expect(call.mock.calls.some(([, req]) => req.operation === "commitSnapshot")).toBe(false);
    await client.flush();
  });
});
