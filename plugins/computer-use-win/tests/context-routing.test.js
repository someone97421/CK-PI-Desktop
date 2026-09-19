"use strict";
// All driver calls are mocked. This suite never touches a real GUI.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const runtimePath = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(runtimePath, "utf8");
const button = { role: "Button", label: "Open", element_index: 4, element_token: "button-4",
  frame: { x: 10, y: 10, w: 100, h: 40 }, actions: ["Invoke"] };
const overlayItem = { role: "MenuItem", label: "删除记录", element_index: 5,
  frame: { x: 10, y: 60, w: 100, h: 30 }, actions: ["Invoke"] };

function fixture({ elements = [button], clickResult, stopAfterFront = false, replaceAfterFront = false } = {}) {
  const calls = [];
  const sandbox = {
    module: { exports: {} }, exports: {}, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.dirname(runtimePath), process: { platform: "win32", env: {} },
    require(name) {
      if (name === "node:child_process") return {
        spawn() { throw new Error("Unexpected spawn"); },
        spawnSync() { throw new Error("Unexpected native input"); },
      };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: runtimePath });
  const runtime = Object.create(sandbox.module.exports.ComputerUseRuntime.prototype);
  runtime.targets = new Map([["notepad", {
    app: "notepad", pid: 42, window_id: 100, tree_actionable: true,
    snapshot_id: "snap", elements: elements.map((item) => ({ ...item })),
  }]]);
  runtime._resolveTarget = async () => runtime.targets.get("notepad");
  runtime._cua = async (name, payload) => {
    calls.push({ name, payload });
    if (name === "bring_to_front") {
      if (stopAfterFront) runtime.stoppedByUser = true;
      if (replaceAfterFront) runtime._sessionEpoch = (runtime._sessionEpoch || 0) + 1;
      return { structuredContent: {} };
    }
    if (name !== "click") throw new Error(`unexpected ${name}`);
    if (clickResult instanceof Error) throw clickResult;
    return clickResult || { structuredContent: { effect: "unverifiable", verified: false } };
  };
  return { runtime, calls, clicks: () => calls.filter((call) => call.name === "click"),
    fronts: () => calls.filter((call) => call.name === "bring_to_front") };
}

test("coordinate right-click chooses foreground once and preserves explicit pixels", async () => {
  const f = fixture();
  const result = await f.runtime._click({ app: "notepad", x: 20, y: 20, mouse_button: "right" }, true);
  assert.equal(f.fronts().length, 1);
  assert.equal(f.clicks().length, 1);
  assert.equal(f.clicks()[0].payload.delivery_mode, "foreground");
  assert.equal(f.clicks()[0].payload.x, 20);
  assert.equal(f.clicks()[0].payload.y, 20);
  assert.equal(f.clicks()[0].payload.button, "right");
  assert.equal(f.clicks()[0].payload.element_index, undefined, "right-click must not become default AX Invoke");
  assert.equal(result.structuredContent.route_reason, "right_click_foreground");
  assert.equal(result.structuredContent.delivery_path, "cua-foreground");
  assert.equal(result.structuredContent.overlay_unverified, undefined);
  assert.equal(f.runtime.targets.get("notepad").tree_actionable, false);
});

test("AX right-click uses foreground target once without overlay annotation", async () => {
  const f = fixture();
  const result = await f.runtime._click({ app: "notepad", element_index: 4, mouse_button: "right" }, true);
  assert.equal(f.clicks().length, 1);
  assert.equal(f.clicks()[0].payload.delivery_mode, "foreground");
  assert.equal(f.clicks()[0].payload.element_index, 4);
  assert.equal(f.clicks()[0].payload.element_token, "button-4");
  assert.equal(result.structuredContent.overlay_unverified, undefined);
});

for (const [label, clickResult] of [
  ["unverified", { structuredContent: { effect: "unverifiable", verified: false } }],
  ["error", { isError: true, content: [{ type: "text", text: "occluded" }], structuredContent: { code: "background_occluded" } }],
  ["throw", new Error("delivery uncertain")],
]) {
  test(`right-click ${label} result is never replayed or mislabeled as overlay`, async () => {
    const f = fixture({ clickResult });
    const result = await f.runtime._click({ app: "notepad", x: 200, y: 200, mouse_button: "right" }, true);
    assert.equal(f.clicks().length, 1);
    assert.equal(f.clicks()[0].payload.delivery_mode, "foreground");
    assert.equal(result.structuredContent.overlay_unverified, undefined);
    assert.equal(result.structuredContent.route_reason, "right_click_foreground");
  });
}

test("plain left pixel click keeps background AX upgrade behavior", async () => {
  const f = fixture();
  const result = await f.runtime._click({ app: "notepad", x: 20, y: 20 }, true);
  assert.equal(f.fronts().length, 0);
  assert.equal(f.clicks().length, 1);
  assert.equal(f.clicks()[0].payload.delivery_mode, "background");
  assert.equal(f.clicks()[0].payload.element_index, 4);
  assert.equal(f.clicks()[0].payload.x, undefined);
  assert.equal(result.structuredContent.route_reason, "default_delivery");
});

test("existing overlay left click retains foreground and overlay_unverified behavior", async () => {
  const f = fixture({ elements: [overlayItem] });
  const result = await f.runtime._click({ app: "notepad", element_index: 5 }, true);
  assert.equal(f.fronts().length, 1);
  assert.equal(f.clicks().length, 1);
  assert.equal(f.clicks()[0].payload.delivery_mode, "foreground");
  assert.equal(result.structuredContent.overlay_unverified, true);
  assert.equal(result.structuredContent.route_reason, "existing_overlay");
});

test("stop after foreground preparation prevents the right-click", async () => {
  const f = fixture({ stopAfterFront: true });
  const result = await f.runtime._click({ app: "notepad", x: 20, y: 20, mouse_button: "right" }, true);
  assert.equal(f.fronts().length, 1);
  assert.equal(f.clicks().length, 0);
  assert.equal(result.structuredContent.code, "stopped_by_user");
  assert.equal(result.structuredContent.delivery, "not_sent");
});

test("replacement driver after foreground preparation receives no stale right-click", async () => {
  const f = fixture({ replaceAfterFront: true });
  const result = await f.runtime._click({ app: "notepad", x: 20, y: 20, mouse_button: "right" }, true);
  assert.equal(f.fronts().length, 1);
  assert.equal(f.clicks().length, 0);
  assert.equal(result.structuredContent.code, "session_changed");
  assert.equal(result.structuredContent.delivery, "not_sent");
});
