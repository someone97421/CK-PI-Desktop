import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = process.env.PI_SCRATCH_DIR || tmpdir();
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

test("插件页面的目录作用域跨进程传入原有 workspace.get，隔离并发和空草稿", async (t) => {
  const root = mkdtempSync(join(scratch, "pi-panel-workspace-"));
  const pluginDir = join(root, "plugin");
  mkdirSync(pluginDir);
  const globalRoot = join(root, "project");
  const first = { path: join(root, "first"), name: "first" };
  const second = { path: join(root, "second"), name: "second" };
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "lab.panel-workspace", name: "目录作用域", version: "0.0.1",
    main: "main.js", permissions: ["ui.view"],
  }));
  writeFileSync(join(pluginDir, "main.js"), `
    module.exports = {
      async onPanelInvoke(channel, payload) {
        const before = await pi.workspace.get();
        await new Promise(resolve => setTimeout(resolve, payload.delay || 0));
        return { before, after: await pi.workspace.get() };
      },
    };
  `);
  const runtime = new PluginRuntime({
    hostEntry: join(here, "../electron/main/plugin-host-process.mjs"),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: message => { if (child.connected) child.send(message); },
        onMessage: handler => child.on("message", handler),
        onExit: handler => child.on("exit", code => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    getWorkspacePath: () => globalRoot,
    audit: () => {},
  });
  t.after(async () => {
    await runtime.unload("lab.panel-workspace");
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.loadFromPath(pluginDir, ["ui.view"]);
  const invoke = (workspaceScope, delay = 0) => runtime.invokePanelBridge(
    "lab.panel-workspace", "fm.list", { delay }, { workspaceScope },
  );
  const [a, b, empty, project] = await Promise.all([
    invoke(first, 30), invoke(second, 5), invoke(null, 10), invoke(undefined, 15),
  ]);
  assert.deepEqual(a, { before: first, after: first });
  assert.deepEqual(b, { before: second, after: second });
  assert.deepEqual(empty, { before: null, after: null });
  assert.equal(project.before.path, globalRoot);
  assert.equal(project.after.path, globalRoot);
  assert.equal((await invoke(undefined)).before.path, globalRoot);
});
