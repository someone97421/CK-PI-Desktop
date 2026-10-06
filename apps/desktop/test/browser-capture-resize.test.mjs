import assert from "node:assert/strict";
import { once } from "node:events";
import { register, registerHooks } from "node:module";
import test from "node:test";

// Only Electron is replaced: exercise the production Host, Pane and CDP path.
// Chromium restores the viewport saved when capture starts, even if a native
// bounds update arrives before capture finishes.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export class WebContentsView {
    static instances = [];
    constructor() {
      const wc = Object.assign(new EventEmitter(), {
        id: WebContentsView.instances.length + 1,
        url: "", destroyed: false, viewport: { width: 0, height: 0 },
        captures: [],
        async loadURL(url) {
          this.emit("did-start-navigation", {}, url, false, true);
          this.url = url;
          this.emit("did-navigate", {}, url);
        },
        getURL() { return this.url; },
        getTitle: () => "fixture", isLoading: () => false,
        isDestroyed() { return this.destroyed; },
        close() { this.destroyed = true; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      wc.debugger = Object.assign(new EventEmitter(), {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        async sendCommand(method, params) {
          if (method === "Page.getLayoutMetrics") {
            return { cssContentSize: { width: wc.viewport.width, height: 6000 } };
          }
          if (method !== "Page.captureScreenshot") return {};
          const savedViewport = { ...wc.viewport };
          let resolve, reject;
          const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
          wc.captures.push({ params, resolve, reject });
          wc.emit("capture-start");
          try {
            await pending;
            return { data: "fixture-image" };
          } finally { wc.viewport = savedViewport; }
        },
      });
      this.webContents = wc;
      WebContentsView.instances.push(this);
    }
    setBounds(bounds) {
      this.bounds = { ...bounds };
      this.webContents.viewport = { width: bounds.width, height: bounds.height };
    }
    setVisible() {}
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { WebContentsView } = await import("electron");

async function harness(t) {
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => new BrowserPane(onState, onOpenUrl),
    isPluginLoaded: () => true, getFileRoot: async () => null, onState: () => {},
  });
  const children = [];
  host.setWindow({ isDestroyed: () => false, contentView: {
    children,
    addChildView(view) { children.push(view); },
    removeChildView(view) { children.splice(children.indexOf(view), 1); },
  } });
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 0, y: 0, width: 1200, height: 900 } });
  const resize = (width, height) => host.setGuestHole("pi.browser", { x: 0, y: 0, width, height });
  resize(800, 500);
  host.setChromeSession("session", "first");
  await host.navigate({ url: "https://fixture.invalid/first" }, "session");
  t.after(() => host.dispose());
  return { host, resize, wc: WebContentsView.instances.at(-1).webContents };
}

for (const raw of [false, true]) {
  test(`${raw ? "raw CDP" : "browser screenshot"} restores the latest panel size`, async (t) => {
    const { host, resize, wc } = await harness(t);
    const started = once(wc, "capture-start");
    const request = raw
      ? host.cdpCommand("Page.captureScreenshot", { format: "png" })
      : host.screenshot({ fullPage: true });
    await started;
    resize(910, 590);
    resize(960, 620);
    wc.captures[0].resolve();
    await request;
    assert.deepEqual(wc.viewport, { width: 960, height: 620 });
    assert.equal(wc.captures.length, 1, "resizing must not repeat the screenshot");
  });
}

test("a failed capture releases resizing and does not poison the next capture", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const failed = assert.rejects(host.screenshot(), /fixture capture failure/);
  await started;
  resize(940, 600);
  wc.captures[0].reject(new Error("fixture capture failure"));
  await failed;
  assert.deepEqual(wc.viewport, { width: 940, height: 600 });
  const nextStarted = once(wc, "capture-start");
  const next = host.screenshot();
  await nextStarted;
  wc.captures[1].resolve();
  assert.equal((await next).data, "fixture-image");
});

test("overlapping capture APIs serialize per page, not across sibling tabs", async (t) => {
  const { host, resize, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const first = host.screenshot();
  await started;
  const nextStarted = once(wc, "capture-start");
  const next = host.cdpCommand("Page.captureScreenshot", { format: "png" });
  host.setChromeSession("session", "second");
  await host.navigate({ url: "https://fixture.invalid/second" }, "session");
  const sibling = WebContentsView.instances.at(-1).webContents;
  const siblingStarted = once(sibling, "capture-start");
  const siblingShot = host.screenshot();
  await siblingStarted;
  assert.equal(wc.captures.length, 1, "the first page must not capture concurrently");
  sibling.captures[0].resolve();
  await siblingShot;
  wc.captures[0].resolve();
  await first;
  await nextStarted;
  assert.equal(wc.captures.length, 2, "queued capture must retain its original page");
  host.setChromeSession("session", "first");
  resize(920, 610);
  wc.captures[1].resolve();
  await next;
  assert.deepEqual(wc.viewport, { width: 920, height: 610 });
  assert.equal(sibling.captures.length, 1);
});

test("closing a tab rejects its queued capture without capturing a replacement", async (t) => {
  const { host, wc } = await harness(t);
  const started = once(wc, "capture-start");
  const first = host.screenshot();
  await started;
  const queued = assert.rejects(host.screenshot(), /browser guest is not available/);
  host.closeTab("session", "first");
  host.setChromeSession("session", "replacement");
  await host.navigate({ url: "https://fixture.invalid/replacement" }, "session");
  wc.captures[0].resolve();
  await first;
  await queued;
  assert.equal(wc.captures.length, 1);
  assert.equal(WebContentsView.instances.at(-1).webContents.captures.length, 0);
});
