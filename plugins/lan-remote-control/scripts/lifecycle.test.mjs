import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../main.cjs", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function host(saved = {}, options = {}) {
  const timers = new Map();
  const events = new Map();
  const services = new Map();
  const calls = { starts: 0, stops: 0, subscriptions: 0, releases: 0 };
  let running = false;
  let port = null;
  const server = {
    getStatus: () => ({ running, port, restartRequired: options.networkChanged === true, passwordConfigured: true, links: [], devices: [] }),
    start: async (input) => {
      calls.starts++;
      if (options.startFails) throw Object.assign(new Error("port busy"), { code: "EADDRINUSE" });
      await options.beforeStart?.(); running = true; port = input.port;
    },
    stop: async () => { calls.stops++; running = false; options.networkChanged = false; },
    setPassword: async () => {}, revokeDevice: async () => {}, revokeAllDevices: async () => {},
    createLink: () => ({ ok: true }), broadcastIpc: () => {},
  };
  const runtime = {
    plugin: {
      getSettings: async () => ({ ...saved }),
      setSettings: async (partial) => {
        await options.beforeWrite?.(partial);
        if (options.writeFails) throw new Error("disk unavailable");
        Object.assign(saved, partial);
      },
      getDataPath: async () => path.resolve("virtual-plugin-data"),
      getManifest: () => ({ version: "2.0.0" }),
    },
    desktop: {
      getRendererRoot: async () => path.resolve("virtual-installed-renderer"),
      invokeIpc: async () => {}, importUploadedFiles: async () => {}, readRendererResource: async () => {},
      subscribeIpc: async () => { calls.subscriptions++; return { subscriptionId: "ipc" }; },
      unsubscribeIpc: async () => { calls.releases++; },
    },
    events: { on: (name, handler) => events.set(name, handler), off: (name) => events.delete(name) },
    commands: { register: async () => {}, unregister: async () => {} },
    services: { register: (service) => services.set(service.id, service), unregister: async () => {} },
    ui: { openPanel: async () => {} },
  };
  const timer = (fn, delay, repeating = false) => {
    const id = { delay, unref() {} };
    timers.set(id, () => { if (!repeating) timers.delete(id); fn(); });
    return id;
  };
  const context = {
    pi: runtime, module: { exports: {} }, __dirname: path.resolve("virtual-plugin"),
    setTimeout: timer, clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: (id) => timers.delete(id),
    require(name) {
      if (name === "node:fs") return { existsSync: () => options.rendererExists !== false };
      if (name === "node:path") return path;
      if (name === "./server.cjs") return { createRemoteServer: () => server };
      if (name === "./server/network.cjs") return { isAllowedBindAddress: () => true, listenerAddresses: () => [] };
      if (name === "./browse-bridge.cjs") return { createBrowseBridge: () => ({ open() {}, stop: async () => {}, status() {}, ensureRelay() {}, mintPairingCode() {} }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, context, { filename: "main.cjs" });
  const plugin = context.module.exports;
  return { plugin, calls, timers, services, saved, options, status: async () => (await plugin.onPanelInvoke("remote.status")).status };
}

test("首次加载不监听；开启保存端口及意图，重载自动恢复，手动关闭取消恢复", async () => {
  const saved = {};
  const first = host(saved);
  await first.plugin.onLoad();
  assert.equal(first.calls.starts, 0);
  assert.equal((await first.plugin.onPanelInvoke("remote.start", { port: 7879 })).ok, true);
  assert.equal(saved.autoStart, true);
  assert.equal(saved.port, 7879);
  await first.plugin.onUnload();
  assert.equal(saved.autoStart, true);
  assert.equal(first.timers.size, 0);
  const second = host(saved);
  await second.plugin.onLoad();
  await settle();
  assert.equal(second.calls.starts, 1);
  assert.equal((await second.status()).running, true);
  assert.equal((await second.plugin.onPanelInvoke("remote.stop")).ok, true);
  assert.equal(saved.autoStart, false);
  await second.plugin.onUnload();
  const third = host(saved);
  await third.plugin.onLoad();
  await settle();
  assert.equal(third.calls.starts, 0);
  await third.plugin.onUnload();
});

test("写盘失败如实返回未保存；手动关闭仍停止监听", async () => {
  const instance = host();
  await instance.plugin.onLoad();
  await instance.plugin.onPanelInvoke("remote.start", { port: 7878 });
  instance.options.writeFails = true;
  const result = await instance.plugin.onPanelInvoke("remote.stop");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SETTINGS_NOT_PERSISTED");
  assert.equal(result.status.running, false);
  assert.equal(result.status.autoStart.persisted, false);
  assert.equal(result.status.autoStart.enabled, false);
  assert.equal(instance.saved.autoStart, true);
  await instance.plugin.onUnload();
});

test("开启进行中收到关闭，以关闭为最终状态", async () => {
  let release;
  const pendingStart = new Promise((resolve) => { release = resolve; });
  const instance = host({}, { beforeStart: () => pendingStart });
  await instance.plugin.onLoad();
  const starting = instance.plugin.onPanelInvoke("remote.start", { port: 7878 });
  await settle();
  const stopping = instance.plugin.onPanelInvoke("remote.stop");
  release();
  await Promise.all([starting, stopping]);
  await settle();
  assert.equal((await instance.status()).running, false);
  assert.equal(instance.saved.autoStart, false);
  assert.equal((await instance.status()).autoStart.pending, false);
  await instance.plugin.onUnload();
});

test("宿主停止服务保留自动启用意图并释放订阅；重新启用服务才恢复", async () => {
  const instance = host({ autoStart: true });
  await instance.plugin.onLoad();
  await settle();
  const service = instance.services.get("lan-remote-control");
  await service.stop();
  assert.equal((await instance.status()).running, false);
  assert.equal(instance.saved.autoStart, true);
  assert.equal(instance.calls.releases, 1);
  assert.equal(instance.timers.size, 0);
  service.start();
  for (const callback of [...instance.timers.values()]) callback();
  await settle();
  assert.equal((await instance.status()).running, true);
  assert.equal(instance.calls.subscriptions, 2);
  await instance.plugin.onUnload();
});

test("Renderer 不可用时不回退旧页面、不开启监听", async () => {
  const instance = host({ autoStart: true }, { rendererExists: false });
  await instance.plugin.onLoad();
  await settle();
  assert.equal(instance.calls.starts, 0);
  assert.equal((await instance.status()).error.code, "RENDERER_UNAVAILABLE");
  await instance.plugin.onUnload();
});

test("关闭释放 IPC 订阅，重新开启重新订阅", async () => {
  const instance = host();
  await instance.plugin.onLoad();
  await instance.plugin.onPanelInvoke("remote.start");
  await instance.plugin.onPanelInvoke("remote.stop");
  assert.equal(instance.calls.releases, 1);
  await instance.plugin.onPanelInvoke("remote.start");
  assert.equal(instance.calls.subscriptions, 2);
  await instance.plugin.onUnload();
  assert.equal(instance.calls.releases, 2);
});

test("网络地址变化后自动重建监听，重复宿主启动不另排恢复", async () => {
  const instance = host({ autoStart: true });
  await instance.plugin.onLoad();
  await settle();
  instance.services.get("lan-remote-control").start();
  assert.equal(instance.timers.size, 1);
  instance.options.networkChanged = true;
  for (const callback of [...instance.timers.values()]) callback();
  await settle();
  assert.equal(instance.calls.starts, 2);
  assert.equal(instance.calls.stops, 1);
  assert.equal((await instance.status()).running, true);
  await instance.plugin.onUnload();
});

test("监听失败退避重试，成功后清理重试并恢复事件订阅", async () => {
  const instance = host({ autoStart: true }, { startFails: true });
  await instance.plugin.onLoad();
  await settle();
  assert.equal(instance.calls.starts, 1);
  assert.equal(instance.calls.releases, 1);
  const retry = [...instance.timers.entries()].find(([timer]) => timer.delay === 3000);
  assert.ok(retry);
  instance.options.startFails = false;
  retry[1]();
  await settle();
  assert.equal(instance.calls.starts, 2);
  assert.equal(instance.calls.subscriptions, 2);
  assert.equal((await instance.status()).autoStart.pending, false);
  assert.equal((await instance.status()).running, true);
  await instance.plugin.onUnload();
});
