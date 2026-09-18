import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
