import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

const artifactDir = process.env.BROWSER_CAPTURE_ARTIFACT_DIR;
if (!artifactDir) throw new Error("BROWSER_CAPTURE_ARTIFACT_DIR is required");
app.setPath("userData", join(artifactDir, "profile"));

async function probe(artifactDir: string) {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><style>
      body{margin:0;font:24px sans-serif;background:#eee}
      header{padding:20px;background:#222;color:white}
      main{height:6000px;background:linear-gradient(#ddd,#57a)}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
      article{padding:24px;background:white;border:1px solid #888}
      </style><header>Browser viewport resize regression</header><main><div class="grid">
      ${Array.from({ length: 12 }, (_, i) => `<article>Card ${i + 1}</article>`).join("")}
      </div></main>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const window = new BrowserWindow({ width: 1100, height: 750, show: true });
  const panes: BrowserPane[] = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true, getFileRoot: async () => null, onState: () => {},
  });
  try {
    await window.loadURL("about:blank");
    host.setWindow(window);
    host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
      bounds: { x: 0, y: 0, width: 1000, height: 700 } });
    const resize = (width: number, height: number) => {
      host.setGuestHole("pi.browser", { x: 0, y: 0, width, height });
    };
    resize(800, 500);
    host.setChromeSession("capture-regression", "page");
    await host.navigate({ url: `http://127.0.0.1:${address.port}` }, "capture-regression");
    const wc = panes[0].getWebContents();
    assert(wc);
    const frame = () => wc.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await frame();
    const originalSend = wc.debugger.sendCommand.bind(wc.debugger);
    let resizeDuringCapture: { width: number; height: number } | undefined;
    // Synchronize a real native bounds change with Chromium's in-flight
    // screenshot, rather than relying on a machine-speed-dependent timer.
    wc.debugger.sendCommand = (method, params, sessionId) => {
      const pending = originalSend(method, params, sessionId);
      if (method === "Page.captureScreenshot" && resizeDuringCapture) {
        const size = resizeDuringCapture;
        resizeDuringCapture = undefined;
        resize(size.width - 20, size.height - 20);
        resize(size.width, size.height);
      }
      return pending;
    };
    const results = [];
    for (let i = 0; i < 12; i++) {
      const expected = i % 2 ? { width: 820, height: 510 } : { width: 960, height: 620 };
      resizeDuringCapture = expected;
      const raw = i >= 6;
      if (raw) {
        await host.cdpCommand("Page.captureScreenshot", { format: "png",
          captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 6000, scale: 1 } });
      } else {
        await host.screenshot({ fullPage: true });
      }
      await frame();
      const actual: unknown = await wc.executeJavaScript("({width: innerWidth, height: innerHeight})");
      results.push({ entry: raw ? "raw-cdp" : "screenshot", expected, actual });
    }
    wc.debugger.sendCommand = originalSend;
    const image = await wc.capturePage();
    assert(!image.isEmpty(), "native guest screenshot is empty");
    writeFileSync(join(artifactDir, "browser-viewport.png"), image.toPNG());
    const report = { electron: process.versions.electron, chrome: process.versions.chrome, results };
    writeFileSync(join(artifactDir, "results.json"), JSON.stringify(report, null, 2));
    for (const row of results) assert.deepEqual(row.actual, row.expected, row.entry);
    console.log(`BROWSER_CAPTURE_RESIZE ${JSON.stringify({ ok: true, ...report })}`);
  } finally {
    host.dispose();
    window.destroy();
    server.close();
  }
}

app.whenReady().then(() => probe(artifactDir)).then(
  () => app.exit(0),
  (error: unknown) => { console.error(error); app.exit(1); },
);
