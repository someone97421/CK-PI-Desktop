import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { SubagentSnapshotStore } = await import("../electron/main/runtime/subagent-snapshot-store.ts");
const { SubagentPersistenceClient } = await import("../../../packages/agent-runtime/src/subagent-persistence-client.ts");

test("新会话及重复登记不读取正在写入的历史转录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-claim-session-"));
  const modes = [];
  try {
    const store = new SubagentSnapshotStore({
      dataDir: dir,
      protector: { isEncryptionAvailable: () => false },
      deliverEvent: async () => {},
      sessionAuthority: async (_id, mode) => {
        modes.push(mode);
        if (mode !== "identity") throw new Error("转录正在变化，请在保存完成后重新校验。");
        return { projectRealPath: dir, watermark: "identity:fixture" };
      },
    });
    await store.initialize();
    await store.setEnabled(true);
    const request = { sessionId: "fixture-session", runtimeInstanceId: "fixture-runtime" };
    const first = await store.claimSession(request);
    const second = await store.claimSession(request);
    assert.equal(first.available, true);
    assert.equal(second.available, true);
    assert.equal(second.instanceGeneration, first.instanceGeneration);
    assert.deepEqual(modes, ["identity"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("登记失败可重试，成功后连续派发不重复登记", async () => {
  let claims = 0;
  const client = new SubagentPersistenceClient({ call: async (_method, request) => {
    if (request.operation === "capabilities") {
      return { protocolVersion: 1, settings: { available: true, enabled: true } };
    }
    if (request.operation === "claimSession") {
      if (++claims === 1) throw new Error("转录正在变化，请在保存完成后重新校验。");
      return { sessionId: "fixture-session", instanceGeneration: 1, available: true };
    }
    assert.equal(request.operation, "beginExecution");
    return { revision: 1, execution: 1, executionId: request.executionId, status: "running" };
  } }, "fixture-session", "fixture-runtime");
  const request = (id) => ({ sessionId: "fixture-session", delegationId: id,
    runtimeInstanceId: "fixture-runtime", instanceGeneration: 1,
    expectedExecution: 0, expectedRevision: 0, nextExecution: 1, executionId: id });
  await assert.rejects(client.beginExecution(request("first")), /转录正在变化/);
  assert.equal(client.isClaimed, false);
  await client.beginExecution(request("first"));
  await client.beginExecution(request("second"));
  assert.equal(client.isClaimed, true);
  assert.equal(claims, 2);
});
