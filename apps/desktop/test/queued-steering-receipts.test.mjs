import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QueuedSteeringReceipts, createQueuedSteeringJournal } from "../electron/main/queued-steering-receipts.ts";

const intent = { queuedTurnId: "queued-1", sessionId: "s1", messageId: "message-1", expectedTurnId: "turn-1" };
const message = { id: intent.messageId, role: "user", content: "follow up", status: "complete", createdAt: "2026-09-17T00:00:00Z", steering: true, taskId: intent.expectedTurnId };
const silent = () => {};
async function withDirectory(run) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "queued-steering-test-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("pending transfers remain quarantined after restarting the journal", () => withDirectory(async (dir) => {
  await new QueuedSteeringReceipts(dir, silent).begin(intent);
  const restored = new QueuedSteeringReceipts(dir, silent);
  assert.equal((await restored.get(intent.queuedTurnId)).state, "pending");
  let appends = 0;
  const journal = createQueuedSteeringJournal({ receipts: restored, outbox: { enqueue: async () => { appends++; } }, getHost: () => null });
  await assert.rejects(journal.settle(intent.queuedTurnId), /no accepted/);
  assert.equal(appends, 0);
  assert.equal((await restored.list()).length, 1);
}));

test("accepted transfer retries the same echo after an outbox failure", () => withDirectory(async (dir) => {
  const receipts = new QueuedSteeringReceipts(dir, silent);
  await receipts.begin(intent);
  await receipts.accept(intent.queuedTurnId, { turnId: intent.expectedTurnId, message });
  const restored = new QueuedSteeringReceipts(dir, silent);
  const appends = [];
  let fail = true;
  const journal = createQueuedSteeringJournal({ receipts: restored, outbox: { enqueue: async (entry) => {
    appends.push(entry);
    if (fail) throw new Error("outbox unavailable");
  } }, getHost: () => null });
  await assert.rejects(journal.settle(intent.queuedTurnId), /outbox unavailable/);
  assert.equal((await restored.get(intent.queuedTurnId)).state, "accepted");
  fail = false;
  await journal.settle(intent.queuedTurnId);
  assert.deepEqual(appends[0], appends[1]);
  assert.equal(appends[1].key, "message:s1:message-1");
  assert.equal(appends[1].message.taskId, "turn-1", "the replay keeps the owning turn");
  await journal.complete(intent.queuedTurnId);
  assert.deepEqual(await new QueuedSteeringReceipts(dir, silent).list(), []);
}));

test("corrupt receipts never look like a fresh queue", () => withDirectory(async (dir) => {
  await writeFile(join(dir, "queued-steering-receipts.json"), "{incomplete");
  const receipts = new QueuedSteeringReceipts(dir, silent);
  await assert.rejects(receipts.list());
  await assert.rejects(receipts.begin(intent));
}));

test("a failed receipt clear keeps the last accepted state", () => withDirectory(async (dir) => {
  const receipts = new QueuedSteeringReceipts(dir, silent);
  await receipts.begin(intent);
  await receipts.accept(intent.queuedTurnId, { turnId: intent.expectedTurnId, message });
  await mkdir(join(dir, "queued-steering-receipts.json.tmp"));
  await assert.rejects(receipts.settle(intent.queuedTurnId));
  assert.equal((await receipts.get(intent.queuedTurnId)).state, "accepted");
  const disk = JSON.parse(await readFile(join(dir, "queued-steering-receipts.json"), "utf8"));
  assert.equal(disk[0].state, "accepted");
}));
