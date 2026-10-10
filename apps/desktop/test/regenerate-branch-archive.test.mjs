import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { projectMessageEnd, projectMessageUpdate } = await import("../src/lib/session-transcript.ts");

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const agentEndBlock = () => {
  const main = readMainModuleSync("runtime/event-persistence.ts");
  const start = main.indexOf('if (event.type === "agent_end")');
  assert.ok(start > 0, "agent_end branch exists");
  const end = main.indexOf('if (event.type === "message_end"', start);
  assert.ok(end > start, "agent_end branch is bounded by the next event branch");
  return main.slice(start, end);
};

test("turn completion archives the regenerate branch in one host call", () => {
  const block = agentEndBlock();

  // The archive must not read the transcript, decide, and write it back: the
  // final assistant message can land in between (ADR 0060).
  assert.doesNotMatch(block, /"session\.replaceMessages"/);
  assert.doesNotMatch(block, /"session\.get"/);
  assert.doesNotMatch(block, /"session\.saveRevision"/);
  assert.doesNotMatch(block, /"session\.listRevisions"/);
  assert.match(block, /"session\.saveActiveRevision"/);
});

test("the outbox is drained before a branch is archived", () => {
  const block = agentEndBlock();

  assert.match(block, /persistenceOutbox\.size\(\) > 0/);
  assert.match(block, /await persistenceOutbox\.flush\(\(\) => runtimeState\.host\)/);
  // An archive that misses the final message is wrong forever once the pager
  // restores it, so a still-pending outbox skips the archive instead.
  assert.match(block, /skipped regenerate branch archive/);
});

test("the host owns the branch root search and the pager stamp", () => {
  const host = read("../../../crates/host-core/src/sessions.rs");
  const rpc = read("../../../crates/host-core/src/rpc/mod.rs");
  const transcripts = read("../../../crates/host-core/src/transcripts.rs");

  assert.match(rpc, /"session\.saveActiveRevision" => \{/);
  assert.match(host, /pub fn save_active_branch_revision\(/);
  // The stamp rewrites one line and re-reads the file, so a concurrent append
  // survives; a full rewrite from a stale snapshot would delete it.
  assert.match(host, /transcripts::update_message\(db\.data_dir\(\), session_id, &record\)/);
  assert.match(transcripts, /pub fn update_message\(/);
  assert.match(transcripts, /fs::read_to_string\(&path\)/);
});

test("a transcript rewrite keeps each message's owning turn", () => {
  const host = read("../../../crates/host-core/src/sessions.rs");

  assert.match(host, /SELECT id, turn_id FROM messages/);
  assert.match(host, /owning_turns\.get\(&record\.id\)\.map\(String::as_str\)/);
});

test("新轮归档只原位更新分叉根，不把窗口外或其他分支的旧消息追加到末尾", async () => {
  const root = {
    id: "old-root", role: "user", content: "直接实施",
    createdAt: "2026-10-09T00:00:00.000Z", status: "complete",
    revisionRootId: "family", revisionCount: 2, activeRevision: 2,
    taskId: "old-task",
  };
  const tail = [
    { id: "new-prompt", role: "user", content: "拆成独立页面", createdAt: "2026-10-09T01:00:00.000Z" },
    { id: "new-answer", role: "assistant", content: "已完成", createdAt: "2026-10-09T01:10:00.000Z" },
  ];
  const windows = [
    tail,
    [{ ...root, revisionCount: 1, activeRevision: 1 }, ...tail],
    [{ ...root, id: "other-branch-root", activeRevision: 1 }, ...tail],
    [],
  ];
  for (const initial of windows) {
    let messages = initial;
    const errors = [];
    const persistence = createEventPersistence({
      runtimeState: { host: { call: async (method) => {
        assert.equal(method, "session.saveActiveRevision");
        return { saved: { root } };
      } } },
      steeringReplies: new Set(),
      activeTurns: new Map([["session", "new-task"]]),
      activeToolCalls: new Map(),
      activeToolCallKey: (session, tool) => `${session}:${tool}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      planSubmissionTurnKey: (session, turn) => `${session}:${turn}`,
      inflightCheckpointer: {},
      persistenceOutbox: { size: () => 0 },
      addActiveTurnUsage: () => {},
      logger: { app: (...args) => errors.push(args) },
      finishTurn: async () => {},
      isStaleTerminalEvent: () => false,
      finishApprovedExecution: async () => {},
      emitAgentEvent: ({ event }) => {
        if (event.type === "message_end") messages = projectMessageEnd(messages, event);
        else if (event.type === "message_update") messages = projectMessageUpdate(messages, event);
        else assert.fail(`Unexpected event: ${event.type}`);
      },
    });
    persistence.persistAgentEvent({
      sessionId: "session", turnId: "new-task", ts: Date.now(),
      event: { type: "agent_end", messageIds: ["new-answer"] },
    });
    await persistence.flush();

    assert.deepEqual(errors, []);
    assert.deepEqual(messages.map(({ id }) => id), initial.map(({ id }) => id));
    if (initial.some(({ id }) => id === root.id)) {
      assert.deepEqual(messages[0], root);
      assert.equal(messages[0].taskId, "old-task");
      assert.deepEqual(messages.slice(1), tail);
    } else {
      assert.strictEqual(messages, initial);
    }
  }
});
