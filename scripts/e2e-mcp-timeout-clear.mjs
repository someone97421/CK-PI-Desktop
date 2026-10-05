#!/usr/bin/env node
/** Exercise timeout validation and clearing through the production MCP editor in Electron. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "pi-mcp-timeout-clear-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/mcp-timeout-clear.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    loader: { ".css": "empty" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.disableHardwareAcceleration();
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("window.mcpTimeoutClearProbe()");
    console.log("MCP_TIMEOUT_CLEAR " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("MCP_TIMEOUT_CLEAR " + (error?.stack ?? String(error)));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [
    "--headless=new",
    "--disable-gpu",
    join(temp, "main.cjs"),
  ], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output += chunk; });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output.split(/\r?\n/).find((item) => item.startsWith("MCP_TIMEOUT_CLEAR "));
  assert(line, `renderer returned no MCP timeout result (exit=${code}): ${output.slice(-3000)}`);
  const result = JSON.parse(line.slice("MCP_TIMEOUT_CLEAR ".length));
  console.log(line);
  assert.equal(code, 0, output.slice(-3000));
  assert.deepEqual(result, {
    originalValue: "45",
    invalidValueBlocked: true,
    clearedValueEnabled: true,
    savedTimeoutSeconds: null,
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
