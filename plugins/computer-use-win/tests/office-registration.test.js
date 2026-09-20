"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { OCU_TOOLS, STOP_TOOL } = require("../tools");
const manifest = require("../manifest.json");

function fixture(call) {
  const registered = new Map();
  const stopped = [];
  const module = { exports: {} };
  const mocks = {
    "./runtime": { ComputerUseRuntime: class { stop() { stopped.push("desktop"); } } },
    "./policy": { parseAllowlist: () => [] },
    "./tools": { OCU_TOOLS, STOP_TOOL, makeExecutors: () => ({ get_app_state: call }) },
    "./cua": {},
  };
  const pi = {
    plugin: { getSettings: async () => ({ autoStart: false }), getDataPath: async () => { throw new Error("no path in test"); } },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async (t) => registered.set(t.name, t), unregisterTool: async (name) => registered.delete(name) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), {
    module, pi, process, require: (name) => mocks[name] || require(name),
  });
  return { api: module.exports, registered, stopped };
}

test("plugin lifecycle registers every declared desktop tool and preserves observation content", async () => {
  const result = { isError: false, content: [{ type: "image", mimeType: "image/png", data: "abc" }], structuredContent: { observation_id: 1 } };
  const f = fixture(async () => result);
  await f.api.onLoad();
  assert.deepEqual([...f.registered.keys()].sort(), manifest.contributes.agentTools.map(t => t.name).sort());
  assert.strictEqual(await f.registered.get("get_app_state").execute({}), result);
  await f.api.onUnload();
  assert.equal(f.registered.size, 0);
  assert.deepEqual(f.stopped, ["desktop"]);
});

test("plugin entry retains upstream RPC error details and marks errors explicitly", async () => {
  const rpcError = { code: -32000, message: "partial failure", data: { applied: 1, failed: 1 } };
  const f = fixture(async () => { throw Object.assign(new Error("Inspect outputs before retry"), { rpcError }); });
  await f.api.onLoad();
  const result = await f.registered.get("get_app_state").execute({});
  assert.equal(result.ok, false);
  assert.equal(result.isError, true);
  assert.strictEqual(result.rpcError, rpcError);
  assert.match(result.error, /Inspect outputs/);
  await f.api.onUnload();
});

test("manifest retains available desktop and Office knowledge skills", () => {
  assert.deepEqual(manifest.contributes.skills, [
    "skills/computer-use.md", "skills/office-workflows.md", "skills/office-desktop.md",
  ]);
  for (const skill of manifest.contributes.skills) {
    const content = fs.readFileSync(path.join(__dirname, "..", skill), "utf8");
    assert.ok(content.startsWith("---"), skill);
    assert.ok(content.includes(`name: ${path.basename(skill, ".md")}`), skill);
  }
});
