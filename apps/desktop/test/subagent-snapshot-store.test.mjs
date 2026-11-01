import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { SubagentSnapshotStore } = await import("../electron/main/runtime/subagent-snapshot-store.ts");

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-side-path-"));
  const options = { dataDir: dir, sessionAuthority: async () => ({ projectRealPath: dir, watermark: "changed-history" }) };
  const store = new SubagentSnapshotStore(options);
  await store.initialize();
  await store.setEnabled(true);
  const owner = await store.claimSession({ sessionId: "session", runtimeInstanceId: "runtime" });
  const request = async (execution, id = "task") => {
    const executionId = `${id}:${execution}`;
    const receipt = await store.beginExecution({ sessionId: "session", delegationId: id, expectedExecution: execution - 1,
      expectedRevision: 0, nextExecution: execution, executionId, instanceGeneration: owner.instanceGeneration,
      commandId: executionId, commandDigest: "fixture", parentToolCallId: id });
    return { sessionId: "session", delegationId: id, expectedExecution: execution, expectedRevision: receipt.revision,
      executionId, instanceGeneration: owner.instanceGeneration, targetGeneration: execution,
      checkpoint: {
        header: { formatVersion: 1, contextCodecVersion: 1, sessionId: "session", delegationId: id,
          projectRealPath: dir, createdAt: 1, savedAt: Date.now() },
        execution: { execution, executionId, generation: execution, lastStatus: "completed", parentToolCallId: id },
        observer: { phase: "finished", execution, completed: 0, guides: [] },
        usage: { turns: 1, toolCalls: 0, lastReportText: `第 ${execution} 轮结果` },
        config: { definition: { name: "explorer" }, task: "读取项目" },
        modelBinding: { provider: { modelId: "fixture" } },
        compaction: {}, messages: [{ role: "user", content: "任务", timestamp: 1 }],
      } };
  };
  try { await run({ store, dir, options, request, owner }); }
  finally { await store.closeOwner(); await rm(dir, { recursive: true, force: true }); }
}

test("旧会话的 dirty 和历史指纹隔离不再阻止读取完整快照", async () => fixture(async ({ store, dir, options, request }) => {
  await store.commitSnapshot(await request(1));
  const path = join(dir, "subagent-contexts/v1/session/session-control.bin");
  const record = JSON.parse(await readFile(path, "utf8"));
  Object.assign(record.value, { dirty: true, isolated: true, isolateReason: "SESSION_WATERMARK_MISMATCH", coveredWatermark: "old" });
  await writeFile(path, JSON.stringify(record));
  const restarted = new SubagentSnapshotStore(options);
  try {
    await restarted.initialize();
    const loaded = await restarted.loadSnapshot({ sessionId: "session", delegationId: "task" });
    assert.equal(loaded.checkpoint.usage.lastReportText, "第 1 轮结果");
    assert.equal((await restarted.claimSession({ sessionId: "session", runtimeInstanceId: "new-runtime" })).available, true);
  } finally { await restarted.closeOwner(); }
}));

test("新快照索引写入失败保留上一份文件；相同请求可重试", async () => fixture(async ({ store, dir, request }) => {
  await store.commitSnapshot(await request(1));
  const next = await request(2);
  const write = store.files.atomicWrite.bind(store.files);
  store.files.atomicWrite = async (path, bytes) => {
    if (path.endsWith("control.bin") && JSON.parse(bytes.toString()).value.status === "completed") throw new Error("disk failure");
    return write(path, bytes);
  };
  await assert.rejects(store.commitSnapshot(next), /disk failure/);
  const previousPath = join(dir, "subagent-contexts/v1/session/task/generation-1.bin");
  assert.equal(JSON.parse(await readFile(previousPath, "utf8")).value.execution.execution, 1);
  store.files.atomicWrite = write;
  assert.equal((await store.commitSnapshot(next)).snapshotGeneration, 2);
  await assert.rejects(readFile(previousPath), { code: "ENOENT" });
}));

test("旧轮保存、旧运行实例和停止后的提交均不能覆盖当前任务", async () => fixture(async ({ store, request, owner }) => {
  const first = await request(1);
  await store.commitSnapshot(first);
  const second = await request(2);
  await assert.rejects(store.commitSnapshot(first), /EXECUTION_CONFLICT/);
  await store.revokeExecution({ sessionId: "session", delegationId: "task", expectedExecution: 2,
    instanceGeneration: owner.instanceGeneration, source: "user", reason: "stop" });
  await assert.rejects(store.commitSnapshot(second), /TASK_REVOKED/);
  const another = await request(1, "another");
  await store.claimSession({ sessionId: "session", runtimeInstanceId: "replacement" });
  await assert.rejects(store.commitSnapshot(another), /STALE_INSTANCE/);
}));

test("一个任务控制文件损坏不影响其余快照目录", async () => fixture(async ({ store, dir, request }) => {
  await store.commitSnapshot(await request(1, "healthy"));
  await request(1, "broken");
  await writeFile(join(dir, "subagent-contexts/v1/session/broken/control.bin"), "not json");
  const result = await store.listEntries({ sessionId: "session" });
  assert.deepEqual(result.entries.map((entry) => entry.delegationId), ["healthy"]);
}));

test("卡片查询区分缺少快照与读取失败，并可重新发现有效快照", async () => fixture(async ({ store, request }) => {
  const missing = await store.readRecallStatus("session", "task");
  assert.equal(missing.persistenceState, "unavailable");
  await store.commitSnapshot(await request(1));
  const read = store.files.readBounded.bind(store.files);
  store.files.readBounded = async () => { throw new Error("temporary read failure"); };
  const unavailable = await store.readRecallStatus("session", "task");
  assert.equal(unavailable.persistenceState, "pending-validation");
  assert.equal(unavailable.canResume, false);
  store.files.readBounded = read;
  const saved = await store.readRecallStatus("session", "task");
  assert.equal(saved.snapshotVersion, 1);
  assert.equal(saved.canResume, true);
}));

test("失败执行以普通 JSON 保存，重启可加载且保留失败结果", async () => fixture(async ({ store, options, request, dir }) => {
  const failed = await request(1);
  failed.status = "failed";
  failed.checkpoint.execution.lastStatus = "failed";
  failed.result = { status: "failed", report: "请求异常，已完成部分检查", turns: 1, toolCalls: 0,
    error: { code: "PROVIDER_ERROR", message: "临时故障" } };
  assert.equal((await store.commitSnapshot(failed)).status, "failed");
  const raw = JSON.parse(await readFile(join(dir, "subagent-contexts/v1/session/task/generation-1.bin"), "utf8"));
  assert.equal(raw.value.execution.lastStatus, "failed");
  const restarted = new SubagentSnapshotStore(options);
  try {
    await restarted.initialize();
    const status = await restarted.readRecallStatus("session", "task");
    assert.equal(status.status, "failed");
    assert.equal(status.canResume, true);
    const loaded = await restarted.loadSnapshot({ sessionId: "session", delegationId: "task" });
    assert.equal(loaded.checkpoint.execution.lastStatus, "failed");
    assert.deepEqual(loaded.control.lastResult, failed.result);
  } finally { await restarted.closeOwner(); }
}));

test("本轮失败无快照时不复用上一轮；停止和中断不开放续接", async () => fixture(async ({ store, request }) => {
  await store.commitSnapshot(await request(1));
  const second = await request(2);
  await store.failExecution({ ...second, status: "failed", error: { code: "BROKEN_CONTEXT", message: "无完整上下文" } });
  assert.equal((await store.readRecallStatus("session", "task")).canResume, false);
  const directory = (await store.listEntries({ sessionId: "session" })).entries[0];
  assert.equal(directory.lastResult, undefined);
  assert.equal(directory.lastReportSummary, undefined);
  await assert.rejects(store.loadSnapshot({ sessionId: "session", delegationId: "task" }), /SNAPSHOT_CORRUPTED/);
  const stopped = await request(1, "stopped");
  await store.commitSnapshot(stopped);
  await store.revokeExecution({ sessionId: "session", delegationId: "stopped", source: "user", reason: "stop" });
  assert.equal((await store.readRecallStatus("session", "stopped")).canResume, false);
  await assert.rejects(store.loadSnapshot({ sessionId: "session", delegationId: "stopped" }), /SNAPSHOT_NOT_FOUND/);
  const interrupted = await request(1, "interrupted");
  await store.failExecution({ ...interrupted, status: "interrupted", error: { code: "INTERRUPTED", message: "中断" } });
  assert.equal((await store.readRecallStatus("session", "interrupted")).canResume, false);
  await assert.rejects(store.loadSnapshot({ sessionId: "session", delegationId: "interrupted" }), /SNAPSHOT_NOT_FOUND/);
}));
