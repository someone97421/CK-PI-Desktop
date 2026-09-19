"use strict";
// Runtime boundary tests; no driver, native process, or desktop input.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ComputerUseRuntime, presentResult } = require("../runtime");

function fixture(actionResult, observation) {
  const runtime = Object.create(ComputerUseRuntime.prototype);
  Object.assign(runtime, { targets: new Map(), queue: Promise.resolve(), settings: {}, stoppedByUser: false });
  const calls = [];
  runtime.ensureRunning = async () => {};
  runtime.beginControl = () => {};
  runtime.endControl = () => {};
  runtime._rememberFrame = () => {};
  runtime._dispatch = async () => { calls.push("action"); return actionResult; };
  runtime._getAppState = async (args) => {
    calls.push("observation");
    assert.equal(args.app, "Notepad");
    assert.equal(args.window_id, 100);
    assert.equal(args.refresh, true);
    return observation;
  };
  return { runtime, calls };
}
const picture = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==" };
const action = { content: [{ type: "text", text: "Input accepted; effect unknown" }],
  structuredContent: { sent: 4, expected: 4, transport_sent: true, code: "transport_sent" } };
const observation = { content: [{ type: "text", text: "current state" }, picture],
  structuredContent: { observation_id: 5, tree_version: 4, image_version: 3, elements: [] } };

test("observe=true captures once after action and retains its transport evidence", async () => {
  const f = fixture(action, observation);
  const result = await f.runtime.callTool("paste_text", { app: "Notepad", window_id: 100, text: "test" }, { observe: true });
  assert.deepEqual(f.calls, ["action", "observation"]);
  assert.equal(result.structuredContent.action_result.delivery, "sent");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.ok(result.content.some(item => item.type === "image"));
});

test("post-action observation cannot erase partial-delivery error", async () => {
  const f = fixture({ ...action, isError: true, structuredContent: { sent: 2, expected: 4, code: "send_input_partial" } }, observation);
  const result = await f.runtime.callTool("paste_text", { app: "Notepad", window_id: 100, text: "test" }, { observe: true });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action_result.delivery, "partial");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.equal(result.structuredContent.code, "send_input_partial");
  assert.equal(f.calls.filter(x => x === "action").length, 1);
});

test("observe=false does not add an implicit snapshot", async () => {
  const f = fixture(action, observation);
  await f.runtime.callTool("paste_text", { app: "Notepad", window_id: 100, text: "test" }, { observe: false });
  assert.deepEqual(f.calls, ["action"]);
});

test("public diagnostics do not duplicate screenshot base64 into structured text", () => {
  const result = presentResult({ content: [{ type: "text", text: "state" }], structuredContent: {
    screenshot_png_b64: picture.data, screenshot_png_base64: picture.data, screenshot_base64: picture.data,
    screenshot: picture.data, observation_id: 5, action_result: { goal: "unconfirmed" },
  } }, { observe: false });
  for (const key of ["screenshot_png_b64", "screenshot_png_base64", "screenshot_base64", "screenshot"]) {
    assert.equal(result.structuredContent[key], undefined);
  }
  assert.equal(result.structuredContent.observation_id, 5);
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
});

test("late window resolution after wait timeout cannot overwrite a newer target", async () => {
  const runtime = Object.create(ComputerUseRuntime.prototype);
  Object.assign(runtime, { targets: new Map(), settings: {}, stoppedByUser: false });
  let release;
  runtime._listWindowsRaw = () => new Promise(resolve => { release = resolve; });
  runtime._cua = async () => { throw new Error("expired wait must not request state"); };
  const result = await runtime._getAppState({ app: "Notepad", window_id: 100, include_screenshot: false,
    wait_for: { kind: "text_present", text: "Ready" }, wait_timeout_ms: 25 });
  assert.equal(result.structuredContent.wait.status, "timeout");
  runtime._rememberTarget("Notepad", { app: "Notepad", pid: 43, window_id: 200 });
  release([{ app_name: "Notepad", pid: 42, window_id: 100 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.targets.get("notepad").window_id, 200);
});

test("teardown discards session-bound target and menu state", () => {
  const runtime = Object.create(ComputerUseRuntime.prototype);
  Object.assign(runtime, { targets: new Map([["notepad", { tree_actionable: true, snapshot_id: "old" }]]),
    _nativeMenuContext: { pid: 42, window_id: 100 }, child: null });
  runtime._killChild();
  assert.equal(runtime.targets.size, 0);
  assert.equal(runtime._nativeMenuContext, null);
});

test("post-action capture failure preserves delivery and reports a separate observation error", async () => {
  const f = fixture(action, observation);
  f.runtime._getAppState = async () => { throw new Error("capture unavailable"); };
  const result = await f.runtime.callTool("paste_text", { app: "Notepad", window_id: 100, text: "test" }, { observe: true });
  assert.equal(result.structuredContent.action_result.delivery, "sent");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.equal(result.structuredContent.observation_error, "capture_failed");
  assert.deepEqual(f.calls, ["action"]);
});
