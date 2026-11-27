import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const desktop = join(root, "apps/desktop");
const run = promisify(execFile);

const inspectSidebar = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const body = document.querySelector(".sidebar-body");
  const temporary = document.querySelector(".sidebar-session-group-body.standalone");
  const pinned = document.querySelector(".sidebar-session-group-body.pinned");
  const projects = document.querySelector(".sidebar-session-groups");
  const pointFor = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return element.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  };
  return {
    viewport: innerHeight,
    pinned: pinned.clientHeight,
    temporaryHeight: temporary.clientHeight,
    temporaryCount: temporary.querySelectorAll("[data-sidebar-session-row]").length,
    projectCount: projects.querySelectorAll("[data-sidebar-session-row]").length,
    sidebarWidth: document.querySelector(".sidebar").getBoundingClientRect().width,
    projectHeight: projects.clientHeight,
    project: pointFor('.sidebar-session-groups [data-sidebar-session-row="session-1"] .thread-item-main'),
    settings: pointFor('[data-nav="settings"]'),
    outerOverflow: body.scrollHeight - body.clientHeight,
    outerScroll: getComputedStyle(body).overflowY,
  };
};

test("sidebar keeps project sessions and Settings reachable after loading more and zooming", {
  skip: process.platform === "linux" && !process.env.DISPLAY && "Electron requires a display",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-sidebar-height-"));
  try {
    await build({
      configFile: false,
      root: desktop,
      base: "./",
      logLevel: "error",
      plugins: [tailwindcss()],
      esbuild: { jsx: "automatic" },
      resolve: {
        alias: [
          { find: /^@pi-desktop\/shared$/, replacement: join(root, "packages/shared/src/index.ts") },
          { find: /^@pi-desktop\/i18n$/, replacement: join(root, "packages/i18n/src/index.ts") },
        ],
      },
      build: {
        outDir: temp,
        target: "esnext",
        cssCodeSplit: false,
        rollupOptions: {
          input: join(desktop, "test/fixtures/sidebar-height.tsx"),
          output: {
            format: "iife",
            inlineDynamicImports: true,
            entryFileNames: "sidebar.js",
            assetFileNames: "assets/[name][extname]",
          },
        },
      },
    });
    await writeFile(join(temp, "index.html"), `<!doctype html>
      <html lang="en" data-platform="${process.platform}"><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:">
      <link rel="stylesheet" href="assets/style.css"><div id="root"></div><script defer src="sidebar.js"></script>`);
    await writeFile(join(temp, "main.cjs"), `
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1040, height: 720, useContentSize: true,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const evaluate = (code) => wc.executeJavaScript(code);
  const inspect = () => evaluate(${JSON.stringify(`(${inspectSidebar})()`)});
  await win.loadFile(join(__dirname, "index.html"));
  await evaluate("window.sidebarProbe.then(() => true)");
  const initial = await inspect();
  assert.equal(initial.sidebarWidth, 275);
  assert.equal(initial.temporaryCount, 8);
  assert.equal(initial.projectCount, 3);
  await evaluate("document.querySelector('.sidebar-session-groups .sidebar-load-more').click()");
  const loaded = await inspect();
  assert.equal(loaded.projectCount, 8);
  assert.ok(loaded.project, JSON.stringify(loaded));

  const compactHeight = 350;
  wc.setZoomFactor(win.getContentSize()[1] / compactHeight);
  const compact = await inspect();
  assert.ok(Math.abs(compact.viewport - compactHeight) <= 1, JSON.stringify(compact));
  assert.equal(compact.sidebarWidth, 275);
  assert.equal(compact.projectCount, loaded.projectCount);
  assert.ok(compact.project, "Project row clipped: " + JSON.stringify(compact));
  assert.ok(compact.pinned < loaded.pinned, JSON.stringify(compact));
  assert.ok(compact.temporaryHeight < loaded.temporaryHeight, JSON.stringify(compact));
  assert.ok(compact.settings, JSON.stringify(compact));
  const point = {
    x: Math.round(compact.project.x * wc.getZoomFactor()),
    y: Math.round(compact.project.y * wc.getZoomFactor()),
    button: "left", clickCount: 1,
  };
  wc.sendInputEvent({ type: "mouseDown", ...point });
  wc.sendInputEvent({ type: "mouseUp", ...point });
  await inspect();
  assert.deepEqual(await evaluate("window.sidebarProbe.then(({ calls }) => calls)"), ["session-1"]);

  wc.setZoomFactor(3);
  const extreme = await inspect();
  assert.ok(extreme.outerOverflow > 0);
  assert.equal(extreme.outerScroll, "auto");
  await evaluate("document.querySelector('[data-nav=settings]').scrollIntoView()");
  assert.ok((await inspect()).settings);
  await evaluate("document.querySelector('.sidebar-session-groups').scrollIntoView()");
  assert.ok((await inspect()).project);

  wc.setZoomFactor(1);
  const restored = await inspect();
  assert.equal(restored.projectCount, loaded.projectCount);
  assert.equal(restored.temporaryHeight, loaded.temporaryHeight);
  assert.equal(restored.pinned, loaded.pinned);
  assert.ok(restored.project);
  assert.ok(restored.settings);
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await run(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, timeout: 30_000,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
