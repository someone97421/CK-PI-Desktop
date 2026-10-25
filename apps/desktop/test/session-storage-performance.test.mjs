import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStorageService, noteSessionStorageActivity } from "../electron/main/services/session-storage.ts";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "session-storage-perf-"));
  const scratch = join(dataDir, "scratch", "one");
  await mkdir(join(scratch, "pasted"), { recursive: true });
  await writeFile(join(scratch, "temp.txt"), "temp");
  await writeFile(join(scratch, "pasted", "keep.txt"), "keep");
  let reads = 0, busy = false, gate = Promise.resolve();
  const service = new SessionStorageService({
    dataDir, available: () => true, listSessions: async () => [{ id: "one" }],
    getSession: async () => { reads++; await gate; return { id: "one" }; },
    isBusy: async () => busy, acquire: async () => () => {}, log: () => {},
  });
  t.after(async () => { service.stop(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir, scratch, reads: () => reads,
    busy: (value) => { busy = value; }, gate: (value) => { gate = value; } };
}

test("占用统计合并在途扫描、复用缓存，但实时刷新运行状态", async (t) => {
  const h = await fixture(t);
  const [first, second] = await Promise.all([h.service.usage("one", "a"), h.service.usage("one", "b")]);
  assert.deepEqual(first, second);
  assert.equal(first.totalBytes, 8);
  assert.equal(h.reads(), 1);
  h.busy(true);
  assert.equal((await h.service.usage("one")).busy, true);
  assert.equal(h.reads(), 1);
  await noteSessionStorageActivity(h.dataDir, "one");
  await h.service.usage("one");
  assert.equal(h.reads(), 2, "新的会话活动使缓存失效");
});

test("取消一个读者不影响共享扫描，最后一个读者离开才停止", async (t) => {
  const h = await fixture(t);
  const gate = Promise.withResolvers(); h.gate(gate.promise);
  const first = h.service.usage("one", "a");
  const second = h.service.usage("one", "b");
  const rejected = assert.rejects(first, { name: "AbortError" });
  h.service.cancelUsage("one", "a");
  gate.resolve();
  await rejected;
  assert.equal((await second).temporaryBytes, 4);
  assert.equal(h.reads(), 1);
});

test("取消全部读者后，新请求不会复用已取消扫描", async (t) => {
  const h = await fixture(t);
  const gate = Promise.withResolvers(); h.gate(gate.promise);
  const pending = h.service.usage("one", "old");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  h.service.cancelUsage("one", "old");
  const fresh = h.service.usage("one", "new");
  gate.resolve();
  await rejected;
  assert.equal((await fresh).totalBytes, 8);
  assert.equal(h.reads(), 2);
});

test("手动清理使占用缓存失效并保留附件", async (t) => {
  const h = await fixture(t);
  await h.service.usage("one");
  const result = await h.service.clean("one");
  assert.equal(result.freedBytes, 4);
  assert.equal(result.usage.temporaryBytes, 0);
  assert.equal(result.usage.retainedBytes, 4);
  assert.equal(await readFile(join(h.scratch, "pasted", "keep.txt"), "utf8"), "keep");
});
