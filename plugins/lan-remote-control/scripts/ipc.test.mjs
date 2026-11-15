import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const { createRemoteServer } = require("../server/index.cjs");
const extension = "chrome-extension://afeafocngkodbmaipcngoamamfmekgfo";

async function fixture(context, options = {}) {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "lan-ipc-test-"));
  const rendererDir = join(directory, "renderer");
  await mkdir(join(rendererDir, "assets"), { recursive: true });
  await writeFile(join(rendererDir, "index.html"), `<!doctype html><meta http-equiv="Content-Security-Policy" content="connect-src 'self';"><meta name="viewport" content="width=device-width"><title>renderer fixture</title><script src="./assets/app.js"></script>`);
  await writeFile(join(rendererDir, "assets/app.js"), "export const renderer = true;");
  const server = createRemoteServer({ dataDir: directory, rendererDir, ...options });
  context.after(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });
  await server.setPassword("ipc-test-password");
  const { port } = await server.start({ port: 0 });
  const endpoint = `http://127.0.0.1:${port}`;
  const post = (route, body, token) => fetch(`${endpoint}${route}`, { method: "POST", headers: { Origin: extension, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const login = await post("/api/login", { password: "ipc-test-password", name: "IPC 测试设备" });
  const loginBody = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  const { result: { token } } = loginBody;
  const connect = async (authenticate = true) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: extension });
    context.after(() => socket.terminate());
    await once(socket, "open");
    if (authenticate) {
      const ready = once(socket, "message");
      socket.send(JSON.stringify({ type: "auth", token }));
      assert.equal(JSON.parse((await ready)[0]).type, "ready");
    }
    return socket;
  };
  return { server, directory, rendererDir, endpoint, post, token, connect };
}

test("IPC 仅允许认证调用，校验参数并原样返回宿主 Result 与普通结果", async (context) => {
  const calls = [];
  const { post, token, server } = await fixture(context, { ipcInvoke: async (channel, args) => {
    calls.push({ channel, args });
    if (channel === "failure") throw Object.assign(new Error("宿主错误"), { code: "INVALID_PARAMS" });
    return channel === "plain" ? args : { success: false, error: "宿主 Result" };
  } });
  assert.equal((await post("/api/ipc", { channel: "settings:get", args: [] })).status, 401);
  for (const body of [{ channel: 3, args: [] }, { channel: "", args: [] }, { channel: "test", args: {} }, { channel: "test" }]) {
    assert.equal((await post("/api/ipc", body, token)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await (await post("/api/ipc", { channel: "settings:get", args: [1, { value: true }] }, token)).json(), { success: false, error: "宿主 Result" });
  assert.deepEqual(calls[0], { channel: "settings:get", args: [1, { value: true }] });
  assert.deepEqual(await (await post("/api/ipc", { channel: "plain", args: ["value"] }, token)).json(), ["value"]);
  assert.equal((await post("/api/ipc", { channel: "failure", args: [] }, token)).status, 400);
  await server.revokeAllDevices();
  assert.equal((await post("/api/ipc", { channel: "plain", args: [] }, token)).status, 401);
});

test("IPC 回调缺失明确返回 UNSUPPORTED", async (context) => {
  const { post, token } = await fixture(context);
  const response = await post("/api/ipc", { channel: "settings:get", args: [] }, token);
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, "UNSUPPORTED");
});

test("WS 认证后订阅 IPC，隔离未认证设备并在关闭和撤销时取消", async (context) => {
  const handlers = new Set();
  let cancelled = 0;
  let notifyCancelled;
  const cancellation = new Promise(resolve => { notifyCancelled = resolve; });
  const { connect, server } = await fixture(context, { subscribeIpc: async (handler) => {
    handlers.add(handler);
    return () => { handlers.delete(handler); cancelled++; notifyCancelled(); };
  } });
  const unauthenticated = await connect(false);
  assert.equal(handlers.size, 0);
  const socket = await connect();
  assert.equal(handlers.size, 1);
  const event = { channel: "session:changed", args: ["id", { status: "running" }] };
  const received = once(socket, "message");
  for (const handler of handlers) handler(event);
  assert.deepEqual(JSON.parse((await received)[0]), { type: "ipc-event", ...event });
  assert.equal(server.broadcastIpc(event), 1);
  const closed = once(socket, "close"); socket.close(); await closed;
  await cancellation;
  assert.equal(handlers.size, 0); assert.equal(cancelled, 1);
  await connect();
  await server.revokeAllDevices();
  assert.equal(handlers.size, 0); assert.equal(cancelled, 2);
  assert.equal(server.broadcastIpc(event), 0);
  unauthenticated.terminate();
});

test("renderer 静态根目录、SPA fallback、HEAD 和 CSP 保留 API 路由", async (context) => {
  const custom = "a".repeat(32);
  let extensionIds = [custom, "invalid-extension-id"];
  const { endpoint, rendererDir } = await fixture(context, { getExtensionIds: () => extensionIds });
  for (const route of ["/", "/sessions/session-id", "/settings/models/"]) {
    const response = await fetch(`${endpoint}${route}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /renderer fixture/);
    assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /src="\/assets\/app.js"/);
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(html));
    const csp = response.headers.get("content-security-policy");
    for (const origin of ["'self'", endpoint, endpoint.replace("http:", "ws:"), extension, `chrome-extension://${custom}`]) assert.ok(csp.includes(origin), origin);
    assert.match(csp, /worker-src 'self' blob:/);
    assert.match(csp, /img-src 'self' blob: data: https:/);
    assert.match(csp, /frame-src 'self'/);
    const ancestors = csp.split(";").map(value => value.trim()).find(value => value.startsWith("frame-ancestors "));
    assert.deepEqual(ancestors.split(/\s+/), ["frame-ancestors", "'self'", `chrome-extension://${custom}`, extension]);
    assert.doesNotMatch(ancestors, /\*/);
    assert.match(csp, /media-src 'self' data: blob: https:/);
    assert.equal(response.headers.get("x-frame-options"), null);
  }
  const head = await fetch(`${endpoint}/sessions/id`, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  assert.match(await (await fetch(`${endpoint}/assets/app.js`)).text(), /renderer = true/);
  for (const route of ["/assets/missing.js", "/api/missing"]) assert.equal((await fetch(`${endpoint}${route}`)).status, 404);
  assert.equal((await fetch(`${endpoint}/%2ehidden`)).status, 400);
  assert.match(await readFile(join(rendererDir, "index.html"), "utf8"), /http-equiv="Content-Security-Policy"/);
  for (const [extension, mime] of [["woff2", "font/woff2"], ["mp4", "video/mp4"], ["webm", "video/webm"], ["wasm", "application/wasm"]]) {
    await writeFile(join(rendererDir, `assets/test.${extension}`), "asset");
    const response = await fetch(`${endpoint}/assets/test.${extension}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mime);
  }
  extensionIds = [];
  const updated = await fetch(`${endpoint}/`);
  const updatedAncestors = updated.headers.get("content-security-policy").split(";").map(value => value.trim()).find(value => value.startsWith("frame-ancestors "));
  assert.deepEqual(updatedAncestors.split(/\s+/), ["frame-ancestors", "'self'", extension]);
});

test("renderer 上传交给宿主复制，保留草稿身份和旧上传响应", async (context) => {
  const imported = [];
  const { endpoint, token } = await fixture(context, { rendererUpload: async (input) => {
    imported.push(input);
    assert.equal(await readFile(input.files[0].path, "utf8"), "upload content");
    assert.ok(input.files[0].path.endsWith(input.files[0].name === "source.ts" ? ".ts" : ".CSV"));
    return { files: input.files.map(file => ({ ...file, path: `/host/draft/${file.name}` })) };
  } });
  const upload = (route, authorized = true, sessionId, name = "original.CSV", mime = "text/plain") => fetch(`${endpoint}${route}`, { method: "POST", headers: { Origin: extension, "Content-Type": mime, "X-Filename": name, ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(sessionId ? { "X-Session-Id": sessionId } : {}) }, body: "upload content" });
  assert.equal((await upload("/api/upload?target=renderer", false)).status, 401);
  const response = await upload("/api/upload?target=renderer&draftId=draft-id");
  assert.equal(response.status, 200);
  const uploaded = await response.json();
  assert.deepEqual(Object.keys(uploaded), ["files"]);
  assert.equal(uploaded.files[0].path, "/host/draft/original.CSV");
  assert.equal(imported[0].draftId, "draft-id"); assert.equal(Object.hasOwn(imported[0], "sessionId"), false);
  assert.deepEqual(Object.keys(imported[0].files[0]).sort(), ["kind", "mimeType", "name", "path", "size"]);
  const old = await upload("/api/upload", true, "existing-session");
  const oldBody = await old.json();
  assert.equal(oldBody.ok, true); assert.equal(typeof oldBody.result.id, "string"); assert.equal(Object.hasOwn(oldBody.result, "path"), false);
  const source = await upload("/api/upload?target=renderer&draftId=draft-id", true, undefined, "source.ts", "application/octet-stream");
  assert.equal(source.status, 200);
  const sourceBody = await source.json();
  assert.deepEqual(Object.keys(sourceBody), ["files"]);
  assert.equal(sourceBody.files[0].path, "/host/draft/source.ts");
  assert.equal(sourceBody.files[0].mimeType, "application/octet-stream");
  assert.equal((await upload("/api/upload", true, "existing-session", "source.ts", "application/octet-stream")).status, 501);
});

test("插件入口使用单个宿主 IPC 订阅、事件总线与同版本 renderer 根目录", async () => {
  const previousPi = globalThis.pi;
  const entry = require.resolve("../main.cjs");
  const serverModule = require("../server.cjs");
  const originalCreate = serverModule.createRemoteServer;
  const events = new EventEmitter();
  let options, subscribed = 0, unsubscribed = [], broadcast = [];
  serverModule.createRemoteServer = (value) => {
    options = value;
    return { stop: async () => {}, broadcastIpc: event => broadcast.push(event) };
  };
  globalThis.pi = {
    plugin: { getSettings: async () => ({}), getManifest: () => ({}), getDataPath: async () => "/plugin-data" },
    desktop: {
      getRendererRoot: async () => "/same-install/out/renderer",
      subscribeIpc: async (...args) => { assert.deepEqual(args, []); subscribed++; return { subscriptionId: "shared" }; },
      unsubscribeIpc: async id => unsubscribed.push(id),
      invokeIpc: (channel, args) => ({ channel, args }),
      importUploadedFiles: input => input,
      readRendererResource: url => ({ url }),
    },
    events,
    commands: { register: async () => {}, unregister: async () => {} },
  };
  delete require.cache[entry];
  const main = require(entry);
  try {
    await main.onLoad();
    assert.equal(options.rendererDir, "/same-install/out/renderer");
    assert.equal(subscribed, 1);
    assert.deepEqual(options.ipcInvoke("channel", [1]), { channel: "channel", args: [1] });
    assert.deepEqual(options.rendererUpload({ files: [] }), { files: [] });
    assert.deepEqual(options.rendererResource("pi-genui://assets/index.html"), { url: "pi-genui://assets/index.html" });
    const event = { channel: "changed", args: [1] };
    events.emit("desktop:ipc-event", event); assert.deepEqual(broadcast, [event]);
    await main.onUnload();
    assert.deepEqual(unsubscribed, ["shared"]);
    assert.equal(events.listenerCount("desktop:ipc-event"), 0);
  } finally {
    await main.onUnload();
    serverModule.createRemoteServer = originalCreate;
    delete require.cache[entry];
    if (previousPi === undefined) delete globalThis.pi; else globalThis.pi = previousPi;
  }
});

test("资源代理仅接受路径 token 和四协议，不转发请求或响应 cookie", async (context) => {
  const calls = [];
  const bytes = Buffer.from([0, 255, 128, 42]);
  const { endpoint, token, server } = await fixture(context, { rendererResource: async (...args) => {
    calls.push(args);
    return { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "999", "Set-Cookie": "secret=value", Cookie: "secret=value", "Content-Encoding": "gzip", "Cache-Control": "public" }, body: bytes.toString("base64") };
  } });
  const prefix = `/api/resource/${encodeURIComponent(token)}`;
  assert.equal((await fetch(`${endpoint}/api/resource/invalid/pi-genui/assets/a.png`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  for (const scheme of ["http", "https", "file", "javascript"]) assert.equal((await fetch(`${endpoint}${prefix}/${scheme}/assets/a.png`)).status, 403);
  assert.equal(calls.length, 0);
  for (const scheme of ["pi-genui", "plugin-renderer", "plugin-asset", "appearance-media"]) {
    const response = await fetch(`${endpoint}${prefix}/${scheme}/assets/a.png?key=x%2Fy`, { headers: { Cookie: "private=browser", Origin: "null" } });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(calls.at(-1), [`${scheme}://assets/a.png?key=x%2Fy`]);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cookie"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("access-control-allow-origin"), "null");
  }
  const head = await fetch(`${endpoint}${prefix}/pi-genui/assets/a.png`, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "4"); assert.equal(await head.text(), "");
  await server.revokeAllDevices();
  assert.equal((await fetch(`${endpoint}${prefix}/pi-genui/assets/a.png`)).status, 401);
});

test("资源代理重写 HTML/CSS/JS 四协议 URL，保留 GenUI CSP 和相对资源 token", async (context) => {
  const requests = [];
  const html = `<meta http-equiv="Content-Security-Policy" content="default-src pi-genui:; script-src pi-genui: 'unsafe-inline'; img-src plugin-asset: appearance-media:;"><script src="plugin-renderer://plugin/main.js"></script><img src="plugin-asset://plugin/logo.png"><img src="appearance-media://theme/bg.png"><a href="pi-genui://assets/other.html">跳转</a><script src="./child.js"></script><img src="/root.png">`;
  const sources = {
    "/dir/index.html": ["text/html; charset=utf-8", html],
    "/dir/style.css": ["text/css", `@import "plugin-renderer://plugin/theme.css"; .a { background: url(pi-genui://assets/a.png); } .b { background: url(/root.png); }`],
    "/dir/main.js": ["application/javascript", `const asset = "plugin-asset://plugin/logo.png"; const local = "./child.js";`],
    "/dir/child.js": ["text/javascript", `export default "appearance-media://theme/bg.png";`],
  };
  const { endpoint, token } = await fixture(context, { rendererResource: async url => {
    requests.push(url);
    const entry = sources[new URL(url).pathname];
    return { status: entry ? 200 : 404, headers: { "content-type": entry?.[0] || "text/plain", "content-security-policy": "default-src pi-genui:; script-src plugin-renderer: 'unsafe-inline'; img-src plugin-asset://plugin appearance-media:;" }, body: Buffer.from(entry?.[1] || "missing").toString("base64") };
  } });
  const prefix = `/api/resource/${encodeURIComponent(token)}`;
  const pageUrl = `${endpoint}${prefix}/pi-genui/assets/dir/index.html?source=original`;
  const response = await fetch(pageUrl);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(requests[0], "pi-genui://assets/dir/index.html?source=original");
  assert.match(text, /http-equiv="Content-Security-Policy"/);
  assert.match(text, /default-src 'self'/);
  assert.match(text, /'unsafe-inline'/);
  assert.doesNotMatch(text, /(?:pi-genui|plugin-renderer|plugin-asset|appearance-media):/);
  for (const path of ["plugin-renderer/plugin/main.js", "plugin-asset/plugin/logo.png", "appearance-media/theme/bg.png", "pi-genui/assets/other.html", "pi-genui/assets/root.png"]) assert.ok(text.includes(`${prefix}/${path}`), path);
  assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(text));
  assert.doesNotMatch(response.headers.get("content-security-policy"), /pi-genui:|plugin-renderer:|plugin-asset:|appearance-media:/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self' 'unsafe-inline'/);
  assert.equal(response.headers.get("x-frame-options"), null);
  const child = new URL("./child.js", pageUrl);
  assert.ok(child.pathname.startsWith(prefix));
  const childResponse = await fetch(child);
  assert.ok((await childResponse.text()).includes(`${prefix}/appearance-media/theme/bg.png`));
  for (const name of ["style.css", "main.js"]) {
    const asset = await fetch(new URL(name, pageUrl));
    const source = await asset.text();
    assert.equal(asset.status, 200);
    assert.doesNotMatch(source, /(?:pi-genui|plugin-renderer|plugin-asset|appearance-media):/);
    assert.ok(source.includes(prefix));
  }
  const missing = await fetch(new URL("missing.png", pageUrl));
  assert.equal(missing.status, 404); assert.equal(await missing.text(), "missing");
});

test("资源回调缺失和读取中授权撤销明确失败", async (context) => {
  const unsupported = await fixture(context);
  assert.equal((await fetch(`${unsupported.endpoint}/api/resource/${encodeURIComponent(unsupported.token)}/pi-genui/assets/a.png`)).status, 501);
  let resolveRead, started;
  const beginning = new Promise(resolve => { started = resolve; });
  const { endpoint, token, server } = await fixture(context, { rendererResource: () => new Promise(resolve => { resolveRead = resolve; started(); }) });
  const reading = fetch(`${endpoint}/api/resource/${encodeURIComponent(token)}/pi-genui/assets/a.png`);
  await beginning;
  await server.revokeAllDevices();
  resolveRead({ status: 200, headers: {}, body: Buffer.from("private").toString("base64") });
  assert.equal((await reading).status, 401);
});

test("资源改写归一父级和协议相对引用，单引号 GenUI meta CSP 仍有效", () => {
  const { rewriteResourceText } = require("../server/resources.cjs");
  const source = `<meta http-equiv="Content-Security-Policy" content='default-src pi-genui:;'><img src="../../above.png"><img src="//other/picture.png"><style>.a { background: url(../image.png); }</style>`;
  const result = rewriteResourceText(source, { token: "test-token", url: "pi-genui://assets/dir/index.html", html: true });
  assert.ok(result.includes('/api/resource/test-token/pi-genui/assets/above.png'));
  assert.ok(result.includes('/api/resource/test-token/pi-genui/other/picture.png'));
  assert.ok(result.includes('/api/resource/test-token/pi-genui/assets/image.png'));
  assert.ok(result.includes("content='default-src &#39;self&#39;;'"));
});
