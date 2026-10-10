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
