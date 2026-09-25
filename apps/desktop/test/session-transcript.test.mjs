import assert from "node:assert/strict";
import test from "node:test";
import {
  dedupeSessionMessages,
  durableCoversLiveSessionMessages,
  mergeLiveSessionMessages,
  optimisticUserMessage,
  removeLiveSessionMessage,
  reconcilePersistedUserMessage,
  upsertLiveSessionMessage,
} from "../src/lib/session-transcript.ts";

const message = (id, overrides = {}) => ({
  id,
  role: "assistant",
  content: id,
  createdAt: "2026-08-31T00:00:00.000Z",
  ...overrides,
});

test("durable reads keep a live assistant tail that is not persisted yet", () => {
  const durable = [message("user", { role: "user", content: "prompt" })];
  const live = [
    ...durable,
    message("answer", { content: "partial", status: "streaming" }),
  ];

  assert.deepEqual(
    mergeLiveSessionMessages(durable, live).map(({ id, content }) => ({ id, content })),
    [
      { id: "user", content: "prompt" },
      { id: "answer", content: "partial" },
    ],
  );
});

test("a durable completed row remains authoritative over a stale live copy", () => {
  const durable = [message("answer", { content: "final", status: "complete" })];
  const live = [message("answer", { content: "partial", status: "complete" })];

  assert.strictEqual(mergeLiveSessionMessages(durable, live), durable);
});

test("live-only terminal rows are retained when detail arrives during a turn", () => {
  const durable = [message("user", { role: "user", content: "prompt" })];
  const live = [
    ...durable,
    message("answer", { content: "final", status: "complete" }),
  ];

  assert.equal(mergeLiveSessionMessages(durable, live).at(-1).id, "answer");
});

test("a completed live tail is not covered until the durable page has it (D324)", () => {
  const user = message("user", { role: "user", content: "prompt" });
  const answer = message("answer", { content: "final", status: "complete" });
  const durable = [user];
  const live = [user, answer];

  assert.equal(durableCoversLiveSessionMessages(durable, live), false);
  assert.equal(durableCoversLiveSessionMessages([user, answer], live), true);
  assert.equal(durableCoversLiveSessionMessages(durable, undefined), true);
  assert.equal(durableCoversLiveSessionMessages(durable, []), true);
  assert.deepEqual(
    mergeLiveSessionMessages(durable, live).map((row) => row.id),
    ["user", "answer"],
  );
});

test("repeated transcript rows keep one position and the latest value", () => {
  const first = message("user", { role: "user", content: "first" });
  const replacement = message("user", { role: "user", content: "latest" });
  const tail = message("answer", { content: "tail" });
  const tailReplacement = message("answer", { content: "latest tail" });
  const end = message("end", { content: "end" });
  const duplicate = [first, replacement, tail, tailReplacement, end];

  const normalized = dedupeSessionMessages(duplicate);
  assert.deepEqual(normalized.map(({ id, content }) => ({ id, content })), [
    { id: "user", content: "latest" },
    { id: "answer", content: "latest tail" },
    { id: "end", content: "end" },
  ]);
  const unique = [first, tail];
  assert.strictEqual(dedupeSessionMessages(unique), unique);
  assert.deepEqual(
    mergeLiveSessionMessages([first, tail], duplicate).map(({ id, content }) => ({
      id,
      content,
    })),
    [
      { id: "user", content: "first" },
      { id: "answer", content: "tail" },
      { id: "end", content: "end" },
    ],
  );
  assert.deepEqual(
    mergeLiveSessionMessages(duplicate, [first, tail]).map(({ id, content }) => ({
      id,
      content,
    })),
    [
      { id: "user", content: "latest" },
      { id: "answer", content: "latest tail" },
      { id: "end", content: "end" },
    ],
  );
});

test("live event upserts preserve array identity for unchanged rows", () => {
  const original = [message("answer", { status: "streaming" })];
  const updated = upsertLiveSessionMessage(original, {
    ...original[0],
    content: "new partial",
  });

  assert.notStrictEqual(updated, original);
  assert.equal(updated[0].content, "new partial");
  assert.strictEqual(upsertLiveSessionMessage(original, original[0]), original);
  assert.strictEqual(removeLiveSessionMessage(original, "missing"), original);
});

test("optimistic user row carries the prompt and its file references under the renderer id (D288)", () => {
  const row = optimisticUserMessage(
    "11111111-2222-4333-8444-555555555555",
    "look at these",
    [
      { path: "/tmp/shot.png", name: "shot.png" },
      { path: "src/index.ts", name: "index.ts", kind: "file", mimeType: "text/plain" },
      { path: "/tmp/paste-1.txt", name: "paste-1.txt", token: "[paste #1]" },
    ],
    "2026-09-03T00:00:00.000Z",
  );
  assert.deepEqual(row, {
    id: "11111111-2222-4333-8444-555555555555",
    role: "user",
    content: "look at these",
    createdAt: "2026-09-03T00:00:00.000Z",
    status: "complete",
    attachments: [
      { kind: "image", name: "shot.png", ref: "/tmp/shot.png" },
      { kind: "file", name: "index.ts", ref: "src/index.ts", mimeType: "text/plain" },
    ],
  });
  assert.equal(
    "attachments" in optimisticUserMessage("id", "text only"),
    false,
    "a text-only prompt has no attachments key",
  );
});

test("host echo under the same id replaces the optimistic user row in place (D288)", () => {
  const optimistic = optimisticUserMessage("same-id", "/review src", [
    { path: "src/a.ts", name: "a.ts" },
  ]);
  const before = [message("earlier"), optimistic];
  const durable = message("same-id", {
    role: "user",
    content: "Review the code in src",
    command: "/review src",
    attachments: [{ kind: "file", name: "a.ts", ref: "sessions/x/a.ts" }],
  });
  const after = upsertLiveSessionMessage(before, durable);
  assert.equal(after.length, 2);
  assert.equal(after[1], durable);
  // A durable read that already holds the echo wins over the optimistic row;
  // one that does not yet hold it keeps the row visible.
  assert.deepEqual(mergeLiveSessionMessages([message("earlier"), durable], before), [
    message("earlier"),
    durable,
  ]);
  assert.deepEqual(mergeLiveSessionMessages([message("earlier")], before), before);
});

const at = (id, createdAt, overrides = {}) =>
  message(id, { createdAt, content: id, ...overrides });

test("a bounded durable page keeps a longer live history in chronological order (D317)", () => {
  const live = [
    at("old-1", "2026-09-05T00:00:00.000Z", { role: "user" }),
    at("old-2", "2026-09-05T00:00:01.000Z"),
    at("keep-1", "2026-09-05T00:00:02.000Z", { role: "user" }),
    at("keep-2", "2026-09-05T00:00:03.000Z"),
    at("prompt", "2026-09-05T00:00:04.000Z", { role: "user" }),
    at("answer", "2026-09-05T00:00:05.000Z", {
      content: "partial",
      status: "streaming",
    }),
  ];
  const durable = live.slice(2, 5);
  assert.deepEqual(
    mergeLiveSessionMessages(durable, live).map((row) => row.id),
    ["old-1", "old-2", "keep-1", "keep-2", "prompt", "answer"],
  );
});

test("a shifted durable window keeps the live prefix ahead of the new user row (D317)", () => {
  const live = [
    at("drop", "2026-09-05T00:00:00.000Z"),
    at("keep", "2026-09-05T00:00:01.000Z"),
    at("prompt", "2026-09-05T00:00:02.000Z", { role: "user" }),
  ];
  const durable = [
    at("keep", "2026-09-05T00:00:01.000Z"),
    at("prompt", "2026-09-05T00:00:02.000Z", {
      role: "user",
      content: "echoed",
    }),
  ];
  const merged = mergeLiveSessionMessages(durable, live);
  assert.deepEqual(
    merged.map((row) => row.id),
    ["drop", "keep", "prompt"],
  );
  assert.equal(merged.at(-1).content, "echoed");
});

test("older live rows appended after the durable page are healed back in front (D317)", () => {
  const durable = [
    at("keep-1", "2026-09-05T00:00:02.000Z"),
    at("prompt", "2026-09-05T00:00:03.000Z", { role: "user" }),
  ];
  const live = [
    ...durable,
    at("old-1", "2026-09-05T00:00:00.000Z", { role: "user" }),
    at("old-2", "2026-09-05T00:00:01.000Z"),
    at("answer", "2026-09-05T00:00:04.000Z", { status: "streaming" }),
  ];
  assert.deepEqual(
    mergeLiveSessionMessages(durable, live).map((row) => row.id),
    ["old-1", "old-2", "keep-1", "prompt", "answer"],
  );
});

test("an older page prepends ahead of the live window without overlap", () => {
  const older = [
    at("old-1", "2026-09-05T00:00:00.000Z", { role: "user" }),
    at("old-2", "2026-09-05T00:00:01.000Z"),
  ];
  const live = [
    at("keep-1", "2026-09-05T00:00:02.000Z", { role: "user" }),
    at("keep-2", "2026-09-05T00:00:03.000Z"),
  ];
  assert.deepEqual(
    mergeLiveSessionMessages(older, live).map((row) => row.id),
    ["old-1", "old-2", "keep-1", "keep-2"],
  );
});

test("a durable-only new user row stays ahead of a live streaming tail (D317)", () => {
  const live = [
    at("keep", "2026-09-05T00:00:01.000Z"),
    at("answer", "2026-09-05T00:00:03.000Z", { status: "streaming" }),
  ];
  const durable = [
    at("keep", "2026-09-05T00:00:01.000Z"),
    at("prompt", "2026-09-05T00:00:02.000Z", { role: "user" }),
  ];
  assert.deepEqual(
    mergeLiveSessionMessages(durable, live).map((row) => row.id),
    ["keep", "prompt", "answer"],
  );
});

test("缺少任务字段的回执与历史页保留已确认的引导归属", () => {
  const live = message("steer", { role: "user", content: "即时正文", steering: true, taskId: "turn-1" });
  const durable = message("steer", { role: "user", content: "持久正文" });
  const snapshots = [
    upsertLiveSessionMessage([live], durable),
    mergeLiveSessionMessages([durable], [live]),
    dedupeSessionMessages([live, durable]),
    reconcilePersistedUserMessage([live], live.id, { ...durable, id: "durable-steer" }),
  ];
  for (const rows of snapshots) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "持久正文");
    assert.equal(rows[0].taskId, "turn-1");
    assert.equal(rows[0].steering, true);
  }
  const authoritative = { ...durable, taskId: "turn-2", steering: false };
  assert.strictEqual(upsertLiveSessionMessage([live], authoritative)[0], authoritative);
});

test("切回较新的消息窗口时，无共同 ID 的旧提问与流式输出仍按时间合并", () => {
  const prompt = at("prompt", "2026-09-25T01:00:00.000Z", { role: "user", taskId: "task" });
  const firstTool = at("tool-1", "2026-09-25T01:00:01.000Z", { role: "tool", taskId: "task" });
  const commentary = at("commentary", "2026-09-25T01:00:02.000Z", { taskId: "task" });
  const secondTool = at("tool-2", "2026-09-25T01:00:03.000Z", { role: "tool", taskId: "task" });
  const streaming = at("streaming", "2026-09-25T01:00:04.000Z", {
    taskId: "task", status: "streaming", content: "正在继续处理",
  });
  const durable = [firstTool, secondTool];
  const live = [prompt, commentary, streaming];

  const merged = mergeLiveSessionMessages(durable, live);
  assert.deepEqual(merged, [prompt, firstTool, commentary, secondTool, streaming]);
  assert.strictEqual(merged.at(-1), streaming);
  assert.deepEqual(mergeLiveSessionMessages(durable, merged), merged);
  assert.deepEqual(live, [prompt, commentary, streaming]);
  assert.deepEqual(durable, [firstTool, secondTool]);
});

test("旧提问错位到共同消息之间后，切回会话仍能恢复提问在前的顺序", () => {
  const prompt = at("prompt", "2026-09-25T01:00:00.000Z", { role: "user", taskId: "task" });
  const firstTool = at("tool-1", "2026-09-25T01:00:01.000Z", { role: "tool", taskId: "task" });
  const secondTool = at("tool-2", "2026-09-25T01:00:02.000Z", { role: "tool", taskId: "task" });
  const streaming = at("streaming", "2026-09-25T01:00:03.000Z", {
    taskId: "task", status: "streaming",
  });
  const durable = [firstTool, secondTool];
  const live = [firstTool, prompt, secondTool, streaming];

  const merged = mergeLiveSessionMessages(durable, live);
  assert.deepEqual(merged, [prompt, firstTool, secondTool, streaming]);
  assert.deepEqual(mergeLiveSessionMessages(durable, merged), merged);
});
