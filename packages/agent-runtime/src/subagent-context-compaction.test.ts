import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentEventEnvelope,
  SubagentDefinition,
} from "@pi-desktop/shared";
import { SubagentRun, type SubagentRunOptions } from "./subagent.js";
import { genericModelConfig } from "./model-capabilities.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

/**
 * A delegate compacts its own context: the shared budget rule decides when, the
 * shared checkpoint shape decides what survives, and the summary is a real
 * provider request. These tests drive the whole path over a real transport,
 * because the failure modes that matter — a summary the model cut off, an
 * oversized summary input, an overflow the provider reports — only exist once a
 * request is actually issued.
 */

type Request = {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
};

const SUMMARIZATION_MARK = "summarization assistant";
const SUMMARY_TEXT = "## Goal\nKeep going with the delegated task.";
const WORK_TEXT = "Completed with retained work.";
const BRIEF = "Find where the permission dialog is rendered.";
/** The delegated instruction: the newest user message, appended by `prompt()`. */
const TASK = "Finish the delegated work.";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function sse(res: ServerResponse, model: string, text: string, finishReason = "stop") {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp } as AgentMessage;
}

/** A finished tool result, the shape a child's oversized tool output arrives in. */
function toolResultMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "child-read",
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

function definition(
  overrides: Partial<SubagentDefinition> = {},
): SubagentDefinition {
  return {
    name: "explorer",
    description: "Search the workspace and report findings.",
    tools: ["Read"],
    prompt: "Find the answer and report it.",
    source: "builtin",
    ...overrides,
  };
}

function historyWithToolOutput(chars: number): AgentMessage[] {
  return [
    userMessage(BRIEF, 1),
    { role: "assistant", content: [{ type: "toolCall", id: "child-read", name: "Read", arguments: {} }],
      api: "openai-completions", provider: "fixture", model: "fixture-model", stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as AgentMessage,
    toolResultMessage("x".repeat(chars), 3),
  ];
}

async function fixture(options: {
  contextWindow: number;
  maxTokens: number;
  /** Transcript injected before the run starts. */
  history?: AgentMessage[];
  /** Reject the first work request the way an oversized context is rejected. */
  overflowOnce?: boolean;
  /** Hold the summary response until the test releases it. */
  gateSummarization?: () => Promise<void>;
  failFirst?: boolean;
  toolFirst?: boolean;
  summaryFinishReason?: "stop" | "length";
}) {
  const requests: Request[] = [];
  const summaries: Request[] = [];
  const works: Request[] = [];
  const headers: Array<string | undefined> = [];
  let summarySeen: (() => void) | undefined;
  const summarizationStarted = new Promise<void>((resolve) => {
    summarySeen = resolve;
  });
  let workRequests = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const request = JSON.parse(raw) as Request;
    requests.push(request);
    headers.push(req.headers.authorization);
    if (raw.includes(SUMMARIZATION_MARK)) {
      summaries.push(request);
      summarySeen?.();
      summarySeen = undefined;
      if (options.gateSummarization) await options.gateSummarization();
      // The client may have aborted while the response was gated.
      if (res.destroyed || res.writableEnded) return;
      res.on("error", () => {});
      sse(res, request.model, SUMMARY_TEXT, options.summaryFinishReason);
      return;
    }
    works.push(request);
    workRequests += 1;
    if (options.failFirst && workRequests === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "model not found" } }));
      return;
    }
    if (options.overflowOnce && workRequests === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "maximum context length is 32768 tokens" },
        }),
      );
      return;
    }
    if (options.toolFirst && workRequests === 1) {
      const base = { id: "fixture-tool", object: "chat.completion.chunk", created: 1, model: request.model };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "child-read", type: "function", function: { name: "Read", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    sse(res, request.model, WORK_TEXT);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing fixture address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider: RuntimeProviderConfig = {
    id: "fixture",
    name: "Fixture",
    modelId: "fixture-model",
    baseUrl,
    apiKey: "fixture-key",
    authKind: "api_key_and_base_url",
    apiStyle: "openai-chat",
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    modelConfig: {
      ...genericModelConfig("fixture-model", baseUrl),
      contextWindow: options.contextWindow,
      maxTokens: options.maxTokens,
    },
  };
  const createRun = (overrides: Partial<SubagentRunOptions> = {}) => {
    const events: AgentEventEnvelope[] = [];
    const run = new SubagentRun({
      definition: definition(),
      sessionId: "session-1",
      parentToolCallId: "task-1",
      task: TASK,
      systemPrompt: "You are the explorer subagent.",
      provider,
      thinkingLevel: "off",
      tools: [],
      onEvent: (event) => events.push(event),
      reportIntervalSteps: 32,
      ...overrides,
    });
    const agent = (
      run as unknown as { agent: { state: { messages: AgentMessage[] } } }
    ).agent;
    if (options.history?.length) {
      const system = agent.state.messages.filter((message) => message.role === "system");
      agent.state.messages = [...system, ...options.history];
    }
    return { run, events, agent };
  };
  return {
    provider,
    createRun,
    requests,
    summaries,
    works,
    headers,
    summarizationStarted,
  };
}

describe("subagent context checkpoints", () => {
  it("checkpoints its own context before the request, keeping the brief and the newest instruction", async () => {
    // ~20k tokens of history against a 16k hard limit, under the summary input
    // limit so the summary request itself is still allowed.
    const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096, history: historyWithToolOutput(80_000) });
    const { run } = f.createRun();

    const result = await run.run();

    expect(result.status).toBe("completed");
    expect(result.report).toContain(WORK_TEXT);
    expect(result.contextCompactions).toBe(1);
    expect(result.report).toContain("checkpointed 1 time");
    // One summary request, then the work request that benefited from it.
    expect(f.summaries).toHaveLength(1);
    expect(f.works).toHaveLength(1);
    expect(f.requests[0]).toBe(f.summaries[0]);
    const work = JSON.stringify(f.works[0].messages);
    expect(work).toContain(SUMMARY_TEXT);
    expect(work).toContain(BRIEF);
    expect(work).toContain(TASK);
    // The oversized tool output is summarized, never replayed.
    expect(work).not.toContain("xxxxxxx");
    // Both requests used the delegate's own provider credentials.
    expect(f.headers).toEqual(["Bearer fixture-key", "Bearer fixture-key"]);
  });

  it("recovers from one provider-reported overflow by checkpointing and retrying the same model", async () => {
    // Small enough to stay under the threshold: the provider's own rejection is
    // the only reason to compact.
    const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096, overflowOnce: true });
    const { run } = f.createRun();

    const result = await run.run();

    expect(result.status).toBe("completed");
    expect(result.contextCompactions).toBe(1);
    expect(f.works).toHaveLength(2);
    expect(f.summaries).toHaveLength(1);
    expect(f.works[1].model).toBe(f.works[0].model);
    expect(JSON.stringify(f.works[1].messages)).toContain(SUMMARY_TEXT);
    expect(result.report).toContain(WORK_TEXT);
  });

  it("degrades to a bounded context when the summary request cannot fit", async () => {
    // ~6k tokens of history against a 4k hard limit and a summary input limit
    // of ~4.9k: the summary request would itself exceed the model's window.
    const f = await fixture({
      contextWindow: 8_000,
      maxTokens: 1_024,
      history: historyWithToolOutput(24_000),
    });
    const { run, agent } = f.createRun();

    const result = await run.run();

    expect(result.status).toBe("completed");
    expect(result.contextDegraded).toBe(true);
    expect(result.report).toContain("older working history was discarded");
    expect(f.summaries).toHaveLength(0);
    expect(f.works).toHaveLength(1);
    expect(JSON.stringify(agent.state.messages)).not.toContain("x".repeat(24_000));
    expect(result.contextCompactions).toBeUndefined();
  });

  it("rejects an oversized system prompt before sending any request", async () => {
    // A system prompt that alone fills the window: nothing a checkpoint could do
    // would bring the request under the limit, so the run must say so instead of
    // retrying the oversized request.
    const f = await fixture({
      contextWindow: 8_000,
      maxTokens: 1_024,
      overflowOnce: true,
    });
    const { run } = f.createRun({ systemPrompt: "s".repeat(200_000) });

    const result = await run.run();

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CONTEXT_COMPACTION_FAILED");
    expect(f.requests).toHaveLength(0);
  });

  it("stops the checkpoint on a user Stop instead of completing or resuming", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      contextWindow: 32_000,
      maxTokens: 4_096,
      history: historyWithToolOutput(80_000),
      gateSummarization: () => gate,
    });
    const controller = new AbortController();
    const { run } = f.createRun({ signal: controller.signal });

    const pending = run.run();
    await f.summarizationStarted;
    controller.abort();
    release();

    const result = await pending;

    expect(result.status).toBe("aborted");
    expect(result.report).not.toContain(WORK_TEXT);
    expect(f.works).toHaveLength(0);
    expect(run.canResume).toBe(false);
  });
  it("compacts after a real tool result without executing the tool again", async () => {
    const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096, toolFirst: true });
    let executions = 0;
    const { run } = f.createRun({ tools: [{
      name: "Read", label: "Read", description: "Read a large result.", parameters: Type.Object({}),
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "x".repeat(80_000) }], details: {} };
      },
    }] });
    const result = await run.run();
    expect(result.status).toBe("completed");
    expect(executions).toBe(1);
    expect(f.summaries).toHaveLength(1);
    expect(f.works).toHaveLength(2);
    for (const request of f.works) {
      expect(request.tools).toEqual([expect.objectContaining({
        type: "function", function: expect.objectContaining({ name: "Read", parameters: { type: "object", properties: {} } }),
      })]);
    }
    expect(JSON.stringify(f.works[1].messages)).not.toContain("xxxxxxx");
    expect(f.works[1].messages.some((message) => message.role === "tool")).toBe(false);
  });

  it("includes the first task in the budget before making the first work request", async () => {
    const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096 });
    const { run } = f.createRun({ task: "task ".repeat(14_000) });
    expect((await run.run()).status).toBe("completed");
    expect(f.requests[0]).toBe(f.summaries[0]);
    expect(f.summaries).toHaveLength(1);
  });

  it("includes a new resume instruction when checking a retained context", async () => {
    const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096 });
    const { run, agent } = f.createRun();
    expect((await run.run()).status).toBe("completed");
    agent.state.messages = historyWithToolOutput(60_000);
    const result = await run.resume("followup ".repeat(1_000), "turn-2", "task-2");
    expect(result.status).toBe("completed");
    expect(f.summaries).toHaveLength(1);
    expect(f.requests[1]).toBe(f.summaries[0]);
  });

  it("degrades safely when the provider cuts the summary short", async () => {
    const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096, history: historyWithToolOutput(80_000), summaryFinishReason: "length" });
    const { run, agent } = f.createRun();
    const result = await run.run();
    expect(result.status).toBe("completed");
    expect(result.contextDegraded).toBe(true);
    expect(f.works).toHaveLength(1);
    expect(JSON.stringify(agent.state.messages)).not.toContain("x".repeat(80_000));
  });
  it("skips a fallback whose smaller window cannot hold the carried context", async () => {
    const f = await fixture({ contextWindow: 128_000, maxTokens: 4_096, history: historyWithToolOutput(80_000), failFirst: true });
    const fallback: RuntimeProviderConfig = {
      ...f.provider, id: "fallback", modelId: "fallback-model",
      modelConfig: { ...f.provider.modelConfig!, contextWindow: 32_000 },
    };
    const { run } = f.createRun({ fallbackModels: [{ key: "fallback/fallback-model", provider: fallback }] });
    const result = await run.run();
    expect(result.status).toBe("failed");
    expect(f.works).toHaveLength(1);
    expect(f.summaries).toHaveLength(0);
    expect(result.modelFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: "fallback/fallback-model", code: "SUBAGENT_CONTEXT_OVERFLOW" }),
    ]));
  });
});

it("keeps tool messages unique when no checkpoint is needed", async () => {
  const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096, toolFirst: true });
  let executions = 0;
  const { run } = f.createRun({ tools: [{
    name: "Read", label: "Read", description: "Read a short result.", parameters: Type.Object({}),
    execute: async () => {
      executions += 1;
      return { content: [{ type: "text", text: "short tool result" }], details: {} };
    },
  }] });
  expect((await run.run()).status).toBe("completed");
  expect(executions).toBe(1);
  expect(f.summaries).toHaveLength(0);
  expect(f.works).toHaveLength(2);
  for (const request of f.works) {
    expect(request.tools?.map((tool) => tool.function.name)).toEqual(["Read"]);
  }
  expect(f.works[1].messages.flatMap((message) => message.tool_calls ?? [])).toHaveLength(1);
  expect(f.works[1].messages.filter((message) => message.role === "tool")).toHaveLength(1);
});

it("备用模型和召回请求仍携带子代理的工具声明", async () => {
  const f = await fixture({ contextWindow: 32_000, maxTokens: 4_096, failFirst: true });
  const fallback = { ...f.provider, id: "fallback", modelId: "fallback-model" };
  const { run } = f.createRun({
    fallbackModels: [{ key: "fallback/fallback-model", provider: fallback }],
    tools: [{
      name: "Read", label: "Read", description: "Read a file.", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "file content" }], details: {} }),
    }],
  });
  expect((await run.run()).status).toBe("completed");
  expect(f.works).toHaveLength(2);
  expect(f.works[1].model).toBe("fallback-model");
  expect((await run.resume("继续检查", "turn-2", "task-2")).status).toBe("completed");
  expect(f.works).toHaveLength(3);
  for (const request of f.works) {
    expect(request.tools?.map((tool) => tool.function.name)).toEqual(["Read"]);
  }
});
