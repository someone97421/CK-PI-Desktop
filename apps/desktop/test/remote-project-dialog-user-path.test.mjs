import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { ChatSurface } from "../../apps/desktop/src/components/ChatSurface";
import { ProjectCreateDialog } from "../../apps/desktop/src/components/ProjectCreateDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { remoteEn } from "../../apps/desktop/src/locales/remote";
import "../../apps/desktop/src/styles/project-create-dialog.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en), remote: remoteEn } },
  interpolation: { escapeValue: false } });
const calls = [];
const unexpectedCalls = [];
let sent = false;
const localSummary = { id: "local-empty", title: "app", projectPath: "/local/app", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z", status: "idle", mode: "agent", permissionMode: "ask", messageCount: 0 };
let releaseOldBrowse;
let releaseCreate;
const summary = { id: "remote:h2:s1", title: "app", source: "remote", remoteHostKey: "h2", remoteHostLabel: "Server 2", remoteProjectId: "p2", remoteWorkspaceLabel: "app", createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z", status: "idle", mode: "agent", permissionMode: "ask", messageCount: 0, capabilities: { canPrompt: true, canStop: true, canAttach: false, canConfigureModel: false, canPlan: false } };
window.piDesktop = { platform: "darwin", channels: IPC, on() { return () => {}; },
 async invoke(channel, input) {
  calls.push({ channel, input });
  const data = await (async () => { switch (channel) {
   case IPC.invoke.remoteHostList: return { hosts: [{ hostKey: "h1", label: "Server 1", connected: true }, { hostKey: "h2", label: "Server 2", connected: true }, { hostKey: "offline", label: "Offline", connected: false }] };
   case IPC.invoke.remoteHostProjects: return { projects: [{ id: input.hostKey === "h1" ? "p1" : "p2", label: input.hostKey === "h1" ? "old" : "app", archived: false }] };
   case IPC.invoke.remoteHostBrowseProjects:
    if (input.hostKey === "h1") return new Promise((resolve) => { releaseOldBrowse = () => resolve({ path: "/old", entries: [{ name: "stale", path: "/old/stale" }] }); });
    return { path: input.path ?? "/home/user", parent: input.path ? "/home/user" : "/home", entries: input.path ? [] : [{ name: "app", path: "/home/user/app" }] };
   case IPC.invoke.remoteHostRegisterProject: return { project: { id: "p2", label: "app", archived: false, path: input.path } };
   case IPC.invoke.remoteHostCreateSession: return new Promise((resolve) => { releaseCreate = () => resolve({ session: summary }); });
   case IPC.invoke.sessionGet: if (input.id === localSummary.id) return { session: { ...localSummary, messages: [] } }; return { session: { ...summary, messages: sent ? [{ id: "m1", role: "user", content: "Inspect remote project", timestamp: "2026-10-11T00:00:00Z" }, { id: "m2", role: "assistant", content: "Remote reply", timestamp: "2026-10-11T00:00:00Z" }] : [] } };
   case IPC.invoke.composerCommands: return { commands: [] };
   case IPC.invoke.agentPrompt: sent = true; return { accepted: true };
   case IPC.invoke.skillsList: return { skills: [] };
   case IPC.invoke.pluginsList: return { plugins: [] };
   case IPC.invoke.providersList: return { providers: [] };
   case IPC.invoke.pendingInteractive: return { asks: [], permissions: [] };
   case IPC.invoke.todosGet: return { todos: [] };
   case IPC.invoke.plansPending: return { plans: [] };
   case IPC.invoke.liveVoiceStatus: return { status: "idle" };
   case IPC.invoke.settingsGet: return { settings: {} };
   default: unexpectedCalls.push(channel); throw new Error("Unexpected IPC: " + channel);
  } })();
  return { ok: true, data };
 }
};
const view = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) { for (let n=0;n<120;n++) { if (predicate()) return; await frame(); } throw new Error(message + " body=" + document.body.textContent + " calls=" + JSON.stringify(calls)); }
const button = (label) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
function choose(node, value) { flushSync(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(node, value); node.dispatchEvent(new Event("change", { bubbles: true })); }); }
function input(node, value) { flushSync(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
window.remoteProjectProbe = async () => {
 useAppStore.setState({ workspace: { path: "/local/app", name: "app" }, activeProjectPath: "/local/app", openProjectPaths: ["/local/app"], openProjects: [{ path: "/local/app", name: "app" }], sessions: [localSummary], activeSessionId: localSummary.id, page: "chat" });
 await useAppStore.getState().openProject();
 flushSync(() => view.render(React.createElement(React.Fragment, null, React.createElement(ChatSurface), React.createElement(ProjectCreateDialog))));
 await until(() => button("Remote"), "remote source button missing");
 button("Remote").click();
 await until(() => releaseOldBrowse, "first host did not load");
 const dialog = document.querySelector('[role="dialog"]');
 check(dialog.scrollWidth <= dialog.clientWidth, "remote project dialog overflows a narrow window");
 const focusable = [...dialog.querySelectorAll('input:not([disabled]),button:not([disabled]),select:not([disabled])')];
 focusable.at(-1).focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
 check(document.activeElement === focusable[0], "remote dialog focus trap failed");
 check(!document.querySelector('option[value="offline"]'), "disconnected host offered");
 choose(document.querySelector("select"), "h2");
 await until(() => document.querySelector(".remote-project-browser-path")?.textContent === "/home/user", "new host did not load");
 releaseOldBrowse(); await settle();
 check(!document.body.textContent.includes("stale"), "late host browse replaced current directory");
 [...document.querySelectorAll(".remote-project-browser button")].find((node) => node.textContent === "app").click();
 await until(() => document.querySelector(".remote-project-browser-path")?.textContent === "/home/user/app", "directory navigation failed");
 button("Use this folder").click(); await settle();
 check(document.querySelector(".remote-project-picker input").value === "/home/user/app", "chosen path was not retained");
 input(document.querySelector(".remote-project-picker input"), "relative"); await settle();
 check(document.querySelector('button[type="submit"]').disabled, "relative remote path accepted");
 input(document.querySelector(".remote-project-picker input"), "/home/user/app"); await settle();
 const form = document.querySelector("form");
 form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => releaseCreate, "remote session creation did not start");
 check(calls.filter((entry) => entry.channel === IPC.invoke.remoteHostRegisterProject).length === 1, "duplicate registration");
 check(calls.filter((entry) => entry.channel === IPC.invoke.remoteHostCreateSession).length === 1, "duplicate creation");
 releaseCreate();
 await until(() => useAppStore.getState().activeSessionId === summary.id && !document.querySelector('[role="dialog"]'), "remote session did not open");
 check(useAppStore.getState().messages.length === 0 && useAppStore.getState().page === "chat", "not an empty chat");
 check(!useAppStore.getState().sessions.find((session) => session.id === summary.id).projectPath, "remote path leaked to local workspace");
 await useAppStore.getState().openProject(); await settle(); button("Remote").click();
 await until(() => document.querySelector("select")?.value === "h1", "dialog reopen failed");
 choose(document.querySelector("select"), "h2");
 await until(() => document.querySelector('option[value="p2"]'), "existing project missing");
 choose(document.querySelectorAll("select")[1], "p2"); await settle();
 document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
 await until(() => !document.querySelector('[role="dialog"]'), "existing project did not open");
 check(calls.filter((entry) => entry.channel === IPC.invoke.remoteHostRegisterProject).length === 1, "existing project unnecessarily registered");
 check(calls.filter((entry) => entry.channel === IPC.invoke.remoteHostCreateSession).length === 1, "empty remote session was not reused");
 await useAppStore.getState().newSession();
 check(useAppStore.getState().activeSessionId === summary.id, "new conversation escaped remote project");
 check(calls.filter((entry) => entry.channel === IPC.invoke.remoteHostCreateSession).length === 1, "new conversation did not reuse empty remote session");
 async function switchProject(remote) {
   document.querySelector('[data-testid="home-project-switcher"]').click();
   await until(() => [...document.querySelectorAll('[role="menuitemradio"]')].some((node) => node.textContent.includes("Server 2")), "remote menu inventory missing");
   const target = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) => remote ? node.textContent.includes("app · Server 2") : node.getAttribute("title") === "/local/app");
   check(target, "project menu target missing"); target.click();
   await until(() => useAppStore.getState().activeSessionId === (remote ? summary.id : localSummary.id) && !document.querySelector('[role="menu"]'), "project switch failed");
   check(useAppStore.getState().workspace?.path === "/local/app", "remote navigation altered local workspace");
 }
 await switchProject(false); await switchProject(true); await switchProject(false); await switchProject(true);
 check(document.querySelector('.empty-hero')?.textContent.includes("app"), "remote project hero missing");
 const composerInput = document.querySelector('.composer-shell [role="textbox"]');
 check(composerInput && composerInput.getAttribute("aria-readonly") !== "true", "normal remote composer missing");
 flushSync(() => { composerInput.textContent = "Inspect remote project"; composerInput.dispatchEvent(new Event("input", { bubbles: true })); });
 await settle();
 const sendButton = document.querySelector('.composer-shell [aria-label="' + i18n.t("chat.send") + '"]');
 check(sendButton && !sendButton.disabled, "remote send action unavailable");
 sendButton.click();
 await until(() => calls.some((entry) => entry.channel === IPC.invoke.agentPrompt), "normal composer did not send remote prompt");
 await useAppStore.getState().selectSession(summary.id, { record: false });
 await until(() => document.querySelector('.session-pane')?.textContent.includes("Remote reply"), "remote transcript did not show reply");
 check(!document.querySelector('.empty-hero'), "empty hero remained after messages");
 check(!calls.some((entry) => [IPC.invoke.projectActivate, IPC.invoke.sessionConfigure].includes(entry.channel)), "remote flow called local workspace or model configuration");
 const sessionsBefore = useAppStore.getState().sessions;
 useAppStore.setState({ sessions: sessionsBefore.map((session) => session.id === summary.id ? { ...session, remoteProjectId: undefined } : session) });
 let rejected = false;
 try { await useAppStore.getState().newSession(); } catch { rejected = true; }
 check(rejected, "incomplete remote identity fell back to local chat creation");
 useAppStore.setState({ sessions: sessionsBefore });
 flushSync(() => view.unmount());
 releaseOldBrowse(); await settle();
 check(unexpectedCalls.length === 0, "unexpected IPC calls: " + unexpectedCalls.join(", "));
 return { passed: true };
};
`;

test("home project dialog browses remote paths and opens an empty remote session", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.remote-project-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      plugins: [{ name: "vite-url-assets", setup(plugin) {
        plugin.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "url-asset" }));
        plugin.onLoad({ filter: /.*/, namespace: "url-asset" }, () => ({ contents: 'export default "fixture-asset";', loader: "js" }));
      } }],
      loader: { ".css": "empty", ".png": "dataurl", ".gif": "dataurl" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "renderer.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 380, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (...args) => console.log("RENDERER", (args[0].message ?? args[2] ?? "").slice(0, 500)));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("REMOTE_PROJECT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.remoteProjectProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("REMOTE_PROJECT_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("REMOTE_PROJECT_PROBE ".length)), {
      passed: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
