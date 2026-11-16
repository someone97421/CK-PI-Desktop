import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const { createRemoteServer } = require("../server/index.cjs");
const extension = "chrome-extension://afeafocngkodbmaipcngoamamfmekgfo";

async function fixture(context, options = {}) {
  assert.ok(process.env.PI_SCRATCH_DIR, "PI_SCRATCH_DIR 必须设置");
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "lan-ipc-test-"));
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
      const message = JSON.parse((await ready)[0]);
      assert.equal(message.type, "ready");
      assert.equal(message.protocolVersion, 2);
      socket.referenceConnectionId = message.connectionId;
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

test("WS 原样转发 IPC，仅交付已认证连接并在关闭或撤销后停止", async (context) => {
  const { connect, server } = await fixture(context);
  const unauthenticated = await connect(false);
  assert.equal(server.broadcastIpc({ channel: "changed", args: [] }), 0);
  const socket = await connect();
  const event = { channel: "session:changed", args: ["id", { status: "running" }] };
  const received = once(socket, "message");
  assert.equal(server.broadcastIpc(event), 1);
  assert.deepEqual(JSON.parse((await received)[0]), { type: "ipc-event", ...event });
  const closed = once(socket, "close"); socket.close(); await closed;
  assert.equal(server.broadcastIpc(event), 0);
  await connect();
  await server.revokeAllDevices();
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

test("Renderer 上传交给宿主复制，保留草稿身份且统一返回宿主响应", async (context) => {
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
  const current = await upload("/api/upload", true, "existing-session");
  const currentBody = await current.json();
  assert.deepEqual(Object.keys(currentBody), ["files"]);
  assert.equal(imported[1].sessionId, "existing-session");
  await assert.rejects(readFile(imported[1].files[0].path), { code: "ENOENT" });
  const source = await upload("/api/upload?target=renderer&draftId=draft-id", true, undefined, "source.ts", "application/octet-stream");
  assert.equal(source.status, 200);
  const sourceBody = await source.json();
  assert.deepEqual(Object.keys(sourceBody), ["files"]);
  assert.equal(sourceBody.files[0].path, "/host/draft/source.ts");
  assert.equal(sourceBody.files[0].mimeType, "application/octet-stream");
  assert.equal((await upload("/api/upload?target=legacy", true, "existing-session")).status, 400);
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

test("必须指定可读取的 Renderer，拒绝 webDir 回退", async (context) => {
  assert.throws(() => createRemoteServer({ webDir: "/legacy" }), { code: "RENDERER_UNAVAILABLE" });
  const { server, directory } = await fixture(context);
  await server.stop();
  for (const rendererDir of [join(directory, "missing"), join(directory, "empty"), join(directory, "file")]) {
    if (rendererDir.endsWith("empty")) await mkdir(rendererDir);
    if (rendererDir.endsWith("file")) await writeFile(rendererDir, "not a directory");
    const invalid = createRemoteServer({ dataDir: directory, rendererDir });
    await assert.rejects(invalid.start({ port: 0 }), { code: "RENDERER_UNAVAILABLE" });
    assert.equal(invalid.getStatus().running, false);
    assert.equal(invalid.getStatus().error.code, "RENDERER_UNAVAILABLE");
  }
});

test("Browse 转换仅执行声明且已提供的操作，V1 业务路由和订阅不可用", async (context) => {
  const calls = [];
  const localOperations = Object.fromEntries(["browse.status", "browse.ensureRelay", "browse.mintPairingCode", "browse.arbitrary", "chat.send"].map(operation => [operation, () => { calls.push(operation); return { operation }; }]));
  const { endpoint, post, token, connect } = await fixture(context, { localOperations });
  assert.equal((await post("/api/rpc", { operation: "browse.status" })).status, 401);
  for (const operation of ["browse.status", "browse.ensureRelay", "browse.mintPairingCode"]) {
    const response = await post("/api/rpc", { operation, requestId: "connector-request" }, token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { operation }, requestId: "connector-request" });
  }
  for (const operation of ["browse.arbitrary", "chat.send", "sessions.list", "capabilities", "models.list", "__proto__"]) {
    const response = await post("/api/rpc", { operation }, token);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "OPERATION_NOT_ALLOWED");
  }
  assert.equal(calls.length, 3);
  for (const route of ["/api/mutation/id", "/api/attachment/id"]) assert.equal((await fetch(`${endpoint}${route}`)).status, 404);
  const socket = await connect();
  const result = once(socket, "message");
  socket.send(JSON.stringify({ type: "subscribe", sessionId: "session" }));
  assert.equal(JSON.parse((await result)[0]).error.code, "INVALID_PARAMS");
  const pong = once(socket, "message");
  socket.send(JSON.stringify({ type: "ping" }));
  assert.equal(JSON.parse((await pong)[0]).type, "pong");
});

test("Chrome 扩展来源白名单动态生效，拒绝未知来源与公网监听", async (context) => {
  const custom = "b".repeat(32), forbidden = `chrome-extension://${"c".repeat(32)}`;
  let ids = [custom];
  const { endpoint, server, token } = await fixture(context, { getExtensionIds: () => ids, ipcInvoke: () => ({ ok: true }) });
  const invoke = origin => fetch(`${endpoint}/api/ipc`, { method: "POST", headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel: "any", args: [] }) });
  assert.equal((await invoke(forbidden)).status, 403);
  const allowed = await invoke(`chrome-extension://${custom}`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), `chrome-extension://${custom}`);
  const preflight = await fetch(`${endpoint}/api/ipc`, { method: "OPTIONS", headers: { Origin: extension, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" } });
  assert.equal(preflight.status, 204);
  ids = [];
  assert.equal((await invoke(`chrome-extension://${custom}`)).status, 403);
  assert.equal((await invoke(extension)).status, 200);
  for (const address of ["0.0.0.0", "::", "8.8.8.8"]) await assert.rejects(server.start({ address }), { code: "INVALID_PARAMS" });
  const network = require("../server/network.cjs");
  for (const listener of server._internals.listeners) assert.ok(network.isAllowedBindAddress(listener.server.address().address));
});

test("设备记录兼容重启，注销与改密立即撤销令牌和 WS", async (context) => {
  const { server, rendererDir, directory, token, post, connect } = await fixture(context);
  const socket = await connect();
  const closed = once(socket, "close");
  assert.equal((await post("/api/logout", {}, token)).status, 200);
  await closed;
  assert.equal((await post("/api/ipc", { channel: "any", args: [] }, token)).status, 401);
  const login = await (await post("/api/login", { password: "ipc-test-password", name: "持久设备" })).json();
  const persistedToken = login.result.token;
  await server.stop();
  const restarted = createRemoteServer({ rendererDir, dataDir: directory, ipcInvoke: () => "persisted" });
  context.after(() => restarted.stop());
  const { port } = await restarted.start({ port: 0 });
  const request = () => fetch(`http://127.0.0.1:${port}/api/ipc`, { method: "POST", headers: { Origin: extension, Authorization: `Bearer ${persistedToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ channel: "any", args: [] }) });
  assert.equal(await (await request()).json(), "persisted");
  await restarted.setPassword("new-ipc-password");
  assert.equal((await request()).status, 401);
  const saved = await readFile(join(directory, "remote-access.json"), "utf8");
  assert.equal(JSON.parse(saved).version, 1);
  assert.ok(!saved.includes(persistedToken));
  assert.ok(!saved.includes("new-ipc-password"));
});

test("IPC 等待期间撤销授权不交付宿主结果", async (context) => {
  let release, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const { post, token, server } = await fixture(context, { ipcInvoke: () => new Promise(resolve => { release = resolve; notify(); }) });
  const pending = post("/api/ipc", { channel: "any", args: [] }, token);
  await started;
  await server.revokeAllDevices();
  release({ secret: "host-result" });
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("host-result"));
});

test("密码、设备持久化与到期的独立回归", async () => {
  await import("./check-auth.mjs");
});

test("Renderer 上传支持空文件，宿主失败或缺失时清理暂存文件", async (context) => {
  let importedPath;
  const { endpoint, token, server } = await fixture(context, { rendererUpload: async input => {
    importedPath = input.files[0].path;
    assert.equal((await readFile(importedPath)).length, 0);
    throw Object.assign(new Error("导入失败"), { code: "INVALID_PARAMS" });
  } });
  const response = await fetch(`${endpoint}/api/upload?target=renderer&draftId=draft`, { method: "POST", headers: { Origin: extension, Authorization: `Bearer ${token}`, "X-Filename": encodeURIComponent("空文件.ts"), "Content-Type": "application/octet-stream" }, body: Buffer.alloc(0) });
  assert.equal(response.status, 400);
  await server.stop();
  await assert.rejects(readFile(importedPath), { code: "ENOENT" });
  const unsupported = await fixture(context);
  const missing = await fetch(`${unsupported.endpoint}/api/upload?target=renderer&draftId=draft`, { method: "POST", headers: { Origin: extension, Authorization: `Bearer ${unsupported.token}` }, body: "data" });
  assert.equal(missing.status, 501);
  assert.equal((await missing.json()).error.code, "UNSUPPORTED");
});

test("正常停服按可重连关闭，重新开启后原设备登录仍有效", async (context) => {
  const { server, connect, token } = await fixture(context, { ipcInvoke: () => ({ ok: true, data: "connected" }) });
  const socket = await connect();
  const closed = once(socket, "close");
  const stopping = server.stop();
  socket.send(JSON.stringify({ type: "ping" }));
  assert.equal((await closed)[0], 4001);
  await stopping;
  const { port } = await server.start({ port: 0 });
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc`, {
    method: "POST", headers: { Origin: extension, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: "settings:get", args: [] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: "connected" });
});

test("插件适配层在入口和 SPA 注入，资源独立提供且不改 Renderer 文件", async (context) => {
  const projectionDir = fileURLToPath(new URL("../adapter/", import.meta.url));
  const { endpoint, rendererDir } = await fixture(context, { projectionDir });
  const original = '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body></body></html>';
  await writeFile(join(rendererDir, "index.html"), original);
  for (const route of ["/", "/sessions/id"]) {
    const response = await fetch(`${endpoint}${route}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /href="\/__lan-remote\/projection.css"/);
    assert.match(html, /src="\/__lan-remote\/projection.js"><\/script><\/head>/);
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(html));
  }
  for (const [name, mime] of [["projection.js", "javascript"], ["projection.css", "text/css"]]) {
    const route = `${endpoint}/__lan-remote/${name}`;
    const response = await fetch(route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type").includes(mime));
    assert.equal(await response.text(), await readFile(join(projectionDir, name), "utf8"));
    const head = await fetch(route, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
  assert.equal((await fetch(`${endpoint}/__lan-remote/missing.js`)).status, 404);
  assert.equal(await readFile(join(rendererDir, "index.html"), "utf8"), original);
});

test("浏览器标签页绑定认证连接，引用仅发到目标端并在断线后清理", async (context) => {
  const calls = [];
  let resolveUpdate;
  const nextUpdate = () => new Promise(resolve => { resolveUpdate = resolve; });
  const { connect, server } = await fixture(context, { ipcInvoke: async (channel, args) => {
    calls.push({ channel, args });
    if (channel === "pi-desktop/browserReferences/update") resolveUpdate?.({ channel, args });
    return { ok: true, data: {} };
  } });
  const first = await connect();
  const second = await connect();
  assert.equal(typeof first.referenceConnectionId, "string");
  assert.notEqual(first.referenceConnectionId, second.referenceConnectionId);
  const updated = nextUpdate();
  const tabs = [{ kind: "page", tabId: 1, title: "引用测试", url: "https://example.test/" }];
  first.send(JSON.stringify({ type: "browser-context", browserId: "profile-a", active: true, sourceId: "ignored", tabs }));
  assert.deepEqual(await updated, { channel: "pi-desktop/browserReferences/update", args: [{ sourceId: first.referenceConnectionId, browserId: "profile-a", active: true, tabs }] });
  const event = { channel: "pi-desktop/browserReferences/event/insertRequested", args: [{ connectionId: first.referenceConnectionId, clientId: "target", draftKey: "draft", reference: tabs[0] }] };
  const delivered = once(first, "message");
  assert.equal(server.broadcastIpc(event), 1);
  assert.deepEqual(JSON.parse((await delivered)[0]), { type: "ipc-event", ...event });
  assert.equal(server.broadcastIpc({ ...event, args: [{ clientId: "desktop" }] }), 0);
  const cleared = nextUpdate();
  const closed = once(first, "close"); first.close(); await closed;
  assert.deepEqual(await cleared, { channel: "pi-desktop/browserReferences/update", args: [{ sourceId: first.referenceConnectionId, active: false, closed: true }] });
});

test("页面资源与状态读取超过旧总额度后，第二条消息仍只投递一次", async (context) => {
  const messages = [];
  const { endpoint, post, token } = await fixture(context, { ipcInvoke: async (channel, args) => {
    if (channel === "session:send") messages.push(args[0]);
    return { ok: true, data: { messages: [...messages] } };
  } });
  const send = text => post("/api/ipc", { channel: "session:send", args: [text] }, token);
  assert.equal((await send("第一条")).status, 200);
  for (let batch = 0; batch < 32; batch++) {
    await Promise.all(Array.from({ length: 10 }, async () => {
      const [asset, state] = await Promise.all([
        fetch(`${endpoint}/assets/app.js`),
        post("/api/ipc", { channel: "session:state", args: [] }, token),
      ]);
      assert.equal(asset.status, 200);
      assert.equal(state.status, 200);
      await Promise.all([asset.text(), state.json()]);
    }));
  }
  const second = await send("第二条");
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).data.messages, ["第一条", "第二条"]);
  assert.deepEqual(messages, ["第一条", "第二条"]);
  assert.equal((await post("/api/ipc", { channel: "session:send", args: ["未登录"] })).status, 401);
});

test("已登录 Browse RPC 不按调用次数中断", async (context) => {
  let calls = 0;
  const { post, token } = await fixture(context, { localOperations: {
    "browse.ensureRelay": async () => ({ ok: true, result: { calls: ++calls } }),
  } });
  for (let index = 0; index < 245; index++) {
    const response = await post("/api/rpc", { operation: "browse.ensureRelay" }, token);
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal(calls, 245);
});

test("浏览器上下文与心跳超过旧消息额度后仍保持事件同步", async (context) => {
  let updates = 0;
  const { connect, server } = await fixture(context, { ipcInvoke: async channel => {
    if (channel === "pi-desktop/browserReferences/update") updates++;
    return { ok: true, data: {} };
  } });
  const socket = await connect();
  for (let index = 0; index < 70; index++) {
    const reply = once(socket, "message");
    socket.send(JSON.stringify({ type: "browser-context", active: true, tabs: [] }));
    socket.send(JSON.stringify({ type: "ping" }));
    assert.equal(JSON.parse((await reply)[0]).type, "pong");
  }
  assert.equal(updates, 70);
  assert.equal(socket.readyState, WebSocket.OPEN);
  const event = { channel: "session:changed", args: ["session", { status: "idle" }] };
  const received = once(socket, "message");
  assert.equal(server.broadcastIpc(event), 1);
  assert.deepEqual(JSON.parse((await received)[0]), { type: "ipc-event", ...event });
});

test("文件交付保留原始字节、中文文件名和作用域，且只接受登录后的 POST", async (context) => {
  const calls = [];
  const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
  const { post, token, endpoint } = await fixture(context, { rendererFile: async (input) => {
    calls.push(input);
    if (input.path === "/missing") throw Object.assign(new Error("文件不存在"), { code: "NOT_FOUND" });
    return { name: "原始 文件.zip", body: bytes.toString("base64") };
  } });
  assert.equal((await post("/api/file", { path: "/file" })).status, 401);
  assert.equal((await fetch(`${endpoint}/api/file`)).status, 405);
  for (const input of [{}, { path: "" }, { path: "/file", sessionId: {} }]) assert.equal((await post("/api/file", input, token)).status, 400);
  assert.equal(calls.length, 0);
  const input = { path: "/host/worktree/原始 文件.zip", sessionId: "session-owner" };
  const response = await post("/api/file", input, token);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(calls, [input]);
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  assert.equal(decodeURIComponent(response.headers.get("X-File-Name")), "原始 文件.zip");
  assert.match(response.headers.get("Content-Disposition"), /attachment;.*filename\*=UTF-8''/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const missing = await post("/api/file", { path: "/missing" }, token);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.message, "文件不存在");
});

test("文件读取途中撤销登录时不交付文件，旧宿主返回明确不支持", async (context) => {
  let complete;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const { post, token, server } = await fixture(context, { rendererFile: async () => {
    started();
    return new Promise(resolve => { complete = resolve; });
  } });
  const pending = post("/api/file", { path: "/file" }, token);
  await began;
  await server.revokeAllDevices();
  complete({ name: "private.txt", body: Buffer.from("private bytes").toString("base64") });
  const response = await pending;
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /private bytes/);
  const old = await fixture(context);
  assert.equal((await old.post("/api/file", { path: "/file" }, old.token)).status, 501);
});

test("HTML 预览目录链支持相对资源、Windows 路径和 sandbox 来源，撤销后资源失效", async (context) => {
  const { fileViewUrl, parseFileViewUrl } = require("../server/files.cjs");
  for (const path of ["/project/中文 文件/index.html", "C:\\项目 文件\\index.html"]) {
    const url = fileViewUrl("token", { path, sessionId: "owner:session" });
    assert.deepEqual(parseFileViewUrl(url), { token: "token", input: { path: path.replaceAll("\\", "/"), sessionId: "owner:session" } });
  }
  const calls = [];
  const { endpoint, post, token, server } = await fixture(context, { rendererFile: async (input) => {
    calls.push(input);
    const name = input.path.split("/").at(-1);
    return { name, body: Buffer.from(name.endsWith(".html") ? '<link rel="stylesheet" href="./style.css"><script src="../app.js"></script>' : "resource").toString("base64") };
  } });
  const response = await post("/api/file", { path: "/project/中文/index.html", sessionId: "owner:session" }, token);
  const preview = new URL(response.headers.get("X-File-Preview"), endpoint);
  assert.equal(preview.origin, endpoint);
  for (const [relative, path, mime] of [["", "/project/中文/index.html", "text/html"], ["./style.css", "/project/中文/style.css", "text/css"], ["../app.js", "/project/app.js", "text/javascript"]]) {
    const result = await fetch(new URL(relative, preview), { headers: { Origin: "null" } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Content-Type"), mime);
    assert.equal(result.headers.get("Access-Control-Allow-Origin"), "null");
    assert.match(result.headers.get("Content-Security-Policy"), /sandbox allow-scripts/);
    assert.equal(result.headers.get("Content-Disposition"), "inline");
    assert.deepEqual(calls.at(-1), { path, sessionId: "owner:session" });
  }
  await server.revokeAllDevices();
  assert.equal((await fetch(preview)).status, 401);
});
