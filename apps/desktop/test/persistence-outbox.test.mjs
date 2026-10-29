import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";
import { readMainSource } from "./helpers/main-source.mjs";

const silent = () => undefined;

test("a full outbox rejects new input instead of acknowledging a dropped message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-full-"));
  try {
    const entries = Array.from({ length: 1024 }, (_, index) => ({
      key: `message:s:${index}`, sessionId: "s", message: { id: String(index) },
    }));
    await writeFile(join(dir, "session-message-outbox.json"), JSON.stringify(entries));
    const outbox = new PersistenceOutbox(dir, silent);
    await assert.rejects(outbox.enqueue({ key: "new", sessionId: "s", message: { id: "new" } }, () => null), /outbox is full/);
    assert.equal(outbox.size(), 1024);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")), entries);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session delete drops the outbox for that session (D318)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.dropSession\(id\)/);
});

test("handshake drains the outbox before the renderer can hydrate (D327)", async () => {
  const main = await readMainSource();
  assert.match(main, /await persistenceOutbox\.flush\(\(\) => host\)/);
  assert.doesNotMatch(main, /void persistenceOutbox\.flush\(\(\) => host\)/);
  assert.match(main, /session\.recoverInflightMessages/);
});

test("message_end checkpoints the finished snapshot before settling (D327)", async () => {
  const main = await readMainSource();
  assert.match(
    main,
    /event\.type === "message_end"[\s\S]*inflightCheckpointer\.observe\([\s\S]*settleIf\(sessionId, finalId\)/,
  );
});

test("deleting a session drops its queued outbox entries (D318)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(
    {
      key: "message:keep:a",
      sessionId: "keep",
      message: { id: "a" },
    },
    () => null,
  );
  await outbox.enqueue(
    {
      key: "message:gone:b",
      sessionId: "gone",
      message: { id: "b" },
    },
    () => null,
  );
  assert.equal(outbox.size(), 2);
  await outbox.dropSession("gone");
  assert.equal(outbox.size(), 1);
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.deepEqual(
    stored.map((entry) => entry.sessionId),
    ["keep"],
  );
});

test("替换历史等待在途消息的成功回执", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-replace-"));
  const outbox = new PersistenceOutbox(dir, silent);
  let releaseAppend;
  let appendStarted;
  const started = new Promise((resolve) => { appendStarted = resolve; });
  const blockedAppend = new Promise((resolve) => { releaseAppend = resolve; });
  const host = mockHost(async () => {
    appendStarted();
    await blockedAppend;
  });

  await outbox.enqueue(
    {
      key: "message:replace-session:assistant-1",
      sessionId: "replace-session",
      message: { id: "assistant-1", role: "assistant", content: "obsolete" },
    },
    () => host,
  );
  await started;

  let replacementReady = false;
  const preparing = outbox
    .prepareSessionReplacement("replace-session", () => host, async () => { replacementReady = true; });
  await Promise.resolve();
  assert.equal(replacementReady, false, "replacement must wait for the active append");

  releaseAppend();
  await preparing;
  assert.equal(replacementReady, true);
  assert.equal(outbox.size(), 0);
});

test("替换历史遇到落盘失败时保留消息并拒绝覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-replace-failed-"));
  try {
    const outbox = new PersistenceOutbox(dir, silent);
    await outbox.enqueue({ key: "message:s:a", sessionId: "s", message: { id: "a" } }, () => null);
    const host = mockHost(async () => { throw new Error("disk full"); });
    let replaced = false;
    await assert.rejects(outbox.prepareSessionReplacement("s", () => host, async () => { replaced = true; }), /未成功保存/);
    assert.equal(replaced, false);
    assert.equal(outbox.size(), 1);
    const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
    assert.equal(stored[0].message.id, "a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function mockHost(handler) {
  return {
    isAvailable: () => true,
    call: async (method, params) => handler(method, params),
  };
}

test("消息 ID 冲突须等待 host 成功回执后才能确认覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const acknowledged = [];
  const outbox = new PersistenceOutbox(dir, silent);
  outbox.setOnMessagePersisted((sessionId) => { acknowledged.push(sessionId); });
  let fail = true;
  const host = mockHost(async () => {
    if (fail) throw new Error("UNIQUE constraint failed: messages.id");
  });
  const getHost = () => host;
  try {
    await outbox.enqueue(
      { key: "message:s1:call_421522", sessionId: "s1", message: { id: "call_421522" } },
      getHost,
    );
    await outbox.enqueue(
      { key: "message:s2:assistant-1", sessionId: "s2", message: { id: "assistant-1" } },
      getHost,
    );
    await outbox.flush(getHost);
    assert.equal(outbox.size(), 2);
    assert.deepEqual(acknowledged, []);
    fail = false;
    await outbox.flush(getHost);
    assert.equal(outbox.size(), 0);
    assert.deepEqual(acknowledged, ["s1", "s2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a full outbox rejects an entry instead of reporting it enqueued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-full-"));
  const path = join(dir, "session-message-outbox.json");
  const entries = Array.from({ length: 1024 }, (_, index) => ({
    key: `message:s${index}:m${index}`,
    sessionId: `s${index}`,
    message: { id: `m${index}` },
  }));
  await writeFile(path, JSON.stringify(entries), "utf8");
  const logs = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });

  await assert.rejects(
    outbox.enqueue(
      { key: "message:last:missing", sessionId: "last", message: { id: "missing" } },
      () => null,
    ),
    /outbox is full/i,
  );
  assert.equal(outbox.size(), 1024);
  assert.equal(JSON.parse(await readFile(path, "utf8")).length, 1024);
  assert.ok(
    logs.some(
      (entry) =>
        entry.message === "session persistence outbox is full" &&
        entry.data?.key === "message:last:missing",
    ),
  );
});

test("non-unique flush errors still pause the outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("session not found");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});

test("poisoned provenance message is isolated without loss or forged success receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const acknowledged = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  outbox.setOnMessagePersisted((sessionId) => { acknowledged.push(sessionId); });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    if (params.message.id === "steering-poison") {
      throw new Error("PERMISSION_DENIED: transcript input does not match its session delivery");
    }
  });
  const getHost = () => host;
  try {
    await outbox.enqueue(
      {
        key: "message:s1:steering-poison",
        sessionId: "s1",
        message: { id: "steering-poison", role: "user", steering: true },
      },
      getHost,
    );
    await outbox.enqueue(
      {
        key: "message:s2:assistant-1",
        sessionId: "s2",
        message: { id: "assistant-1", role: "assistant" },
      },
      getHost,
    );
    await outbox.flush(getHost);
    // 后排先行但坏头不丢、不确认：只确认成功写入的那条。
    assert.equal(outbox.size(), 1);
    assert.ok(calls.some((params) => params.message.id === "assistant-1"));
    assert.deepEqual(acknowledged, ["s2"]);
    assert.ok(
      logs.some((row) => row.message === "session persistence flush deferred poisoned message"),
    );
    const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
    assert.deepEqual(
      stored.map((entry) => entry.message.id),
      ["steering-poison"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate message id is isolated without forged success receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const acknowledged = [];
  const outbox = new PersistenceOutbox(dir, silent);
  outbox.setOnMessagePersisted((sessionId) => { acknowledged.push(sessionId); });
  const host = mockHost(async (_method, params) => {
    if (params.message.id === "dup-head") {
      throw new Error("UNIQUE constraint failed: messages.id");
    }
  });
  const getHost = () => host;
  try {
    await outbox.enqueue(
      { key: "message:s1:dup-head", sessionId: "s1", message: { id: "dup-head" } },
      getHost,
    );
    await outbox.enqueue(
      { key: "message:s2:good-tail", sessionId: "s2", message: { id: "good-tail" } },
      getHost,
    );
    await outbox.flush(getHost);
    assert.equal(outbox.size(), 1);
    assert.deepEqual(acknowledged, ["s2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PLUGIN_PERMISSION_DENIED is not poison and still pauses the outbox (D597)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const host = mockHost(async () => {
    throw new Error("PLUGIN_PERMISSION_DENIED: missing grant for fs.write");
  });
  const getHost = () => host;
  await outbox.enqueue(
    { key: "message:s1:a", sessionId: "s1", message: { id: "a" } },
    getHost,
  );
  await outbox.enqueue(
    { key: "message:s2:b", sessionId: "s2", message: { id: "b" } },
    getHost,
  );
  await outbox.flush(getHost);
  assert.equal(outbox.size(), 2);
});

for (const mutation of ["delete", "replace"]) {
  for (const failure of ["UNIQUE constraint failed: messages.id", "PERMISSION_DENIED: invalid provenance", "host is busy"]) {
    test(`旧失败回执不延后并发${mutation}后的消息：${failure}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-outbox-receipt-"));
      const outbox = new PersistenceOutbox(dir, silent);
      const started = Promise.withResolvers();
      const receipt = Promise.withResolvers();
      const acknowledged = [];
      outbox.setOnMessagePersisted((sessionId) => { acknowledged.push(sessionId); });
      const original = { key: "message:s1:a", sessionId: "s1", message: { id: "old" } };
      await outbox.enqueue(original, () => null);
      await outbox.enqueue({ key: "message:s2:b", sessionId: "s2", message: { id: "tail" } }, () => null);
      await outbox.flush(() => null);
      const delivered = [];
      const host = mockHost(async (_method, params) => {
        if (params.message.id === "old") {
          started.resolve();
          await receipt.promise;
          throw new Error(failure);
        }
        delivered.push(params.message.id);
      });
      const flushing = outbox.flush(() => host);
      try {
        await started.promise;
        if (mutation === "delete") await outbox.dropSession("s1");
        else await outbox.enqueue({ ...original, message: { id: "new" } }, () => host);
        receipt.resolve();
        await flushing;
        assert.equal(outbox.size(), 0);
        assert.deepEqual(delivered, mutation === "delete" ? ["tail"] : ["new", "tail"]);
        assert.deepEqual(acknowledged, mutation === "delete" ? ["s2"] : ["s1", "s2"]);
        assert.deepEqual(JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")), []);
      } finally {
        receipt.resolve();
        await flushing;
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("foreign key orphan is dropped without a receipt and later entries still drain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const logs = [];
  const acknowledged = [];
  const outbox = new PersistenceOutbox(dir, (level, message, data) => {
    logs.push({ level, message, data });
  });
  outbox.setOnMessagePersisted((sessionId) => { acknowledged.push(sessionId); });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params.message.id);
    if (params.message.id === "orphaned-child") throw new Error("Error: FOREIGN KEY constraint failed");
  });
  const getHost = () => host;
  try {
    await outbox.enqueue({ key: "message:s1:orphaned-child", sessionId: "s1", message: { id: "orphaned-child" } }, getHost);
    await outbox.enqueue({ key: "message:s2:healthy", sessionId: "s2", message: { id: "healthy" } }, getHost);
    await outbox.flush(getHost);
    assert.equal(outbox.size(), 0);
    assert.deepEqual(calls, ["orphaned-child", "healthy"]);
    assert.deepEqual(acknowledged, ["s2"]);
    assert.ok(logs.some((row) => row.message === "session persistence flush dropped orphaned message"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


/** Let every pending microtask settle before counting host calls. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drain with the retry backoff clock advanced past every window, returning the
 * number of appends still queued.
 */
async function drain(outbox, host, now, steps = 12) {
  for (let step = 0; step < steps && outbox.size() > 0; step += 1) {
    now.value += 60_000;
    await outbox.flush(() => host);
  }
  return outbox.size();
}

test("连续失败消息留在原队列，后续消息仍可落盘且回执真实", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const acknowledged = [];
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  outbox.setOnMessagePersisted((sessionId) => acknowledged.push(sessionId));
  let failing = true;
  const host = mockHost(async (_method, params) => {
    if (failing && params.message.id === "torn") throw new Error("invalid UTF-8");
  });
  try {
    await outbox.enqueue({ key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } }, () => host);
    await outbox.enqueue({ key: "message:s2:healthy", sessionId: "s2", message: { id: "healthy" } }, () => host);
    assert.equal(await drain(outbox, host, now), 1);
    assert.deepEqual(acknowledged, ["s2"]);
    const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
    assert.deepEqual(stored.map((entry) => entry.key), ["message:s1:torn"]);
    assert.equal(stored[0].message.id, "torn");
    failing = false;
    now.value += 60_000;
    await outbox.flush(() => host);
    assert.equal(outbox.size(), 0);
    assert.deepEqual(acknowledged, ["s2", "s1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing head waits out its backoff before the host is called again (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const calls = [];
  const host = mockHost(async (_method, params) => {
    calls.push(params);
    throw new Error("host is busy");
  });
  const getHost = () => host;
  await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, getHost);
  await outbox.flush(getHost);
  await settle();
  const afterFirstFailure = calls.length;
  assert.ok(afterFirstFailure >= 1);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await outbox.flush(getHost);
  }
  await settle();
  assert.equal(calls.length, afterFirstFailure, "no retry inside the backoff window");

  now.value += 120_000;
  await outbox.flush(getHost);
  await settle();
  assert.equal(calls.length, afterFirstFailure + 1, "the head is retried once its backoff elapses");
  assert.equal(outbox.size(), 1, "an unclassified failure still pauses instead of dropping");
});

test("反复失败消息重启后仍可重试，删除会话才移除其消息", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const failing = mockHost(async () => { throw new Error("invalid UTF-8"); });
  try {
    await outbox.enqueue({ key: "message:s1:torn", sessionId: "s1", message: { id: "torn" } }, () => failing);
    assert.equal(await drain(outbox, failing, now), 1);
    const reopened = new PersistenceOutbox(dir, silent, { now: () => now.value });
    const recovered = [];
    await reopened.flush(() => mockHost(async (_method, params) => recovered.push(params.message.id)));
    assert.equal(reopened.size(), 0);
    assert.deepEqual(recovered, ["torn"]);
    await reopened.enqueue({ key: "message:gone:torn", sessionId: "gone", message: { id: "torn" } }, () => failing);
    assert.equal(await drain(reopened, failing, now), 1);
    await reopened.dropSession("gone");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("替换同一消息快照不继承旧快照的退避等待", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const outbox = new PersistenceOutbox(dir, silent, { now: () => 0 });
  const host = mockHost(async (_method, params) => {
    if (!params.message.fixed) throw new Error("invalid UTF-8");
  });
  try {
    await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, () => host);
    await outbox.flush(() => host);
    await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a", fixed: true } }, () => host);
    await outbox.flush(() => host);
    assert.equal(outbox.size(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restarted host retries the paused head without waiting out the backoff (#1560)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const calls = [];
  const failing = mockHost(async (_method, params) => {
    calls.push(params.message.id);
    throw new Error("host is busy");
  });
  await outbox.enqueue({ key: "message:s1:a", sessionId: "s1", message: { id: "a" } }, () => failing);
  await outbox.flush(() => failing);
  await settle();
  const paused = calls.length;
  assert.ok(paused >= 1, "the head was attempted against the failing generation");

  await outbox.flush(() => failing);
  assert.equal(calls.length, paused, "the same generation waits out the backoff");

  const restarted = mockHost(async (_method, params) => {
    calls.push(params.message.id);
  });
  await outbox.flush(() => restarted);
  assert.equal(outbox.size(), 0, "a fresh host generation drains the paused head at once");
  assert.equal(calls.length, paused + 1);
});

test("tool images persist once while flush restores all four business copies (#1868)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-images-"));
  const data = "AAABBBcccDDDeeeFFF0123456789+/==";
  const result = { content: [{ type: "image", mimeType: "image/png", data }], details: { images: [{ mimeType: "image/png", data, extra: "kept" }] } };
  const message = { id: "image", role: "tool", content: JSON.stringify(result, null, 2), toolResult: result, metadata: { unknown: [1, "unchanged"] } };
  const entry = { key: "message:s:image", sessionId: "s", message };
  await new PersistenceOutbox(dir, silent).enqueue(entry, () => null);
  const raw = await readFile(join(dir, "session-message-outbox.json"), "utf8");
  assert.equal(raw.split(data).length - 1, 1, "disk must retain only one image data string");
  const calls = [];
  const reloaded = new PersistenceOutbox(dir, silent);
  await reloaded.flush(() => mockHost(async (method, params) => { calls.push({ method, params }); }));
  assert.deepEqual(calls, [{ method: "session.appendMessage", params: { sessionId: "s", message, turnId: undefined } }]);
});

test("ID mutation refuses an undrained target session and retains every queued entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-mutation-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue({ key: "message:s:a", sessionId: "s", message: { id: "a" } }, () => null);
  await assert.rejects(outbox.prepareSessionMutation("s", () => null), (error) => error.errorCode === "HOST_UNAVAILABLE");
  assert.equal(outbox.size(), 1);
  await outbox.prepareSessionMutation("other", () => null);
  assert.equal(outbox.size(), 1);
  await outbox.prepareSessionMutation("s", () => mockHost(async () => undefined));
  assert.equal(outbox.size(), 0);
});

test("legacy array messages and usage retain unknown fields after reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-legacy-"));
  const entries = [
    { key: "message:s:m", sessionId: "s", message: { id: "m", unknown: { nested: ["literal", 42] } }, unknown: "entry" },
    { key: "usage:s:t", sessionId: "s", turnId: "t", usage: { tokens: 17, details: { arbitrary: [1, 2] } } },
  ];
  await writeFile(join(dir, "session-message-outbox.json"), JSON.stringify(entries));
  const calls = [];
  await new PersistenceOutbox(dir, silent).flush(() => mockHost(async (method, params) => { calls.push({ method, params }); }));
  assert.deepEqual(calls, [
    { method: "session.appendMessage", params: { sessionId: "s", message: entries[0].message, turnId: undefined } },
    { method: "session.recordUsage", params: { sessionId: "s", usage: entries[1].usage, turnId: "t" } },
  ]);
});

test("失败图片消息无损保留在原队列，重启及后续入队不丢失内容", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-dead-images-"));
  const now = { value: 0 };
  const data = "longImageData1234567890+/==";
  const result = { content: [{ type: "image", mimeType: "image/png", data }], images: [{ mimeType: "image/png", data }] };
  const message = { id: "image", content: JSON.stringify(result), toolResult: result, extra: { unknown: true } };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const rejecting = mockHost(async () => { throw new Error("unclassified failure"); });
  await outbox.enqueue({ key: "message:s:image", sessionId: "s", message }, () => rejecting);
  assert.equal(await drain(outbox, rejecting, now), 1);
  const path = join(dir, "session-message-outbox.json");
  const first = await readFile(path, "utf8");
  assert.equal(first.split(data).length - 1, 1);
  const reloaded = new PersistenceOutbox(dir, silent, { now: () => now.value });
  await reloaded.enqueue({ key: "message:other:m", sessionId: "other", message: { id: "m" } }, () => rejecting);
  assert.equal(await drain(reloaded, rejecting, now), 2);
  const dead = JSON.parse(await readFile(path, "utf8"));
  assert.equal(dead.length, 2);
  const { decodeBinaryStorage } = await import("@pi-desktop/host-runtime");
  assert.deepEqual(decodeBinaryStorage(dead.find((entry) => entry.key === "message:s:image")).message, message);
  assert.equal(dead.find((entry) => entry.key === "message:other:m").message.id, "m");
});

test("corrupt encoded outbox entries reject recovery and preserve the disk file", async () => {
  for (const file of ["session-message-outbox.json"]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-outbox-corrupt-"));
    const path = join(dir, file);
    const raw = JSON.stringify([{ key: "message:s:m", sessionId: "s", message: { id: "m" }, binaryStorage: { version: 99, data: [], refs: [], texts: [] } }]);
    await writeFile(path, raw);
    const logs = [];
    const outbox = new PersistenceOutbox(dir, (_level, message) => logs.push(message));
    await assert.rejects(outbox.flush(() => null), /binary storage/i);
    await assert.rejects(outbox.enqueue({ key: "message:s:new", sessionId: "s", message: { id: "new" } }, () => null), /binary storage/i);
    assert.equal(await readFile(path, "utf8"), raw);
    assert.ok(logs.some((message) => /load failed/.test(message)));
  }
});

test("mutation waits for active append and refuses a backed-off target without dropping it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-mutation-flight-"));
  let release;
  let appendStarted;
  const started = new Promise((resolve) => { appendStarted = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const host = mockHost(async () => { appendStarted(); await blocked; throw new Error("host unavailable"); });
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue({ key: "message:s:m", sessionId: "s", message: { id: "m" } }, () => host);
  await started;
  let settled = false;
  const preparing = assert.rejects(outbox.prepareSessionMutation("s", () => host), (error) => error.errorCode === "HOST_UNAVAILABLE").then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await preparing;
  assert.equal(outbox.size(), 1);
  await assert.rejects(outbox.prepareSessionMutation("s", () => host), (error) => error.errorCode === "HOST_UNAVAILABLE");
  const stored = JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8"));
  assert.equal(stored[0].message.id, "m");
});


for (const failure of ["PERMISSION_DENIED: invalid provenance", "FOREIGN KEY constraint failed"]) {
  test(`strict mutation preserves a pending append rejected with ${failure}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-outbox-strict-reject-"));
    const outbox = new PersistenceOutbox(dir, silent);
    const entry = { key: "message:s:m", sessionId: "s", message: { id: "m", content: "must survive" } };
    let started;
    let release;
    const called = new Promise((resolve) => { started = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const host = mockHost(async () => { started(); await blocked; throw new Error(failure); });
    await outbox.enqueue(entry, () => host);
    await called;
    const preparing = assert.rejects(outbox.prepareSessionMutation("s", () => host), (error) => error.errorCode === "HOST_UNAVAILABLE");
    release();
    await preparing;
    assert.equal(outbox.size(), 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")), [entry]);
    await outbox.flush(() => host);
    assert.equal(outbox.size(), failure.startsWith("FOREIGN KEY") ? 0 : 1);
  });
}

test("strict mutation retains the fifth transient failure instead of quarantining it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-strict-quarantine-"));
  const now = { value: 0 };
  const outbox = new PersistenceOutbox(dir, silent, { now: () => now.value });
  const entry = { key: "message:s:m", sessionId: "s", message: { id: "m", content: "must survive" } };
  let attempts = 0;
  const host = mockHost(async () => { attempts++; throw new Error("unclassified refusal"); });
  await outbox.enqueue(entry, () => host);
  await outbox.flush(() => host);
  for (let attempt = 1; attempt < 4; attempt++) {
    now.value += 60_000;
    await outbox.flush(() => host);
  }
  assert.equal(attempts, 4);
  now.value += 60_000;
  await assert.rejects(outbox.prepareSessionMutation("s", () => host), (error) => error.errorCode === "HOST_UNAVAILABLE");
  assert.equal(attempts, 5);
  assert.equal(outbox.size(), 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")), [entry]);
  await assert.rejects(readFile(join(dir, "session-message-outbox.dead-letter.json")), (error) => error.code === "ENOENT");
});

test("concurrent strict drains preserve all target sessions across an active normal flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-strict-concurrent-"));
  const outbox = new PersistenceOutbox(dir, silent);
  const entries = ["a", "b"].map((sessionId) => ({ key: `message:${sessionId}:m`, sessionId, message: { id: sessionId } }));
  for (const entry of entries) await outbox.enqueue(entry, () => null);
  let started;
  let release;
  let calls = 0;
  const called = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const host = mockHost(async () => { calls++; started(); await blocked; throw new Error("PERMISSION_DENIED: refusal"); });
  const ordinary = outbox.flush(() => host);
  await called;
  const preparing = entries.map((entry) => assert.rejects(outbox.prepareSessionMutation(entry.sessionId, () => host), (error) => error.errorCode === "HOST_UNAVAILABLE"));
  release();
  await Promise.all([ordinary, ...preparing]);
  assert.equal(outbox.size(), 2);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "session-message-outbox.json"), "utf8")), entries);
});

test("历史修改不能用重复消息 ID 错误代替持久化成功回执", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-strict-duplicate-"));
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue({ key: "message:s:m", sessionId: "s", message: { id: "m" } }, () => null);
  await assert.rejects(outbox.prepareSessionMutation("s", () => mockHost(async () => { throw new Error("UNIQUE constraint failed: messages.id"); })), (error) => error.errorCode === "HOST_UNAVAILABLE");
  assert.equal(outbox.size(), 1);
});

test("delayed consumption of a rejected outbox load stays observed and fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-load-observer-"));
  await writeFile(join(dir, "session-message-outbox.json"), "invalid JSON");
  const moduleUrl = new URL("../electron/main/persistence-outbox.ts", import.meta.url).href;
  const source = `
    import assert from "node:assert/strict";
    import { PersistenceOutbox } from ${JSON.stringify(moduleUrl)};
    const unhandled = [];
    process.on("unhandledRejection", (error) => unhandled.push(String(error)));
    let loaded;
    const loadReported = new Promise((resolve) => { loaded = resolve; });
    const logs = [];
    const outbox = new PersistenceOutbox(${JSON.stringify(dir)}, (level, message) => { logs.push({ level, message }); loaded(); });
    await loadReported;
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual(unhandled, [], "constructor must observe load rejection before a later caller awaits it");
    assert.ok(logs.some((entry) => entry.level === "error"), "load rejection remains observable");
    await assert.rejects(outbox.flush(() => null), SyntaxError);
    await assert.rejects(outbox.enqueue({ key: "new", sessionId: "s", message: { id: "new" } }, () => null), SyntaxError);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
