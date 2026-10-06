import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function loadEndpoint(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return server.ssrLoadModule("/electron/main/live-voice/websocket-endpoint.ts");
}

async function loadTransport(t, proxyRoute = "DIRECT") {
  const electronStub = {
    name: "live-voice-electron-test-stub",
    enforce: "pre",
    resolveId(id) {
      return id === "electron" ? "\0live-voice-electron-test-stub" : null;
    },
    load(id) {
      if (id !== "\0live-voice-electron-test-stub") return null;
      return `export const net = { fetch: async () => { throw new Error("unexpected fetch"); } };
        export const session = { defaultSession: { resolveProxy: async () => ${JSON.stringify(proxyRoute)} } };`;
    },
  };
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    plugins: [electronStub],
    ssr: { noExternal: ["electron"] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return server.ssrLoadModule("/electron/main/live-voice/websocket-transport.ts");
}

test("Live transport connects to a user-supplied loopback ws endpoint", async (t) => {
  const { openLiveWebSocket } = await loadTransport(t);
  const { WebSocketServer } = createRequire(new URL("../package.json", import.meta.url))("ws");
  const server = createHttpServer();
  const fixture = new WebSocketServer({ server });
  let connections = 0;
  let request;
  fixture.on("connection", (_socket, incoming) => {
    connections++;
    request = incoming;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of fixture.clients) socket.terminate();
    await new Promise((resolve) => fixture.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const client = await openLiveWebSocket({
    url: `ws://127.0.0.1:${server.address().port}/v1/realtime?model=fixture`,
    headers: { Authorization: "Bearer local-fixture-key" },
    signal: new AbortController().signal,
    endpointOrigin: "user",
  });
  assert.equal(connections, 1);
  assert.ok(request);
  assert.equal(request.url, "/v1/realtime?model=fixture");
  assert.equal(request.headers.authorization, "Bearer local-fixture-key");
  const closed = once(client, "close");
  client.close();
  await closed;
});

test("Live transport refuses plain ws when Electron routes it through a proxy", async (t) => {
  const { openLiveWebSocket } = await loadTransport(t, "PROXY 127.0.0.1:8080");

  await assert.rejects(
    openLiveWebSocket({
      url: "ws://127.0.0.1:8010/v1/realtime?model=fixture",
      signal: new AbortController().signal,
      endpointOrigin: "user",
    }),
    { errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED" },
  );
});

test("Realtime socket URL keeps TLS for HTTPS providers and maps HTTP providers to ws", async (t) => {
  const { realtimeSocketUrl } = await loadEndpoint(t);

  assert.equal(
    realtimeSocketUrl("https://api.openai.com/v1", "gpt-realtime"),
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
  );
  assert.equal(
    realtimeSocketUrl("https://example.test/v1/realtime/", "m"),
    "wss://example.test/v1/realtime?model=m",
  );
  assert.equal(
    realtimeSocketUrl("http://127.0.0.1:8010/v1", "local-model"),
    "ws://127.0.0.1:8010/v1/realtime?model=local-model",
  );
  assert.equal(
    realtimeSocketUrl("http://[::1]:8010/v1/", "m"),
    "ws://[::1]:8010/v1/realtime?model=m",
  );
});

test("Realtime socket URL rejects non-HTTP schemes, credentials, query and fragment", async (t) => {
  const { realtimeSocketUrl } = await loadEndpoint(t);

  for (const baseUrl of [
    "not a url",
    "ws://127.0.0.1:8010/v1",
    "file:///tmp/realtime",
    "http://user:secret@127.0.0.1:8010/v1",
    "https://api.example.test/v1?key=1",
    "https://api.example.test/v1#frag",
  ]) {
    assert.throws(() => realtimeSocketUrl(baseUrl, "m"), { errorCode: "LIVE_PROTOCOL_UNSUPPORTED" }, baseUrl);
  }
});

test("Live socket guard URL allows plain ws only for user-supplied endpoints", async (t) => {
  const { liveSocketGuardUrl } = await loadEndpoint(t);

  assert.equal(
    liveSocketGuardUrl("wss://generativelanguage.googleapis.com/ws?x=1", "third-party"),
    "https://generativelanguage.googleapis.com/ws?x=1",
  );
  assert.equal(
    liveSocketGuardUrl("wss://api.openai.com/v1/realtime?model=m", "user"),
    "https://api.openai.com/v1/realtime?model=m",
  );
  assert.equal(
    liveSocketGuardUrl("ws://127.0.0.1:8010/v1/realtime?model=m", "user"),
    "http://127.0.0.1:8010/v1/realtime?model=m",
  );
  assert.throws(
    () => liveSocketGuardUrl("ws://127.0.0.1:8010/v1/realtime", "third-party"),
    { errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED" },
  );
  assert.throws(
    () => liveSocketGuardUrl("https://api.openai.com/v1/realtime", "user"),
    { errorCode: "LIVE_NETWORK_POLICY_UNSUPPORTED" },
  );
});
