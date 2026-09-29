import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Live Voice remains reachable while disabled and exposes toggle state accessibly", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      piDesktop: {
        on: () => () => undefined,
        invoke: async () => ({ ok: true, data: { voice: { enabled: false, languages: [] } } }),
      },
    },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LiveVoiceControls } = await server.ssrLoadModule("/src/features/voice/live/LiveVoiceControls.tsx");
  const html = renderToStaticMarkup(React.createElement(LiveVoiceControls, { t: (key) => key }));

  assert.match(html, /aria-label="liveVoice\.start"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<button[^>]*disabled(?:="")?/);
});
