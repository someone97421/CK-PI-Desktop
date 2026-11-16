import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const shared = fileURLToPath(new URL("../../../packages/shared/src/", import.meta.url));
const service = fileURLToPath(new URL("../electron/main/ipc/browser-reference-ipc.ts", import.meta.url));
const bundle = await build({
  stdin: { contents: `export * from ${JSON.stringify(service)}; export * from ${JSON.stringify(`${shared}browser-reference.ts`)};`, resolveDir: process.cwd() },
  bundle: true, write: false, format: "esm", platform: "node", target: "node22", logLevel: "silent",
  plugins: [{ name: "reference-shared", setup(plugin) {
    plugin.onResolve({ filter: /^@pi-desktop\/shared$/ }, () => ({ path: "shared", namespace: "reference" }));
    plugin.onLoad({ filter: /.*/, namespace: "reference" }, () => ({
      contents: `export { IPC } from ${JSON.stringify(`${shared}protocol.ts`)}; export * from ${JSON.stringify(`${shared}browser-reference.ts`)};`,
      loader: "ts", resolveDir: shared,
    }));
  } }],
});
const { BrowserReferenceBroker, browserReferenceMark, browserReferenceFromSend } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const page = { kind: "page", tabId: 7, title: "浏览器页面", url: "https://example.test/page" };
function setup() {
  const events = [];
  let time = 100;
  const broker = new BrowserReferenceBroker((channel, payload) => events.push({ channel, payload }), () => time);
  broker.update({ sourceId: "sidebar", active: true, tabs: [page] });
  return { broker, events, advance: () => { time += 21_000; } };
}
const insertion = events => events.findLast(event => event.channel.endsWith("/insertRequested")).payload;

test("标签页按连接维护与去重，关闭侧栏清除候选", () => {
  const { broker } = setup();
  broker.update({ sourceId: "sidebar", active: true, tabs: [page, page] });
  assert.equal(broker.snapshot().tabs.length, 1);
  broker.update({ sourceId: "other", active: true, tabs: [page] });
  assert.equal(broker.snapshot().tabs.length, 2);
  broker.update({ sourceId: "sidebar", active: false });
  assert.deepEqual(broker.snapshot().tabs.map(tab => tab.sourceId), ["other"]);
  broker.update({ sourceId: "other", active: false });
  assert.deepEqual(broker.snapshot().tabs, []);
});

test("只选择最近聚焦的输入框，并等待匹配端和草稿的成功回执", async () => {
  const { broker, events } = setup();
  broker.client({ clientId: "desktop", draftKey: "session-a", available: true, focused: true });
  broker.client({ clientId: "web", draftKey: "session-b", connectionId: "sidebar", available: true, focused: true });
  broker.client({ clientId: "desktop", draftKey: "session-a", available: true });
  const result = broker.insert({ reference: page });
  const request = insertion(events);
  assert.equal(request.clientId, "web");
  assert.equal(request.connectionId, "sidebar");
  assert.deepEqual(broker.acknowledge({ ...request, clientId: "desktop", ok: true }), { accepted: false });
  assert.deepEqual(broker.acknowledge({ ...request, draftKey: "other", ok: true }), { accepted: false });
  assert.deepEqual(broker.acknowledge({ ...request, ok: true }), { accepted: true });
  assert.deepEqual(await result, { inserted: true, clientId: "web" });
  assert.deepEqual(broker.acknowledge({ ...request, ok: true }), { accepted: false });
});

test("切换草稿会取消未确认投递，不改投其他会话", async () => {
  const { broker, events } = setup();
  broker.client({ clientId: "desktop", draftKey: "session-a", available: true, focused: true });
  const rejected = assert.rejects(broker.insert({ reference: page }), /切换会话/);
  broker.client({ clientId: "desktop", draftKey: "session-b", available: true });
  await rejected;
  const result = broker.insert({ reference: page });
  const request = insertion(events);
  assert.equal(request.draftKey, "session-b");
  broker.acknowledge({ ...request, ok: true });
  await result;
});

test("浏览器连接断开时取消该端投递并清除标签页", async () => {
  const { broker } = setup();
  broker.client({ clientId: "web", draftKey: "draft", connectionId: "sidebar", available: true, focused: true });
  const rejected = assert.rejects(broker.insert({ reference: page }), /连接已断开/);
  broker.update({ sourceId: "sidebar", active: false, closed: true });
  await rejected;
  assert.equal(broker.snapshot().tabs.length, 0);
});

test("失活输入框不接收引用，失败回执保留明确失败", async () => {
  const { broker, events, advance } = setup();
  broker.client({ clientId: "desktop", draftKey: "draft", available: true, focused: true });
  const rejected = assert.rejects(broker.insert({ reference: page }), /不可编辑/);
  broker.acknowledge({ ...insertion(events), ok: false, error: "当前草稿不可编辑" });
  await rejected;
  advance();
  await assert.rejects(broker.insert({ reference: page }), /没有可编辑/);
});

test("浏览器mark保留选文与特殊字符，标签不超限，大引用明确拒绝", () => {
  const reference = { ...page, kind: "selection", selection: "引文\n带有\"引号\"和\uE001字符" };
  const mark = browserReferenceMark(reference);
  assert.deepEqual(browserReferenceFromSend(mark.send), reference);
  assert.ok(Array.from(browserReferenceMark({ ...page, title: "页面".repeat(100) }).label).length <= 64);
  assert.throws(() => browserReferenceMark({ ...reference, selection: "文".repeat(20_000) }), /32 KiB/);
  assert.equal(browserReferenceFromSend("普通插件正文"), null);
});

test("同一浏览器的多个侧栏不重复列出标签页，暂时隐藏不注销输入框", async () => {
  const { broker, events } = setup();
  broker.update({ sourceId: "sidebar", browserId: "profile", active: true, tabs: [page] });
  broker.update({ sourceId: "other", browserId: "profile", active: true, tabs: [page] });
  assert.equal(broker.snapshot().tabs.length, 1);
  broker.client({ clientId: "web", draftKey: "draft", connectionId: "sidebar", available: true, focused: true });
  broker.update({ sourceId: "sidebar", active: false });
  const result = broker.insert({ reference: page, connectionId: "sidebar" });
  const request = insertion(events);
  assert.equal(request.clientId, "web");
  broker.acknowledge({ ...request, ok: true });
  await result;
});

test("当前侧栏定向不受其他输入框焦点影响，旧注销回执不覆盖新草稿", async () => {
  const { broker, events } = setup();
  broker.client({ clientId: "web", draftKey: "old", connectionId: "sidebar", available: true, focused: true, revision: 1 });
  broker.client({ clientId: "web", draftKey: "new", connectionId: "sidebar", available: true, focused: true, revision: 3 });
  broker.client({ clientId: "web", draftKey: "old", available: false, revision: 2 });
  broker.client({ clientId: "desktop", draftKey: "other", available: true, focused: true });
  const result = broker.insert({ reference: page, connectionId: "sidebar" });
  const request = insertion(events);
  assert.equal(request.clientId, "web");
  assert.equal(request.draftKey, "new");
  assert.deepEqual(broker.claim(request), { accepted: true });
  broker.acknowledge({ ...request, ok: true });
  await result;
  assert.deepEqual(broker.claim(request), { accepted: false });
});

test("超时、切换草稿与连接关闭后不能领取残留请求", async () => {
  const { broker, events, advance } = setup();
  broker.client({ clientId: "web", draftKey: "draft", connectionId: "sidebar", available: true, focused: true });
  const rejected = assert.rejects(broker.insert({ reference: page }), /超时/);
  const request = insertion(events);
  advance();
  assert.deepEqual(broker.claim(request), { accepted: false });
  broker.acknowledge({ ...request, ok: true });
  await rejected;
  advance(); advance();
  assert.equal(broker.snapshot().tabs.length, 0);
  broker.update({ sourceId: "sidebar", closed: true, active: false });
  broker.update({ sourceId: "sidebar", active: true, tabs: [page] });
  assert.equal(broker.snapshot().tabs.length, 0);
});

test("同浏览器只采用最近侧栏完整列表，不从旧列表补回已关闭标签", () => {
  const { broker } = setup();
  broker.update({ sourceId: "sidebar", browserId: "profile", active: true, tabs: [page] });
  broker.update({ sourceId: "other", browserId: "profile", active: true, tabs: [] });
  assert.deepEqual(broker.snapshot().tabs, []);
  broker.update({ sourceId: "sidebar", browserId: "profile", active: true, tabs: [{ ...page, title: "已更新" }] });
  assert.deepEqual(broker.snapshot().tabs.map(tab => tab.title), ["已更新"]);
});

test("输入框从未聚焦也能接收浏览器引用", async () => {
  const { broker, events } = setup();
  broker.client({ clientId: "desktop", draftKey: "draft", available: true, focused: false });
  const result = broker.insert({ reference: page });
  const request = insertion(events);
  assert.equal(request.clientId, "desktop");
  assert.equal(request.draftKey, "draft");
  assert.deepEqual(broker.claim(request), { accepted: true });
  broker.acknowledge({ ...request, ok: true });
  assert.deepEqual(await result, { inserted: true, clientId: "desktop" });
});

test("无光标的侧栏仍定向当前输入框，不改投其他连接", async () => {
  const { broker, events } = setup();
  broker.client({ clientId: "web", draftKey: "draft", connectionId: "sidebar", available: true, focused: false });
  broker.client({ clientId: "desktop", draftKey: "other", available: true, focused: true });
  const result = broker.insert({ reference: page, connectionId: "sidebar" });
  const request = insertion(events);
  assert.equal(request.clientId, "web");
  broker.acknowledge({ ...request, ok: true });
  await result;
  await assert.rejects(broker.insert({ reference: page, connectionId: "missing" }), /没有可编辑/);
});
