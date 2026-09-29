import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Live playback activity IPC accepts only the bounded monitor state", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { parseMedia } = await server.ssrLoadModule("/electron/main/ipc/live-voice-ipc.ts");

  assert.deepEqual(parseMedia({
    callId: "call-a",
    kind: "playback-activity",
    active: true,
    ready: true,
  }), {
    callId: "call-a",
    kind: "playback-activity",
    active: true,
    ready: true,
  });
  assert.throws(() => parseMedia({
    callId: "call-a",
    kind: "playback-activity",
    active: false,
    ready: true,
    sessionId: "untrusted",
  }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => parseMedia({
    callId: "call-a",
    kind: "playback-activity",
    active: "false",
    ready: true,
  }), { errorCode: "LIVE_PROTOCOL_ERROR" });
});
