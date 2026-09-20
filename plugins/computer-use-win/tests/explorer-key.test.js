"use strict";
// Real runtime.js in a VM; all focus, driver, and observation transports are mocked.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const runtimePath = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(runtimePath, "utf8");

function fixture() {
  const calls = { focus: 0, driver: [], observe: 0 };
  const sandbox = {
    module: { exports: {} }, exports: {}, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.dirname(runtimePath), process: { platform: "win32", env: {} },
    require(name) {
      if (name === "./powershell") return { resolvePowerShell: () => "powershell.exe" };
      if (name === "node:child_process") return {
        spawn() { throw new Error("live process prohibited"); },
        spawnSync(exe, args) {
          if (args.some((arg) => String(arg).endsWith("windows-uia-focus.ps1"))) {
            calls.focus++;
            return { status: 0, stdout: "" };
          }
          throw new Error("unexpected native key transport");
        },
      };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: runtimePath });
  const runtime = new sandbox.module.exports.ComputerUseRuntime();
  const target = { app: "explorer", app_name: "explorer", pid: 42, window_id: 100 };
  runtime.targets.set("explorer", { ...target, tree_actionable: true, snapshot_actionable: true,
    snapshot_id: "snap", elements: [
      { role: "Edit", name: "Address", element_index: 1, element_token: "snap:1", enabled: true, visible: true },
      { role: "ListItem", name: "report.txt", element_index: 2, element_token: "snap:2", enabled: true, visible: true },
    ] });
  runtime._resolveTarget = async () => target;
  runtime._childEnv = () => ({});
  runtime._cua = async (name, payload) => {
    if (name === "get_window_state") {
      calls.observe++;
      return { structuredContent: { ...target, snapshot_id: "after", elements: [], elements_complete: true,
        tree_actionable: true, snapshot_actionable: true } };
    }
    calls.driver.push({ name, payload });
    return { structuredContent: { effect: "unverifiable", verified: false } };
  };
  runtime.ensureRunning = async () => {};
  runtime.beginControl = () => {};
  runtime.endControl = () => {};
  return { runtime, calls };
}

for (const key of ["Delete", "Backspace", "Ctrl+Delete", "Shift+Delete", "Ctrl+Backspace", "Shift+Backspace"]) {
  test(`${key} preserves Explorer focus and uses the generic driver exactly once`, async () => {
    const f = fixture();
    await f.runtime._pressKey({ app: "explorer", key }, false);
    assert.equal(f.calls.focus, 0);
    assert.equal(f.calls.driver.length, 1);
    assert.equal(f.calls.driver[0].name, key.includes("+") ? "hotkey" : "press_key");
    if (key.includes("+")) assert.deepEqual(Array.from(f.calls.driver[0].payload.keys), key.toLowerCase().split("+"));
    else assert.equal(f.calls.driver[0].payload.key, key.toLowerCase());
  });
}

test("unrelated editor hotkey keeps the existing UIA focus behavior", async () => {
  const f = fixture();
  await f.runtime._pressKey({ app: "explorer", key: "Ctrl+A" }, false);
  assert.equal(f.calls.focus, 1);
  assert.equal(f.calls.driver.length, 1);
  assert.equal(f.calls.driver[0].name, "hotkey");
});

test("explicit Explorer element target remains exact without automatic refocus", async () => {
  const f = fixture();
  await f.runtime._pressKey({ app: "explorer", key: "Delete", element_index: 2 }, false);
  assert.equal(f.calls.focus, 0);
  assert.equal(f.calls.driver.length, 1);
  assert.equal(f.calls.driver[0].payload.element_index, 2);
  assert.equal(f.calls.driver[0].payload.element_token, "snap:2");
  assert.equal(f.calls.driver[0].payload.snapshot_id, "snap");
});

test("observe=true performs one Delete and observation never replays it", async () => {
  const f = fixture();
  await f.runtime.callTool("press_key", { app: "explorer", key: "Delete" }, { observe: true });
  assert.equal(f.calls.focus, 0);
  assert.equal(f.calls.driver.filter((call) => call.name === "press_key").length, 1);
  assert.equal(f.calls.observe, 1);
});
