import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { isMutationOperation, TOKEN_STORAGE_KEY, DEVICE_NAME_STORAGE_KEY } from "../web/protocol.js";

const require = createRequire(import.meta.url);
const { createRemoteServer } = require("../server/index.cjs");
const { createRequestGuard } = require("../server/http.cjs");
const { listenerAddresses, listLanAddresses } = require("../server/network.cjs");
const { buildOperationTable, createRpcDispatcher } = require("../server/rpc.cjs");
const { createBrowseBridge } = require("../browse-bridge.cjs");
const extension = "chrome-extension://afeafocngkodbmaipcngoamamfmekgfo";
const custom = "a".repeat(32);
const version = { version: "test", instanceId: "test" };
const pair = { code: "ABCD-EF56", port: 19988, endpoint: "http://127.0.0.1:19988" };

function body(operation, mutationId) {
  return { requestId: randomUUID(), operation, input: {}, ...(mutationId ? { mutationId } : {}) };
}

test("Browse stdio MCP 声明包含宿主安装所需的本地服务权限", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const browse = manifest.contributes.mcpServers.find((server) => server.id === "browse");
  assert.deepEqual(browse, { id: "browse", label: "Browse 浏览器调试", transport: "stdio", command: "browse", args: ["mcp"], env: { OPENCODE_BROWSER_TOOLS: "all", OPENCODE_BROWSER_PORT: "19988" } });
  assert.ok(manifest.permissions.includes("mcp.server.local"));
  assert.equal(manifest.id, "local.lan-remote-control");
  assert.equal(TOKEN_STORAGE_KEY, "lan-remote-control.token");
  assert.equal(DEVICE_NAME_STORAGE_KEY, "lan-remote-control.device-name");
});

test("扩展 ID 设置使用原插件设置通道，保留端口与原有字段", async () => {
  const previousPi = globalThis.pi;
  const entry = require.resolve("../main.cjs");
  let saved = {}, writes = [];
  globalThis.pi = {
    plugin: {
      getSettings: async () => saved,
      setSettings: async (partial) => { writes.push(partial); saved = { ...saved, ...partial }; },
    },
    app: { getAppearance: async () => ({}) },
  };
  delete require.cache[entry];
  try {
    const main = require(entry);
    assert.equal(main.SERVICE_ID, "lan-remote-control");
    assert.equal(main.COMMAND_OPEN, "lan-remote-control.open");
    assert.equal((await main.onPanelInvoke("remote.status")).status.settings.port, 7878);
    saved = { bindAddress: "192.168.1.2", port: 7891, uiScale: 115, autoStart: true };
    const result = await main.onPanelInvoke("remote.setConnectorSettings", { extensionIds: [custom, custom], allowLan: false });
    assert.equal(result.ok, true);
    assert.deepEqual(writes, [{ extensionIds: [custom] }]);
    assert.deepEqual(result.status.settings, { ...saved, extensionIds: [custom] });
    assert.equal(Object.hasOwn(result.status.settings, "allowLan"), false);
    assert.equal((await main.onPanelInvoke("remote.setConnectorSettings", { extensionIds: ["invalid"] })).error.code, "INVALID_PARAMS");
    assert.equal(writes.length, 1);
  } finally {
    delete require.cache[entry];
    if (previousPi === undefined) delete globalThis.pi;
    else globalThis.pi = previousPi;
  }
});

test("Origin 精确匹配固定 / 自定义扩展与同源地址", () => {
  const guard = createRequestGuard({ getAllowedHostnames: () => ["localhost", "127.0.0.1", "192.168.1.2"], getPort: () => 7878, getExtensionIds: () => [custom] });
  for (const origin of [extension, `chrome-extension://${custom}`, "http://127.0.0.1:7878", "http://192.168.1.2:7878"]) assert.equal(guard.checkOrigin({ headers: { origin } }, { required: true }).ok, true);
  for (const origin of ["null", `${extension}/`, `${extension}.evil`, "chrome-extension://" + "b".repeat(32), "http://localhost:7880", "http://localhost:7878/path", "https://evil.test", [extension]]) assert.equal(guard.checkOrigin({ headers: { origin } }, { required: true }).ok, false);
  assert.equal(guard.checkOrigin({ headers: {} }, { required: true }).ok, false);
});

test("原私网枚举与优先级不变，全部私网候选额外包含 loopback", () => {
  const os = require("node:os"), original = os.networkInterfaces;
  const info = (address, internal = false) => ({ address, family: "IPv4", internal });
  os.networkInterfaces = () => ({ Ethernet: [info("192.168.1.2"), info("8.8.8.8")], WLAN: [info("10.0.0.2")], docker: [info("172.17.0.2")], link: [info("169.254.1.2")], cgnat: [info("100.64.0.2")], lo: [info("127.0.0.1", true)] });
  try {
    const lan = listLanAddresses();
    assert.equal(lan.length, 5);
    assert.equal(lan[0].address, "10.0.0.2");
    assert.equal(lan[0].recommended, true);
    assert.deepEqual(listenerAddresses().slice(0, -1), lan);
    assert.deepEqual(listenerAddresses().at(-1), { address: "127.0.0.1", label: "本机", recommended: false });
    os.networkInterfaces = () => ({});
    assert.deepEqual(listenerAddresses(), [{ address: "127.0.0.1", label: "本机", recommended: true }]);
  } finally { os.networkInterfaces = original; }
});

test("Browse 状态兼容真实 CLI 字段，配对只调用非交互命令", async () => {
  const commands = [];
  const bridge = createBrowseBridge({ resolveExecutable: () => "browse", probe: async () => version, run: async (_, args) => {
    commands.push(args);
    return args[0] === "pair" ? pair : { relay: { running: true }, connected: true, pairingState: "connected", extension: { browsers: [{ id: "chrome" }] }, tabs: [{ id: 3 }], setup: { installed: true } };
  } });
  const status = await bridge.status();
  assert.equal(status.running, true); assert.equal(status.cliAvailable, true);
  assert.equal(status.browsers[0].id, "chrome"); assert.equal(status.tabs[0].id, 3);
  assert.deepEqual(await bridge.mintPairingCode(), pair);
  assert.deepEqual(commands.at(-1), ["pair", "--mint-json"]);
  await bridge.stop();
  await assert.rejects(bridge.ensureRelay(), { code: "NOT_READY" });
});

test("Browse 缺失与错误配对输出明确失败", async () => {
  const absent = createBrowseBridge({ resolveExecutable: () => null, probe: async () => null });
  assert.equal((await absent.status()).cliAvailable, false);
  await assert.rejects(absent.ensureRelay(), { code: "UNAVAILABLE" });
  const invalid = createBrowseBridge({ resolveExecutable: () => "browse", probe: async () => version, run: async (_, args) => args[0] === "pair" ? { ...pair, endpoint: "http://evil.test" } : {} });
  await assert.rejects(invalid.mintPairingCode(), { code: "UNAVAILABLE" });
});

test("并发确保 Relay 只启动一次，停止仅回收自身启动的进程", async () => {
  let running = false, launches = 0, kills = 0;
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  child.kill = () => { kills++; child.exitCode = 0; child.emit("exit", 0); };
  const bridge = createBrowseBridge({ resolveExecutable: () => "browse", probe: async () => running ? version : null, run: async () => ({}), spawnRelay: (_, args, options) => {
    assert.deepEqual(args, ["serve"]); assert.equal(options.env.OPENCODE_BROWSER_PORT, "19988");
    launches++; running = true; return child;
  } });
  await Promise.all([bridge.ensureRelay(), bridge.ensureRelay()]);
  assert.equal(launches, 1); await bridge.stop(); assert.equal(kills, 1);
});

test("Browse RPC 读写分类与浏览器协议一致", () => {
  const table = buildOperationTable(null).table;
  for (const operation of ["browse.status", "browse.ensureRelay", "browse.mintPairingCode"]) assert.equal(isMutationOperation(operation), table.get(operation).mutation);
});
test("Browse RPC 继续校验登录、mutationId 并去重，不派发到宿主", async () => {
  let minted = 0, capabilityCalls = 0;
  const dispatcher = createRpcDispatcher({ getOperationTable: () => buildOperationTable(null), getCapabilities: async () => { capabilityCalls++; return { operations: {} }; }, localOperations: { "browse.mintPairingCode": async () => { minted++; return pair; } } });
  const mutationId = randomUUID(), request = body("browse.mintPairingCode", mutationId);
  const invoke = (isAuthorized, payload = request) => dispatcher.handle({ deviceId: "test", body: payload, isAuthorized: () => isAuthorized });
  assert.equal((await invoke(true, body("browse.mintPairingCode"))).status, 400);
  assert.equal((await invoke(false)).status, 401); assert.equal(minted, 0);
  const validRequest = body("browse.mintPairingCode", randomUUID());
  assert.equal((await invoke(true, validRequest)).status, 200);
  assert.equal((await invoke(true, validRequest)).envelope.replayed, true); assert.equal(minted, 1);
  assert.equal(capabilityCalls, 0, "本地 Browse 操作不得等待宿主能力查询");
});
test("停止发生在启动探测期间时不遗留 Relay 子进程", async () => {
  let completeProbe, launches = 0;
  const bridge = createBrowseBridge({ resolveExecutable: () => "browse", probe: () => new Promise((resolve) => { completeProbe = resolve; }), spawnRelay: () => { launches++; } });
  const starting = bridge.ensureRelay();
  const rejected = assert.rejects(starting, { code: "NOT_READY" });
  const stopping = bridge.stop();
  completeProbe(null);
  await Promise.all([rejected, stopping]);
  assert.equal(launches, 0);
});

test("全部本机私网与回环同时监听，旧首选链接及认证文件沿用", async (context) => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "lan-listeners-test-"));
  const server = createRemoteServer({ dataDir: directory });
  context.after(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  await server.setPassword("lan-listeners-test-password");
  const lan = listLanAddresses();
  const status = await server.start({ port: 0, address: lan.at(-1)?.address });
  assert.equal(status.restartRequired, false);
  assert.deepEqual(new Set(status.links.map((entry) => entry.address)), new Set([...lan.map((entry) => entry.address), "127.0.0.1"]));
  assert.equal(status.address, lan.at(-1)?.address ?? "127.0.0.1");
  for (const link of status.links) assert.equal((await fetch(`${link.url}api/health`)).status, 200);
  assert.equal(JSON.parse(await readFile(join(directory, "remote-access.json"), "utf8")).password !== undefined, true);
});

test("离线 loopback HTTP / CORS / 登录 / Browse RPC / WebSocket 联通", async (context) => {
  const os = require("node:os"), original = os.networkInterfaces;
  os.networkInterfaces = () => ({});
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "lan-connector-test-"));
  let extensionIds = [custom], minted = 0;
  const server = createRemoteServer({ dataDir: directory, webDir: resolve(import.meta.dirname, "../web"), getExtensionIds: () => extensionIds,
    localOperations: { "browse.status": async () => ({ running: true, browsers: [], tabs: [] }), "browse.mintPairingCode": async () => { minted++; return pair; }, "browse.ensureRelay": async () => ({ running: true }) },
    getCapabilities: async () => ({ operations: {} }),
  });
  context.after(async () => { os.networkInterfaces = original; await server.stop(); await rm(directory, { recursive: true, force: true }); });
  await server.setPassword("connector-test-password");
  const status = await server.start({ port: 0 });
  assert.equal(status.address, "127.0.0.1"); assert.equal(status.links.length, 1); assert.equal(status.restartRequired, false);
  const endpoint = `http://127.0.0.1:${status.port}`;
  const preflight = (origin, headers = "content-type, authorization, x-filename, x-session-id") => fetch(`${endpoint}/api/rpc`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": headers } });
  for (const origin of [extension, `chrome-extension://${custom}`]) {
    const response = await preflight(origin); assert.equal(response.status, 204); assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("vary"), "Origin"); assert.equal(await response.text(), "");
  }
  assert.equal((await preflight(extension, "x-secret")).status, 403);
  const rejected = await preflight("chrome-extension://" + "b".repeat(32)); assert.equal(rejected.status, 403); assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${endpoint}/api/health`, { headers: { Origin: "https://evil.test" } })).status, 403);
  const post = (route, payload, token) => fetch(`${endpoint}${route}`, { method: "POST", headers: { Origin: extension, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });
  assert.equal((await post("/api/rpc", body("browse.status"))).status, 401);
  const login = await post("/api/login", { password: "connector-test-password", name: "测试侧边栏" }); assert.equal(login.status, 200);
  const { result: { token } } = await login.json();
  const mintBody = body("browse.mintPairingCode", randomUUID());
  assert.deepEqual((await (await post("/api/rpc", mintBody, token)).json()).result, pair);
  assert.equal((await (await post("/api/rpc", mintBody, token)).json()).replayed, true); assert.equal(minted, 1);
  for (const origin of [extension, `chrome-extension://${custom}`, endpoint]) {
    const socket = new WebSocket(`ws://127.0.0.1:${status.port}/ws`, { origin });
    await once(socket, "open"); socket.send(JSON.stringify({ type: "auth", token }));
    const [ready] = await once(socket, "message"); assert.equal(JSON.parse(ready).type, "ready");
    const closed = once(socket, "close"); socket.close(); await closed;
  }
  const blocked = new WebSocket(`ws://127.0.0.1:${status.port}/ws`, { origin: "https://evil.test" });
  await new Promise((resolve, reject) => { blocked.on("error", resolve); blocked.on("open", () => { blocked.close(); reject(new Error("untrusted origin connected")); }); });
  extensionIds = [];
  assert.equal((await preflight(`chrome-extension://${custom}`)).status, 403);
  assert.equal((await post("/api/logout", {}, token)).status, 200);
  assert.equal((await post("/api/rpc", body("browse.status"), token)).status, 401);
});
