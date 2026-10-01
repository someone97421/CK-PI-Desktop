import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { addUsage } from "../../../packages/shared/src/message-usage.ts";

const file = new URL("../electron/main/runtime/task-transcript.ts", import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: file.pathname,
});
const module = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  assert.equal(id, "@pi-desktop/shared");
  return { addUsage };
}, module.exports, module);
const { TaskTranscript } = module.exports;

const usage = (id, totalTokens = 10) => ({
  operationId: id, aggregation: "operation", inputTokens: totalTokens - 2,
  outputTokens: 2, totalTokens, costStatus: "reported",
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
});
function fixture() {
  const task = new TaskTranscript(new Map([["session", "turn"]]));
  const published = [];
  task.setPublisher(async (_session, _turn, message) => { published.push(message); });
  let ts = 1000;
  const observe = (event, extra = {}) => {
    const envelope = { sessionId: "session", turnId: "turn", ts: ts++, event, ...extra };
    task.observe(envelope);
    return envelope.event;
  };
  const message = (id, extra = {}) => observe({ type: "message_end", message: {
    id, role: "assistant", content: "answer", status: "complete", createdAt: new Date(ts).toISOString(), ...extra,
  } }).message;
  return { task, published, observe, message };
}

test("长任务消息只带汇总，结算仍保留全部去重用量明细", async () => {
  const f = fixture();
  let expected;
  let last;
  for (let i = 0; i < 257; i++) {
    const next = usage(`operation-${i}`);
    expected = addUsage(expected, next);
    last = f.message(`message-${i}`, { usage: next });
    assert.equal(last.task.usage.operations, undefined);
    assert.ok(JSON.stringify(last.task).length < 1000);
  }
  assert.deepEqual(f.task.usage("session", "turn"), expected);
  assert.equal(f.task.usage("session", "turn").operations.length, 257);
  f.message("replayed-message", { usage: usage("operation-0") });
  assert.deepEqual(f.task.usage("session", "turn"), expected);
  await f.task.finish("session", "turn", "completed");
  assert.equal(f.published.at(-1).task.status, "completed");
  assert.equal(f.published.at(-1).task.usage.operations, undefined);
  assert.equal(f.published.at(-1).task.usage.totalTokens, expected.totalTokens);
});

test("流式更新复用摘要，委派和迟到回执使摘要及时更新", async () => {
  const f = fixture();
  const first = f.message("first", { usage: usage("main") });
  const delta = () => f.observe({ type: "message_update", message: {
    id: "stream", role: "assistant", content: "partial", createdAt: "2026-10-01T00:00:00Z",
  } }).message;
  assert.equal(delta().task, first.task);
  assert.equal(first.task.usageIncomplete, false);
  f.observe({ type: "tool_start", toolName: "Task", toolCallId: "child" });
  assert.equal(delta().task.usageIncomplete, true);
  f.observe({ type: "message_end", message: {
    id: "child-message", role: "assistant", content: "child", usage: usage("child"),
  } }, { parentToolCallId: "child" });
  assert.equal(delta().task.usageIncomplete, false);
  await f.task.finish("session", "turn", "completed");
  f.observe({ type: "turn_end", subagentUsage: addUsage(usage("child"), usage("late")) });
  assert.equal(f.task.usage("session", "turn").totalTokens, 30);
  assert.equal(f.task.usage("session", "turn").operations.length, 3);
  assert.equal(f.published.at(-1).task.status, "completed");
  assert.equal(f.published.at(-1).task.usage.totalTokens, 30);
});

test("旧版用量与有归属用量混合时保留原有成本统计", () => {
  const f = fixture();
  const { operationId: _id, aggregation: _aggregation, ...legacy } = usage("legacy");
  const values = [legacy, legacy, legacy, usage("modern")];
  let expected;
  values.forEach((value, i) => {
    expected = addUsage(expected, value);
    f.message(`legacy-${i}`, { usage: value });
  });
  assert.deepEqual(f.task.usage("session", "turn"), expected);
  assert.equal(f.task.usage("session", "turn").costStatus, "reported");
});
