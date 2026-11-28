import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemotePluginViewHandler } = await import("../electron/main/remote-plugin-view.ts");

function makeHandler(path, manifest) {
  const calls = [];
  const projectPath = join(path, "project");
  const workspacePath = join(path, "worktree");
  const host = {
    async call(method, input) {
      calls.push([method, input]);
      if (method === "session.get" && ["s1", "s2"].includes(input.id)) {
        return { session: { projectPath: input.id === "s1" ? projectPath : join(path, "other"), worktree: true } };
      }
      if (method === "worktree.location" && input.sessionId === "s1") return { path: workspacePath };
      throw new Error(`Unexpected host call: ${method}`);
    },
  };
  const plugin = { path, manifest, permissions: new Set(["ui.view"]) };
  const invoke = createRemotePluginViewHandler({
    plugins: { getLoaded: (id) => id === manifest.id ? plugin : undefined },
    pluginPanels: { invokeRemoteView: async (...args) => { calls.push(args); return { ok: true }; } },
    getHost: () => host,
    pluginActiveInProject: (id, project) => id === manifest.id && project === projectPath,
  });
  return {
    calls, projectPath, workspacePath,
    request: (op, options) => invoke({ op, pluginId: manifest.id, viewId: manifest.contributes.views[0].id, sessionId: "s1", ...options }),
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-plugin-view-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "plugin");
  const files = {
    "index.html": `<!doctype html>
<link href='./panel.css?v=1' rel=stylesheet>
<link rel="modulepreload" href="./%73hared.mjs#bundle">
<script src="./panel.js" defer></script>
<script src="./assets/main.js"></script>
<script src="./server.js"></script>
<script src="./linked/outside.mjs"></script>
<!-- <script src="./commented.js"></script> -->
<script>const markup = '<link rel="stylesheet" href="./hidden.css">';</script>`,
    "panel.css": "body { color: blue; }",
    "panel.js": "void 0;",
    "shared.mjs": "export {};",
    "assets/chunks/view.js": "export {};",
    "static/panel.svg": "<svg/>",
    "assets/main.js": "backend entry",
    "assets/private/secret.js": "private",
    "assets/secrets.json": "{}",
    "server.js": "backend helper",
    "commented.js": "commented",
    "hidden.css": "hidden",
    "unreferenced.js": "unreferenced",
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const outside = join(dir, "external");
  await mkdir(outside);
  await writeFile(join(outside, "outside.mjs"), "outside the plugin");
  await symlink(outside, join(root, "linked"), "junction");
  await symlink(outside, join(root, "assets", "linked"), "junction");
  const manifest = { id: "test.panel", main: "assets/main.js", contributes: { views: [{ id: "panel", entry: "index.html" }] } };
  return { ...makeHandler(root, manifest), files };
}

test("根目录面板开放入口、显式脚本和样式以及构建静态资源", async (t) => {
  const { request, files } = await fixture(t);
  assert.equal((await request("open")).entry, "index.html");
  for (const [path, mime] of [
    ["index.html", "text/html"], ["panel.js", "text/javascript"], ["shared.mjs", "text/javascript"],
    ["panel.css", "text/css"], ["assets/chunks/view.js", "text/javascript"], ["static/panel.svg", "image/svg+xml"],
  ]) {
    const asset = await request("asset", { path });
    assert.equal(asset.contentType.split(";")[0], mime, path);
    assert.equal(Buffer.from(asset.body, "base64").toString(), files[path], path);
  }
});

test("面板拒绝后台、私有、未引用和越界资源", async (t) => {
  const { request } = await fixture(t);
  for (const path of [
    "assets/main.js", "server.js", "assets/private/secret.js", "assets/secrets.json", "unreferenced.js", "commented.js",
    "hidden.css", "../outside.mjs", "assets/../panel.js", "/panel.js", "linked/outside.mjs", "assets/linked/outside.mjs",
  ]) {
    await assert.rejects(request("asset", { path }), { errorCode: "NOT_FOUND" }, path);
  }
  await assert.rejects(request("open", { sessionId: "s2" }), { errorCode: "NOT_FOUND" });
  await assert.rejects(request("asset", { pluginId: "other.plugin", path: "panel.js" }), { errorCode: "NOT_FOUND" });
});

test("调用把请求会话的项目与实际 worktree 交给原面板桥", async (t) => {
  const { request, calls, projectPath, workspacePath } = await fixture(t);
  const payload = { path: "src" };
  assert.deepEqual(await request("invoke", { channel: "panel.list", payload }), { ok: true });
  assert.deepEqual(calls, [
    ["session.get", { id: "s1", messageLimit: 1, contentLimit: 1 }],
    ["worktree.location", { sessionId: "s1" }],
    ["test.panel", "panel.list", payload, { sessionId: "s1", projectPath, workspacePath }],
  ]);
});

test("pi.terminal 实际入口和引用的全部 JS/CSS 可由宿主读取", async () => {
  const root = fileURLToPath(new URL("../resources/plugins/pi.terminal/", import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const { request } = makeHandler(root, manifest);
  const { entry } = await request("open");
  assert.equal(entry, "renderer/index.html");
  const html = await readFile(join(root, entry), "utf8");
  const references = [...html.matchAll(/\b(?:src|href)="\.\/([^"\s]+\.(?:js|css))"/g)].map(([, path]) => path);
  assert.equal(references.length, 8);
  for (const path of [entry, ...references.map((ref) => `${dirname(entry)}/${ref}`)]) {
    const asset = await request("asset", { path });
    assert.deepEqual(Buffer.from(asset.body, "base64"), await readFile(join(root, path)), path);
  }
});
