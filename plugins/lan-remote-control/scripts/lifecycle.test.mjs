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
  const calls = { starts: 0, stops: 0, subscriptions: 0, releases: 0, ensureRelay: 0, inputs: [], credentials: [] };
  let running = false;
  let port = null;
  let remoteAccess = false;
  const server = {
    getStatus: () => ({ running, remoteAccess, port, restartRequired: options.networkChanged === true, passwordConfigured: options.passwordConfigured !== false, links: running ? [{ url: "http://localhost/" }] : [], devices: [] }),
    start: async (input) => {
      calls.starts++; calls.inputs.push({ ...input });
      if (options.startFails) throw Object.assign(new Error("port busy"), { code: "EADDRINUSE" });
      if (input.remoteAccess && options.passwordConfigured === false) throw Object.assign(new Error("password required"), { code: "PASSWORD_REQUIRED" });
      await options.beforeStart?.();
      if (running && (remoteAccess !== input.remoteAccess || port !== input.port || options.networkChanged)) calls.stops++;
      running = true; port = input.port; remoteAccess = input.remoteAccess; options.networkChanged = false;
    },
    stop: async () => { calls.stops++; running = false; options.networkChanged = false; },
    setPassword: async (password, username) => { calls.credentials.push({ password, username }); },
    revokeDevice: async () => {}, revokeAllDevices: async () => {},
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
      if (name === "./browse-bridge.cjs") return { createBrowseBridge: () => ({ open() {}, stop: async () => {}, status() {}, ensureRelay() { calls.ensureRelay++; }, mintPairingCode() {} }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, context, { filename: "main.cjs" });
  const plugin = context.module.exports;
  return { plugin, calls, timers, services, saved, options, status: async () => (await plugin.onPanelInvoke("remote.status")).status };
}

test("首次加载常驻本机通道；远控开启保存意图，重载恢复，关闭仅禁用远控", async () => {
  const saved = {};
  const first = host(saved);
  await first.plugin.onLoad();
  assert.equal(first.calls.starts, 1);
  assert.equal(first.calls.inputs[0].remoteAccess, false);
  assert.equal(first.calls.ensureRelay, 1);
  assert.equal((await first.status()).localRunning, true);
  assert.equal((await first.status()).running, false);
  assert.equal((await first.plugin.onPanelInvoke("remote.link")).ok, false);
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
  assert.equal(second.calls.inputs[0].remoteAccess, true);
  assert.equal((await second.plugin.onPanelInvoke("remote.stop")).ok, true);
  assert.equal(saved.autoStart, false);
  assert.equal((await second.status()).running, false);
  assert.equal((await second.status()).localRunning, true);
  assert.equal(second.calls.inputs.at(-1).remoteAccess, false);
  assert.equal(second.calls.releases, 0);
  await second.plugin.onUnload();
  const third = host(saved);
  await third.plugin.onLoad();
  await settle();
  assert.equal(third.calls.starts, 1);
  assert.equal(third.calls.inputs[0].remoteAccess, false);
  assert.equal((await third.status()).localRunning, true);
  assert.equal((await third.status()).running, false);
  await third.plugin.onUnload();
});

test("面板传递账号和密码，旧连接器设置入口已移除", async () => {
  const instance = host();
  await instance.plugin.onLoad();
  const credentials = { username: "operator", password: "panel-test-password" };
  assert.equal((await instance.plugin.onPanelInvoke("remote.setPassword", credentials)).ok, true);
  assert.deepEqual(instance.calls.credentials, [credentials]);
  const removed = await instance.plugin.onPanelInvoke("remote.setConnectorSettings", {});
  assert.equal(removed.ok, false);
  assert.equal(removed.error.code, "UNSUPPORTED");
  await instance.plugin.onUnload();
});

test("写盘失败如实返回未保存；关闭远控仍保留本机监听和订阅", async () => {
  const instance = host();
  await instance.plugin.onLoad();
  await instance.plugin.onPanelInvoke("remote.start", { port: 7878 });
  instance.options.writeFails = true;
  const result = await instance.plugin.onPanelInvoke("remote.stop");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SETTINGS_NOT_PERSISTED");
  assert.equal(result.status.running, false);
  assert.equal(result.status.localRunning, true);
  assert.equal(instance.calls.inputs.at(-1).remoteAccess, false);
  assert.equal(instance.calls.releases, 0);
  assert.equal(result.status.autoStart.persisted, false);
  assert.equal(result.status.autoStart.enabled, false);
  assert.equal(instance.saved.autoStart, true);
  await instance.plugin.onUnload();
});

test("开启进行中收到关闭，以关闭为最终状态", async () => {
  let release;
  const pendingStart = new Promise((resolve) => { release = resolve; });
  const instance = host();
  await instance.plugin.onLoad();
  instance.options.beforeStart = () => pendingStart;
  const starting = instance.plugin.onPanelInvoke("remote.start", { port: 7878 });
  await settle();
  const stopping = instance.plugin.onPanelInvoke("remote.stop");
  release();
  await Promise.all([starting, stopping]);
  await settle();
  assert.equal((await instance.status()).running, false);
  assert.equal((await instance.status()).localRunning, true);
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

test("关闭和重开远控复用 IPC 订阅，卸载才释放本机通道", async () => {
  const instance = host();
  await instance.plugin.onLoad();
  await instance.plugin.onPanelInvoke("remote.start");
  await instance.plugin.onPanelInvoke("remote.stop");
  assert.equal(instance.calls.releases, 0);
  assert.equal((await instance.status()).localRunning, true);
  await instance.plugin.onPanelInvoke("remote.start");
  assert.equal(instance.calls.subscriptions, 1);
  await instance.plugin.onUnload();
  assert.equal(instance.calls.releases, 1);
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
  const instance = host({}, { startFails: true });
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
  assert.equal((await instance.status()).running, false);
  assert.equal((await instance.status()).localRunning, true);
  await instance.plugin.onUnload();
});

test("远控恢复失败回退本机通道，保留自动恢复意图和 IPC 订阅", async () => {
  const instance = host({ autoStart: true }, { passwordConfigured: false });
  await instance.plugin.onLoad();
  assert.deepEqual(instance.calls.inputs.map(input => input.remoteAccess), [true, false]);
  const status = await instance.status();
  assert.equal(status.localRunning, true);
  assert.equal(status.running, false);
  assert.equal(status.passwordConfigured, false);
  assert.equal(status.error.code, "PASSWORD_REQUIRED");
  assert.equal(status.autoStart.enabled, true);
  assert.equal(status.autoStart.pending, true);
  assert.equal(instance.calls.releases, 0);
  assert.equal(instance.calls.subscriptions, 1);
  const retry = [...instance.timers.entries()].find(([timer]) => timer.delay === 3000);
  assert.ok(retry);
  instance.options.passwordConfigured = true;
  retry[1]();
  await settle();
  assert.equal((await instance.status()).running, true);
  assert.equal((await instance.status()).autoStart.pending, false);
  assert.equal(instance.calls.subscriptions, 1);
  await instance.plugin.onUnload();
});
