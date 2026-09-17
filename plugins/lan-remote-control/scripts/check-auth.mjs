// 密码与设备记录的定向回归；不创建监听或访问实际用户数据。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { DeviceStore, SESSION_TTL_MS } = require("../server/auth.cjs");
const directory = mkdtempSync(join(tmpdir(), "lan-auth-test-"));
const file = join(directory, "remote-access.json");
let now = Date.now();
try {
  let store = new DeviceStore({ file, now: () => now });
  assert.equal(await store.verify("test-only-password"), false);
  await assert.rejects(store.setPassword("short"));
  await store.setPassword("test-only-password");
  assert.equal(await store.verify("incorrect-test-password"), false);
  assert.equal(await store.verify("test-only-password"), true);
  const first = store.add({ name: "测试手机", remoteAddress: "192.168.1.2" });
  assert.equal(first.ok, true);
  const persisted = readFileSync(file, "utf8");
  assert.ok(!persisted.includes("test-only-password"));
  assert.ok(!persisted.includes(first.token));
  store = new DeviceStore({ file, now: () => now });
  assert.equal(store.authorize(first.token).id, first.device.id);
  assert.equal(store.list()[0].remoteAddress, "192.168.1.2");
  store.revoke(first.device.id);
  assert.equal(new DeviceStore({ file }).authorize(first.token), null);
  const second = store.add({ name: "另一台测试手机" });
  await store.setPassword("changed-test-password");
  assert.equal(store.authorize(second.token), null);
  assert.equal(await store.verify("test-only-password"), false);
  assert.equal(await store.verify("changed-test-password"), true);
  const third = store.add({ name: "到期测试" });
  now += SESSION_TTL_MS + 1;
  assert.equal(store.authorize(third.token), null);
  assert.equal(store.list().length, 0);
  const fourth = store.add({ name: "全部撤销测试" });
  store.revokeAll();
  assert.equal(new DeviceStore({ file, now: () => now }).authorize(fourth.token), null);
  console.log("密码、设备持久化、改密、撤销和过期回归通过；未启动监听。");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
