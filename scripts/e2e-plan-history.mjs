#!/usr/bin/env node
/** Historical contracts through production session IPC, renderer and an isolated Rust host. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const binary = resolveHostBinary();
const temp = await mkdtemp(join(tmpdir(), "pi-plan-history-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/plan-history.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    alias: {
      "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/ipc/session-ipc.ts")],
    outfile: join(temp, "session-ipc.cjs"), bundle: true, platform: "node", format: "cjs",
    external: ["electron"],
  });
  await build({ entryPoints: [join(root, "apps/desktop/electron/preload/index.ts")],
    outfile: join(temp, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
    alias: { "@pi-desktop/shared/protocol": join(root, "packages/shared/src/protocol.ts") } });
  await writeFile(join(temp, "tokens.css"), (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(/@theme(?: inline)?/g, ":root"));
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="renderer.css"><body><script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { registerSessionIpc } = require("./session-ipc.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const { Host } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/e2e/host.mjs")).href)});
  const { IPC } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/shared/dist/protocol.js")).href)});
  const host = new Host(${JSON.stringify(binary)}, path.join(__dirname, "data"));
  let window;
  let failure;
  try {
    await host.start();
    const fs = require("node:fs/promises");
    const workspace = path.join(__dirname, "workspace");
    await fs.mkdir(workspace);
    const { session } = await host.call("session.create", { title: "Plan history", mode: "plan", projectPath: workspace });
    const submit = async (owner, title, kind = "plan") => {
      const { turnId } = await host.call("session.beginTurn", { sessionId: owner.id });
      const { proposal } = await host.call("plans.submit", { sessionId: owner.id, turnId, toolCallId: title, kind,
        title, markdown: "# Exact " + title + "\\n\\n- retain exact bytes  \\n\\nEND-" + title, question: "Proceed?" });
      const message = { id: "tool-" + title, role: "tool", content: "submitted", createdAt: proposal.createdAt,
        toolName: kind === "goal" ? "SubmitGoal" : "SubmitPlan", toolCallId: title,
        toolResult: { details: { proposal } }, toolStatus: "success" };
      await host.call("session.appendMessage", { sessionId: owner.id, turnId, message });
      if (await fs.readFile(path.join(workspace, proposal.artifact.relativePath), "utf8") !== proposal.markdown) throw new Error("artifact bytes changed");
      return { proposal, message };
    };
    const resolve = (proposal, action) => host.call("plans.resolve", { proposalId: proposal.id, sessionId: proposal.sessionId,
      turnId: proposal.turnId, toolCallId: proposal.toolCallId, version: proposal.version, action,
      ...(action === "approve" ? { targetPermissionMode: "ask" } : {}) });
    const first = await submit(session, "v1");
    const registrar = { handle(channel, handler) {
      ipcMain.handle(channel, async (_event, input) => {
        try { return { ok: true, data: await handler(input) }; }
        catch (error) { return { ok: false, error: { code: error.errorCode || "INTERNAL", message: error.message } }; }
      });
    } };
    registerSessionIpc({ registrar, getHost: () => host, getSidecar: () => null,
      dataDir: path.join(__dirname, "data"), activeTurns: new Map(), sessionProjects: new Map(),
      persistenceOutbox: {}, logger: { app() {} }, plugins: { broadcastEvent() {} },
      sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
      enrichSession: session => session, acquireSessionOperation: async () => () => {}, stripWinLongPrefix: value => value });
    registrar.handle(IPC.invoke.agentQueueList, async () => ({ entries: [] }));
    window = new BrowserWindow({ show: false, width: 1000, height: 1000, webPreferences: {
      preload: ${JSON.stringify(join(temp, "preload.cjs"))},
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    window.webContents.on("console-message", (event) => console.error(event.message));
    await window.loadFile(path.join(__dirname, "index.html"));
    const probe = (name, ...args) => window.webContents.executeJavaScript("globalThis." + name + "(" + args.map(value => JSON.stringify(value)).join(",") + ")");
    const pending = await probe("planHistoryLoad", session.id, ["pending"]);
    const stateOnly = await probe("planHistoryStateOnly");
    const approval = await resolve(first.proposal, "approve");
    const live = await probe("planHistoryLive", approval.proposal, first.message);
    await host.call("session.endTurn", { turnId: first.proposal.turnId, createNotification: false });
    await host.call("plans.claimExecution", { executionId: approval.proposal.executionId });
    await host.call("plans.finishExecution", { executionId: approval.proposal.executionId, status: "completed" });
    await host.call("session.configure", { id: session.id, mode: "plan" });
    const second = await submit(session, "v2");
    await resolve(second.proposal, "reject");
    await host.call("session.endTurn", { turnId: second.proposal.turnId, createNotification: false });
    const versions = await probe("planHistoryLoad", session.id, ["approved", "rejected"]);
    const pagination = await probe("planHistoryPagination", session.id);
    if (process.env.PI_DESKTOP_E2E_EVIDENCE_DIR) {
      await fs.mkdir(process.env.PI_DESKTOP_E2E_EVIDENCE_DIR, { recursive: true });
      await fs.writeFile(path.join(process.env.PI_DESKTOP_E2E_EVIDENCE_DIR, "plan-history.png"), (await window.webContents.capturePage()).toPNG());
    }
    const { session: goal } = await host.call("session.create", { title: "Goal history", mode: "goal", projectPath: workspace });
    const goalSubmission = await submit(goal, "goal", "goal");
    await resolve(goalSubmission.proposal, "reject");
    await host.call("session.endTurn", { turnId: goalSubmission.proposal.turnId, createNotification: false });
    const goals = await probe("planHistoryLoad", goal.id, ["rejected"], "zh-CN");
    await host.call("session.appendCompaction", { sessionId: session.id, compaction: { id: "history-compaction",
      summary: "Earlier planning condensed", throughMessageId: second.message.id, tokensBefore: 100, createdAt: new Date().toISOString() } });
    await host.call("session.appendMessage", { sessionId: session.id, message: { id: "continued", role: "assistant", content: "continued after compaction", createdAt: new Date().toISOString() } });
    await host.restart();
    await window.loadFile(path.join(__dirname, "index.html"));
    const restart = await probe("planHistoryLoad", session.id, ["approved", "rejected"]);
    console.log("PLAN_HISTORY_PROBE " + JSON.stringify({ ok: true, pending, stateOnly, live, versions, pagination, goals, restart, compaction: true }));
  } catch (error) {
    failure = error;
    console.error("PLAN_HISTORY_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
  } finally {
    window?.destroy();
    await host.stop();
    app.exit(failure ? 1 : 0);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("PLAN_HISTORY_PROBE "));
  assert(line, `no result (exit=${code}): ${output.slice(-4000)}`);
  console.log(line);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(JSON.parse(line.slice("PLAN_HISTORY_PROBE ".length)).ok, true);
} finally { await rm(temp, { recursive: true, force: true }); }
