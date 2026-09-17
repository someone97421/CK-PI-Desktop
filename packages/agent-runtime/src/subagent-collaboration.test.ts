import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentEventEnvelope, SubagentDefinition } from "@pi-desktop/shared";
import { SubagentObserver, type SubagentObservation } from "./subagent-observer.js";
import { SubagentRun } from "./subagent.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import type { RuntimeHost } from "./host-client.js";

afterEach(() => vi.restoreAllMocks());
const provider: RuntimeProviderConfig = {
  id: "fixture", name: "Fixture", modelId: "model", baseUrl: "http://fixture.invalid/v1",
  apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"],
};
const definition: SubagentDefinition = { name: "explorer", description: "Inspect files", tools: ["Read"], prompt: "Inspect and report", source: "builtin" };
const result = { content: [{ type: "text" as const, text: "ok" }], details: {} };
function reply(paths: string[] = []): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "fixture", model: "model", timestamp: Date.now(),
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: paths.length ? "toolUse" : "stop",
    content: paths.length ? paths.map((path) => ({ type: "toolCall" as const, name: "Read", id: path, arguments: { path } }))
      : [{ type: "text", text: "Completed the requested inspection." }],
  };
}
function setStream(agent: Agent, respond: (context: Context, index: number) => AssistantMessage) {
  let index = 0;
  const contexts: Context[] = [];
  agent.streamFunction = (_model, context, options) => {
    if (index >= 10) throw new Error("400 fixture exceeded ten model requests");
    contexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
    const stream = createAssistantMessageEventStream();
    if (options?.signal?.aborted) {
      queueMicrotask(() => stream.push({ type: "error", reason: "aborted", error: { ...reply(), stopReason: "aborted" } }));
      return stream;
    }
    const message = respond(context, index++);
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    });
    return stream;
  };
  return contexts;
}
function child(execute: AgentTool["execute"], interval = 2) {
  const observations: SubagentObservation[] = [];
  const events: AgentEventEnvelope[] = [];
  const run = new SubagentRun({ definition, provider, sessionId: "s", turnId: "t", parentToolCallId: "task",
    delegationId: "child", reportIntervalSteps: interval, task: "Inspect", systemPrompt: "Inspect", thinkingLevel: "off",
    tools: [{ name: "Read", label: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }), execute }],
    onObservation: (event) => observations.push(event), onEvent: (event) => events.push(event),
  });
  return { run, observations, events, agent: (run as unknown as { agent: Agent }).agent };
}
function parent(interval?: number) {
  const events: AgentEventEnvelope[] = [];
  const host = { call: vi.fn(async () => ({ ok: true, content: "ok" })) };
  const runtime = new DesktopAgentRuntime({ host: host as unknown as RuntimeHost, provider, sessionId: "s", turnId: "t", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    subagents: [{ ...definition, ...(interval === undefined ? {} : { reportIntervalSteps: interval }) }],
    onEvent: (event) => events.push(event),
  });
  return { runtime, events, host, internal: runtime as any };
}

describe("subagent continuous collaboration", () => {
  it("recalls the same context for review fixes and separates new usage from lifetime usage", async () => {
    const calls: string[] = [];
    const fixture = child(async (_id, args: any) => { calls.push(args.path); return result; }, 3);
    const contexts = setStream(fixture.agent, (_context, index) => index === 0 ? reply(["initial"])
      : index === 2 ? reply(["revision"]) : reply());
    const first = await fixture.run.run();
    expect(first.status).toBe("completed");
    expect(fixture.run.canResume).toBe(true);
    expect(first.usage?.totalTokens).toBe(6);
    await Promise.resolve();
    expect(contexts).toHaveLength(2); // 完成后的等待不请求模型。
    const second = await fixture.run.resume("Review: fix the edge case", "turn-2", "resume-call");
    expect(second.status).toBe("completed");
    expect(JSON.stringify(contexts[2].messages)).toContain("initial");
    expect(JSON.stringify(contexts[2].messages)).toContain("Review: fix the edge case");
    expect(calls).toEqual(["initial", "revision"]);
    expect(second).toMatchObject({ turns: 4, toolCalls: 2, usage: { totalTokens: 12 }, executionUsage: { totalTokens: 6 } });
    expect(fixture.run.observation.snapshot()).toMatchObject({ execution: 2, segmentId: 2, completedSteps: 2, segmentCompletedSteps: 1 });
    expect(fixture.events.filter((event) => event.parentToolCallId === "resume-call").every((event) => event.turnId === "turn-2")).toBe(true);
    expect(fixture.observations.filter((event) => event.kind === "report").map((event) => event.report.execution)).toEqual([1, 2]);
    fixture.run.stop("user");
    expect(fixture.run.canResume).toBe(false);
    expect(() => fixture.run.resume("must not revive", "turn-2", "r3")).toThrow();
  });

  it("reports across several intervals without pausing or spending model calls on summaries", async () => {
    const calls: string[] = [];
    const { run, agent, observations } = child(async (_id, args: any) => { calls.push(args.path); return result; });
    const contexts = setStream(agent, (_ctx, index) => index === 0 ? reply(["a", "b", "c", "d", "e"]) : reply());
    const finished = await run.run();
    expect(finished.status).toBe("completed");
    expect(calls).toEqual(["a", "b", "c", "d", "e"]);
    expect(contexts).toHaveLength(2);
    const reports = observations.filter((event) => event.kind === "report").map((event) => event.report);
    expect(reports.map((report) => [report.fromStep, report.toStep, report.reason])).toEqual([[1, 2, "interval"], [3, 4, "interval"], [5, 5, "completed"]]);
    expect(run.observation.snapshot()).toMatchObject({ startedSteps: 5, completedSteps: 5, segmentCompletedSteps: 5 });
    expect(JSON.stringify(contexts)).not.toContain("Runtime subagent supervision");
  });

  it("finishes A, skips old B/C, inserts guidance in the same context and resets only the segment", async () => {
    const calls: string[] = [];
    const fixture = child(async (_id, args: any) => {
      calls.push(args.path);
      if (args.path === "a") expect(fixture.run.guide("Inspect d instead of b/c", 1, "guide-1").status).toBe("accepted");
      return result;
    }, 3);
    const contexts = setStream(fixture.agent, (context, index) => {
      if (!index) return reply(["a", "b", "c"]);
      if (index === 1) {
        expect(JSON.stringify(context.messages)).toContain("Inspect d instead of b/c");
        expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
        return reply(["d"]);
      }
      return reply();
    });
    const finished = await fixture.run.run();
    expect(finished.status).toBe("completed");
    expect(finished.toolCalls).toBe(2);
    expect(calls).toEqual(["a", "d"]);
    expect(contexts).toHaveLength(3);
    expect(fixture.run.observation.snapshot()).toMatchObject({ segmentId: 2, startedSteps: 2, completedSteps: 2,
      segmentCompletedSteps: 1, reportIntervalSteps: 1, latestGuide: { status: "applied" } });
    expect(fixture.observations.filter((event) => event.kind === "report").map((event) => event.report.reason)).toEqual(["guide", "interval"]);
    expect(fixture.events.filter((event) => event.event.type === "tool_end" && ["b", "c"].includes(event.event.toolCallId)))
      .toHaveLength(2);
  });

  it("latches guidance while the model is generating before any old tool starts", async () => {
    const calls: string[] = [];
    const fixture = child(async (_id, args: any) => { calls.push(args.path); return result; });
    setStream(fixture.agent, (_ctx, index) => {
      if (index === 0) { fixture.run.guide("Only inspect new", undefined, "early"); return reply(["old"]); }
      return index === 1 ? reply(["new"]) : reply();
    });
    expect((await fixture.run.run()).status).toBe("completed");
    expect(calls).toEqual(["new"]);
    expect(fixture.run.observation.snapshot().completedSteps).toBe(1);
  });

  it("stops independently, preserves completed effects and cancels accepted guidance", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const fixture = child(async (_id, args: any) => { calls.push(args.path); started(); await blocked; return result; });
    setStream(fixture.agent, () => reply(["a", "b"]));
    const running = fixture.run.run();
    await entered;
    fixture.run.guide("new instruction", undefined, "pending");
    fixture.run.stop("user");
    expect(fixture.run.observation.snapshot()).toMatchObject({ phase: "stopping", stopSource: "user", latestGuide: { status: "cancelled" } });
    expect(fixture.run.guide("must not restart").status).toBe("rejected");
    release();
    expect((await running).status).toBe("aborted");
    expect(calls).toEqual(["a"]);
    const records = fixture.run.observation.inspect() as any;
    expect(records.steps[0].status).toBe("success"); // 已完成的副作用不能谎报成已撤销。
  });

  it("counts failed attempts once and redacts secrets from summaries and inspection", () => {
    const observations: SubagentObservation[] = [];
    const observer = new SubagentObserver("child", 1, "dispatch", (event) => observations.push(event), ["private-provider-secret"]);
    observer.begin("one", "Bash", { command: "api_key=secret-value password=\"two secret words\"", password: "hidden" });
    observer.begin("one", "Bash", {});
    observer.end("one", "Authorization: Bearer abc.def private-provider-secret", true);
    observer.end("one", "duplicate", false);
    expect(observer.snapshot()).toMatchObject({ startedSteps: 1, completedSteps: 1 });
    const text = JSON.stringify([observations, observer.inspect()]);
    for (const secret of ["secret-value", "hidden", "abc.def", "private-provider-secret", "two secret words"]) expect(text).not.toContain(secret);
    expect((observer.inspect() as any).steps[0].status).toBe("error");
  });

  it("applies ordered guides once, rejects user-fixed interval changes and invalid values", () => {
    const observer = new SubagentObserver("child", 4, "definition", () => {});
    expect(observer.guide("change", 2).status).toBe("rejected");
    expect(observer.guide("bad", 0).status).toBe("rejected");
    observer.guide("first", undefined, "g1");
    observer.guide("second", 4, "g2");
    observer.guide("duplicate", undefined, "g1");
    const text = observer.applyGuides()!;
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text).not.toContain("duplicate");
    observer.guidesApplied();
    expect(observer.applyGuides()).toBeUndefined();
    expect(observer.snapshot()).toMatchObject({ segmentId: 2, reportIntervalSteps: 4 });
  });

  it("bounds records and exposes truncation and continuation references", () => {
    const observer = new SubagentObserver("child", 300, "dispatch", () => {});
    for (let i = 0; i < 300; i++) { observer.begin(String(i), "Read", {}); observer.end(String(i), "x".repeat(20_000), false); }
    const snapshot = observer.snapshot();
    expect(snapshot.latestReport).toMatchObject({ fromStep: 1, toStep: 300, truncated: true });
    const inspected = observer.inspect(1, 2) as any;
    expect(inspected.historyTruncated).toBe(true);
    expect(inspected.steps).toHaveLength(2);
    expect(inspected.steps[0].nextOffset).toBe(3000);
    observer.guide("Keep pending until the current tool finishes", undefined, "pending");
    for (let i = 0; i < 100; i++) observer.guide("invalid interval", 0, `rejected-${i}`);
    expect(observer.guides.length).toBeLessThanOrEqual(64);
    expect(observer.guides.find((guide) => guide.commandId === "pending")?.status).toBe("accepted");
    expect(observer.guide("must not reapply an evicted command", undefined, "rejected-0").status).toBe("rejected");
  });
});

describe("parent supervision connectivity", () => {
  function interceptChildren(paths: string[]) {
    const original = SubagentRun.prototype.run;
    vi.spyOn(SubagentRun.prototype, "run").mockImplementation(function (this: SubagentRun) {
      setStream((this as any).agent, (_ctx, index) => !index ? reply(paths) : reply());
      return original.call(this);
    });
  }

  it("recalls across parent turns, rejects stale commands and settles only the new execution", async () => {
    interceptChildren([]);
    const fixture = parent(3);
    const start = await fixture.internal.buildSubagentTool().execute("task", { agent: "explorer", task: "implement" });
    const record = fixture.internal.delegations.get(start.details.delegationId);
    await record.completion;
    expect(fixture.runtime.subagentRecallStatus(record.delegationId)).toMatchObject({ canResume: true, execution: 1 });
    expect(fixture.internal.runningDelegations()).toHaveLength(0);
    const originalRun = record.run;
    const firstResult = record.result;
    const oldCompletion = record.completion;
    fixture.internal.turnEpoch += 1;
    fixture.internal.turnId = "review-turn";
    fixture.internal.turnSubagentUsage = undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    fixture.host.call.mockImplementation(async () => { await held; return { ok: true, content: "fixed" }; });
    const contexts = setStream((record.run as any).agent, (_context, index) => !index ? reply(["fix"]) : reply());
    const resume = fixture.internal.buildSubagentResumeTool();
    const params = { delegationId: record.delegationId, expectedExecution: 1, instruction: "Fix review findings" };
    const accepted = await resume.execute("resume-2", params);
    expect(accepted.details).toMatchObject({ delegationId: record.delegationId, execution: 2, status: "running", turnId: "review-turn" });
    expect(record.run).toBe(originalRun);
    expect(record.completion).not.toBe(oldCompletion);
    expect((await resume.execute("resume-2", params)).details.duplicate).toBe(true);
    expect((await resume.execute("another", params)).isError).toBe(true);
    expect(() => fixture.runtime.stopSubagent(record.delegationId, "user", 1)).toThrow("execution changed");
    fixture.internal.settleDelegation(record, firstResult, 1);
    expect(record.status).toBe("running");
    expect(record.result).toBeUndefined();
    let delivered = false;
    const waiting = fixture.internal.buildSubagentWaitTool().execute("wait-2", { delegationIds: [record.delegationId], timeoutSeconds: 1 }).then((value: any) => { delivered = true; return value; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    release();
    await record.completion;
    await waiting;
    expect(contexts[0].messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(record.result).toMatchObject({ usage: { totalTokens: 9 }, executionUsage: { totalTokens: 6 } });
    expect(fixture.internal.turnSubagentUsage.totalTokens).toBe(6);
    const result2 = await fixture.internal.buildSubagentWaitTool().execute("latest", { delegationIds: [record.delegationId] });
    expect(result2.details.delegations[0]).toMatchObject({ execution: 2, status: "completed", canResume: true });
    expect(record.executionHistory).toHaveLength(2);
    expect(record.parentToolCallIds).toEqual(["task", "resume-2"]);
    expect(fixture.events.some((event) => event.turnId === "review-turn" && event.event.type === "message_end" && event.event.message.toolName === "TaskExecution")).toBe(true);
    await fixture.runtime.dispose();
    expect(fixture.runtime.subagentRecallStatus(record.delegationId).canResume).toBe(false);
  });

  it("connects actual parent tool dispatch, review, recall and the second result in one conversation", async () => {
    interceptChildren([]);
    const fixture = parent(2);
    expect(fixture.internal.agent.state.tools.some((tool: AgentTool) => tool.name === "TaskResume")).toBe(true);
    let stage = 0;
    const call = (name: string, id: string, args: Record<string, unknown>): AssistantMessage => ({ ...reply(), stopReason: "toolUse",
      content: [{ type: "toolCall", name, id, arguments: args }] });
    setStream(fixture.internal.agent, () => {
      const record = [...fixture.internal.delegations.values()][0] as any;
      switch (stage++) {
        case 0: return call("Task", "launch", { agent: "explorer", task: "Implement the first pass", description: "First pass" });
        case 1: return call("TaskWait", "wait-first", { delegationIds: [record.delegationId] });
        case 2: return call("TaskResume", "review-fix", { delegationId: record.delegationId, expectedExecution: 1, instruction: "Review found an edge case; fix it" });
        case 3: return call("TaskWait", "wait-revised", { delegationIds: [record.delegationId] });
        default: return reply();
      }
    });
    await fixture.runtime.prompt("Implement, review and fix", undefined, "parent-review");
    expect(fixture.internal.delegations.size).toBe(1);
    const record = [...fixture.internal.delegations.values()][0] as any;
    expect(record).toMatchObject({ execution: 2, status: "completed", reportDelivered: true });
    expect(record.executionHistory).toHaveLength(2);
    expect(record.run.agent.state.messages.filter((message: any) => message.role === "user").map((message: any) => message.content[0].text))
      .toEqual(["Implement the first pass", "Review found an edge case; fix it"]);
    const snapshots = fixture.events.filter((event) => event.event.type === "message_end" && event.event.message.toolName === "TaskResume");
    expect(snapshots.some((event: any) => event.event.message.toolResult.details.status === "completed")).toBe(true);
    expect(fixture.runtime.getStatus().isRunning).toBe(false);
    await fixture.runtime.dispose();
  });

  it("refuses full capacity, stopped, failed, foreign and released contexts without starting work", async () => {
    interceptChildren([]);
    const fixture = parent(1);
    const start = await fixture.internal.buildSubagentTool().execute("task", { agent: "explorer", task: "inspect" });
    const record = fixture.internal.delegations.get(start.details.delegationId);
    await record.completion;
    const resume = fixture.internal.buildSubagentResumeTool();
    const params = { delegationId: record.delegationId, expectedExecution: 1, instruction: "Fix" };
    for (let i = 0; i < 20; i++) fixture.internal.delegations.set(`busy-${i}`, { status: "running" });
    expect((await resume.execute("full", params)).details.error).toContain("concurrency");
    for (let i = 0; i < 20; i++) fixture.internal.delegations.delete(`busy-${i}`);
    record.status = "failed";
    expect((await resume.execute("failed", params)).isError).toBe(true);
    record.status = "completed";
    fixture.runtime.stopSubagent(record.delegationId, "user", 1);
    expect((await resume.execute("stopped", params)).isError).toBe(true);
    expect(record.run.observation.snapshot().stopSource).toBe("user");
    expect((await resume.execute("foreign", { ...params, delegationId: "other-session" })).details.error).toContain("unavailable");
    fixture.internal.delegations.delete(record.delegationId);
    expect((await resume.execute("released", params)).details.error).toContain("recovery");
    expect(fixture.runtime.subagentRecallStatus(record.delegationId)).toMatchObject({ status: "unavailable", canResume: false });
    await fixture.runtime.dispose();
  });

  it("stops a recalled execution and cannot revive it with an accepted duplicate command", async () => {
    interceptChildren([]);
    const fixture = parent(2);
    const start = await fixture.internal.buildSubagentTool().execute("task", { agent: "explorer", task: "inspect" });
    const record = fixture.internal.delegations.get(start.details.delegationId);
    await record.completion;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    fixture.host.call.mockImplementation(async () => { entered(); await held; return { ok: true, content: "finished in-flight" }; });
    setStream((record.run as any).agent, (_context, index) => !index ? reply(["active", "old-next"]) : reply());
    const tool = fixture.internal.buildSubagentResumeTool();
    const params = { delegationId: record.delegationId, expectedExecution: 1, instruction: "Revise" };
    await tool.execute("recall", params);
    await started;
    fixture.runtime.stopSubagent(record.delegationId, "user", 2);
    release();
    await record.completion;
    expect(record.status).toBe("stopped");
    expect((await tool.execute("recall", params)).details.duplicate).toBe(true);
    expect((await tool.execute("new-recall", { ...params, expectedExecution: 2 })).isError).toBe(true);
    expect(record.execution).toBe(2);
    expect(record.run.canResume).toBe(false);
    await fixture.runtime.dispose();
  });

  it("requires a dispatch interval when unset, while a user-fixed interval wins", async () => {
    interceptChildren([]);
    const fixture = parent();
    const task = fixture.internal.buildSubagentTool();
    const missing = await task.execute("bad", { agent: "explorer", task: "inspect" });
    expect(missing.details.error).toContain("reportIntervalSteps");
    expect(fixture.internal.delegations.size).toBe(0);
    for (const interval of [0, -1, 1.5, "4"]) {
      expect((await task.execute("bad", { agent: "explorer", task: "inspect", reportIntervalSteps: interval })).details.error).toBeTruthy();
    }
    const fixed = parent(3);
    const start = await fixed.internal.buildSubagentTool().execute("ok", { agent: "explorer", task: "inspect", reportIntervalSteps: 8 });
    expect(start.details.collaboration).toMatchObject({ reportIntervalSteps: 3, intervalSource: "definition" });
    await Promise.all([...fixed.internal.delegations.values()].map((record: any) => record.completion));
    await fixture.runtime.dispose(); await fixed.runtime.dispose();
  });

  it("wakes TaskWait on incremental reports and never delivers the same report twice", async () => {
    interceptChildren(["a", "b"]);
    const fixture = parent(1);
    let release!: () => void;
    const block = new Promise<void>((resolve) => { release = resolve; });
    fixture.host.call.mockImplementation(async (_method?: unknown, params?: any) => {
      if (params?.args?.path === "b") await block;
      return { ok: true, content: "ok" };
    });
    const start = await fixture.internal.buildSubagentTool().execute("task", { agent: "explorer", task: "inspect" });
    const waited = await fixture.internal.buildSubagentWaitTool().execute("wait", { delegationIds: [start.details.delegationId], timeoutSeconds: 1 });
    expect(waited.details.status).toBe("progress");
    expect(waited.content[0].text).toContain("Runtime subagent supervision");
    expect(fixture.internal.takeSupervision()).toBe("");
    release();
    await fixture.internal.delegations.get(start.details.delegationId).completion;
    expect(fixture.events.some((event) => event.event.type === "message_end" && event.event.message.toolName === "TaskReport")).toBe(true);
    await fixture.runtime.dispose();
  });

  it("feeds reports into an active parent at a model boundary without a second concurrent prompt", async () => {
    const fixture = parent(1);
    const record = { delegationId: "child", agentName: "explorer", parentToolCallId: "task", startedEpoch: fixture.internal.turnEpoch };
    const contexts = setStream(fixture.internal.agent, (_ctx, index) => {
      if (!index) fixture.internal.onSubagentObservation(record, { kind: "stop", source: "user" });
      return reply();
    });
    await fixture.internal.agent.prompt("Independent work");
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1].messages)).toContain("Do not recreate it");
    expect(fixture.internal.agent.state.messages.filter((message: any) => message.role === "user")).toHaveLength(1);
    expect(fixture.internal.agent.state.messages.some((message: any) => message.role === "custom" && message.customType === "subagent-supervision")).toBe(true);
    expect(fixture.internal.takeSupervision()).toBe("");
    await fixture.runtime.dispose();
  });

  it("wakes idle final-report waiting with progress, and refuses foreign or stale controls", async () => {
    interceptChildren(["a", "b"]);
    const fixture = parent(1);
    let release!: () => void;
    const block = new Promise<void>((resolve) => { release = resolve; });
    fixture.host.call.mockImplementation(async (_method?: unknown, params?: any) => {
      if (params?.args?.path === "b") await block;
      return { ok: true, content: "ok" };
    });
    const start = await fixture.internal.buildSubagentTool().execute("task", { agent: "explorer", task: "inspect" });
    const contexts = setStream(fixture.internal.agent, () => { release(); return reply(); });
    await fixture.internal.resumeAfterDelegations();
    expect(contexts.length).toBeGreaterThan(0);
    expect(JSON.stringify(contexts[0].messages)).toContain("Runtime subagent supervision");
    expect(() => fixture.runtime.stopSubagent("foreign")).toThrow("not found");
    expect((await fixture.internal.buildSubagentGuideTool().execute("guide", { delegationId: start.details.delegationId, instruction: "stale" })).details.error).toBeTruthy();
    await fixture.runtime.dispose();
  });

  it("stops one child promptly without aborting its sibling and suppresses late reports after session stop", async () => {
    interceptChildren(["held"]);
    const fixture = parent(1);
    let release!: () => void;
    const block = new Promise<void>((resolve) => { release = resolve; });
    fixture.host.call.mockImplementation(async () => { await block; return { ok: true, content: "ok" }; });
    const task = fixture.internal.buildSubagentTool();
    const first = await task.execute("one", { agent: "explorer", task: "one" });
    const second = await task.execute("two", { agent: "explorer", task: "two" });
    const receipt = fixture.runtime.stopSubagent(first.details.delegationId);
    expect(receipt).toMatchObject({ collaboration: { phase: "stopping", stopSource: "user" } });
    expect(fixture.internal.delegations.get(second.details.delegationId).run.observation.snapshot().phase).toBe("running");
    fixture.internal.runCancelled = true;
    fixture.internal.abortRunningDelegations();
    release();
    await Promise.all([...fixture.internal.delegations.values()].map((record: any) => record.completion));
    expect(fixture.internal.supervisionInbox.size).toBe(0);
    await fixture.runtime.dispose();
  });

  it("coalesces backlogged reports with explicit ranges and ignores stale epochs", async () => {
    const fixture = parent(1);
    const record = { delegationId: "child", agentName: "explorer", parentToolCallId: "task", startedEpoch: fixture.internal.turnEpoch };
    const observer = new SubagentObserver("child", 1, "dispatch", (event) => fixture.internal.onSubagentObservation(record, event));
    for (let i = 1; i <= 14; i++) { observer.begin(String(i), "Read", { path: `file-${i}` }); observer.end(String(i), "ok", false); }
    expect(fixture.internal.supervisionInbox.size).toBe(9);
    expect(fixture.internal.takeSupervision()).toContain("reports 1-6");
    fixture.internal.turnEpoch += 1;
    fixture.internal.onSubagentObservation(record, { kind: "stop", source: "user" });
    expect(fixture.internal.hasSupervision()).toBe(false);
    await fixture.runtime.dispose();
  });

  it("reads persisted detail pages only for the selected child and redacts full-record output", async () => {
    const fixture = parent(1);
    const c = child(async () => result);
    fixture.internal.delegations.set("child", { delegationId: "child", parentToolCallId: "task", status: "completed", run: c.run });
    fixture.host.call.mockImplementation(async () => ({ session: { messages: [
      { id: "ours", parentToolCallId: "task", toolCallId: "ours", toolName: "Read", content: "password=secret-value" },
      { id: "other", parentToolCallId: "foreign", content: "private sibling output" },
    ], messageStart: 10, hasMoreBefore: true } }) as any);
    const inspected = await fixture.internal.buildSubagentInspectTool().execute("inspect", { delegationId: "child", history: true });
    expect(inspected.details.history).toHaveLength(1);
    expect(inspected.details.nextMessageBefore).toBe(10);
    expect(inspected.content[0].text).not.toContain("secret-value");
    expect(inspected.content[0].text).not.toContain("private sibling output");
    expect(fixture.host.call.mock.calls[0]).toEqual(["session.get", expect.objectContaining({ id: "s", messageLimit: 20 })]);
    await fixture.runtime.dispose();
  });
});
