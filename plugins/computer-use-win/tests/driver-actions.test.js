"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const filename = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(filename, "utf8");
const baseRequire = createRequire(filename);
const target = { app: "Fixture", window_id: 101 };
const bounds = { x: 100, y: 40, width: 2560, height: 1000 };
const win = { pid: 42, window_id: 101, app_name: target.app, is_on_screen: true, bounds };
const snapshot = "s00000001";
const row = { role: "Button", label: "Save", enabled: true, element_index: 1,
  element_token: `${snapshot}:1`, frame: { x: 300, y: 240, w: 80, h: 60 },
  screenshot_frame: { x: 100, y: 100, w: 40, h: 30 } };
const edit = { ...row, role: "Edit", label: "Editor", element_index: 2, element_token: `${snapshot}:2`, value: "before" };
const capture = "capture_01234_0000000000000001";

function fakeImage() {
  const hdr = Buffer.alloc(24);
  hdr[0] = 0x89; hdr[1] = 0x50;
  hdr.writeUInt32BE(1280, 16); hdr.writeUInt32BE(500, 20);
  return { type: "image", data: hdr.toString("base64"), mimeType: "image/png" };
}

function fixture(version = "0.53.0") {
  const calls = [];
  const native = [];
  const opts = { win, state: {}, result: {} };
  const context = { Buffer, Date, console, clearTimeout, setTimeout, module: { exports: {} },
    __dirname: path.dirname(filename), process: { platform: "win32", env: {} },
    require(name) {
      if (name === "node:child_process") return { spawnSync(exe, args) {
        const script = args[args.indexOf("-File") + 1];
        native.push(script);
        if (script.endsWith("windows-send-key.ps1")) return { status: 0, stdout: JSON.stringify({ ok: true,
          code: "sent", expected: 4, sent: 4, foreground_hwnd: 101, focus_hwnd: 101, target_hwnd: 101, target_pid: 42, last_error: 0 }) };
        throw new Error("Unexpected native call in mocked action test");
      } };
      if (name === "./cua") return { probe() { throw new Error("Fixture driver unavailable"); } };
      return baseRequire(name);
    } };
  vm.runInNewContext(source, context, { filename });
  const runtime = new context.module.exports.ComputerUseRuntime();
  runtime.info.version = version;
  runtime.ensureRunning = async () => {};
  runtime.beginControl = runtime.endControl = () => {};
  runtime._rpcUnlocked = async (method, params) => {
    assert.equal(method, "tools/call");
    const { name, arguments: args } = JSON.parse(JSON.stringify(params));
    calls.push({ name, args });
    if (opts.result[name]) return opts.result[name];
    if (name === "list_windows") return { structuredContent: { windows: [opts.win] } };
    if (name === "get_window_state") return {
      structuredContent: { pid: 42, window_id: 101, snapshot_id: snapshot, window_bounds: bounds,
        ...(args.include_accessibility_tree ? { elements: [row, edit], elements_complete: true } : {}),
        ...(args.include_screenshot ? { capture_id: capture, screenshot_width: 1280, screenshot_height: 500 } : {}),
        ...opts.state },
      content: args.include_screenshot ? [fakeImage()] : [],
    };
    return { content: [], structuredContent: { effect: "unverifiable" } };
  };
  return {
    runtime, opts, calls, native,
    call: (name, args = {}) => runtime.callTool(name, { ...target, ...args }),
    capture: (args = {}) => runtime.callTool("get_app_state", { ...target, ...args }),
  };
}

test("0.53.0 requests structured state and serializes only validated tokens for element actions", async () => {
  const f = fixture();
  const cases = [
    ["click", { element_index: 1 }, "click", row],
    ["scroll", { element_index: 1, direction: "down", pages: 2 }, "scroll", row],
    ["set_value", { element_index: 2, value: "new" }, "set_value", edit],
    ["type_text", { element_index: 2, text: "literal" }, "type_text", edit],
    ["type_text", { text: "automatic picker" }, "type_text", edit],
    ["press_key", { element_index: 2, key: "a" }, "press_key", edit],
    ["press_key", { element_index: 2, key: "ctrl+a" }, "hotkey", edit],
  ];
  for (const [name, args, wireName, element] of cases) {
    const state = await f.capture({ include_screenshot: false });
    assert.equal(state.structuredContent.tree_actionable, true);
    assert.equal(f.calls.at(-1).args.tree_format, "elements");
    await f.call(name, args);
    const wire = f.calls.at(-1);
    assert.equal(wire.name, wireName);
    assert.equal(wire.args.pid, win.pid);
    assert.equal(wire.args.window_id, win.window_id);
    assert.equal(wire.args.element_token, element.element_token);
    assert.equal(Object.hasOwn(wire.args, "element_index"), false);
    assert.equal(Object.hasOwn(wire.args, "snapshot_id"), false);
  }
  assert.equal(f.native.length, 2);
  assert.ok(f.native.every(script => script.endsWith("windows-focus-state.ps1")));
});

test("0.28.2 preserves its state arguments, indexed action fields and unbound coordinates", async () => {
  const f = fixture("0.28.2");
  await f.capture({ include_screenshot: false });
  assert.equal(f.calls.at(-1).args.tree_format, undefined);
  await f.call("click", { element_index: 1 });
  assert.deepEqual(f.calls.at(-1).args, { pid: 42, window_id: 101, element_index: 1,
    element_token: row.element_token, snapshot_id: snapshot, delivery_mode: "background" });
  await f.call("click", { x: 10, y: 20 });
  assert.deepEqual(f.calls.at(-1).args, { pid: 42, window_id: 101, x: 10, y: 20, delivery_mode: "background" });
});

test("0.53.0 uses the screenshot frame for hit-testing and a capture ID for actual pixel gestures", async () => {
  const f = fixture();
  await f.capture();
  await f.call("click", { x: 105, y: 105 });
  assert.deepEqual(f.calls.at(-1).args, { pid: 42, window_id: 101, element_token: row.element_token, delivery_mode: "background" });
  for (const extra of [{ mouse_button: "right" }, { mouse_button: "middle" }, { click_count: 2 }]) {
    await f.capture();
    const from = f.calls.length;
    await f.call("click", { x: 105, y: 105, ...extra });
    assert.equal(f.calls.length - from, 1);
    assert.equal(f.calls.at(-1).name, "click");
    assert.equal(f.calls.at(-1).args.capture_id, capture);
    assert.equal(f.calls.at(-1).args.element_token, undefined);
    assert.equal(f.calls.at(-1).args.x, 105);
    assert.equal(f.calls.at(-1).args.y, 105);
  }
});

test("0.53.0 rejects stale, out-of-bounds, foreign and malformed screenshot coordinates before input", async () => {
  const f = fixture();
  const refusal = async (name, args, code) => {
    const r = await f.call(name, args);
    assert.equal(r.structuredContent.code, code);
    assert.equal(r.structuredContent.action_result.delivery, "not_sent");
    assert.ok(!f.calls.some(call => ["click", "drag", "bring_to_front"].includes(call.name)));
  };
  await refusal("click", { x: 110, y: 110 }, "screenshot_required");
  await f.capture();
  await refusal("click", { x: 1280, y: 0, mouse_button: "right" }, "coordinate_out_of_bounds");
  await f.capture();
  await refusal("drag", { from_x: 20, from_y: 20, to_x: 100, to_y: -1 }, "coordinate_out_of_bounds");
  await f.capture({ include_screenshot: false });
  await refusal("click", { x: 110, y: 110 }, "screenshot_required");
  f.opts.state.screenshot_width = 1279;
  await f.capture();
  await refusal("click", { x: 110, y: 110 }, "screenshot_required");
  f.opts.state.window_id = 102;
  const foreign = await f.capture();
  assert.equal(foreign.structuredContent.code, "foreign_target");
  assert.ok(!foreign.content.some(item => item.type === "image"));
  await refusal("click", { x: 110, y: 110 }, "screenshot_required");
});

test("0.53.0 drag checks live geometry and leaves screenshot scaling to the backend", async () => {
  const f = fixture();
  await f.capture();
  const points = { from_x: 10, from_y: 20, to_x: 30, to_y: 40 };
  await f.call("drag", points);
  assert.deepEqual(f.calls.slice(-2), [
    { name: "list_windows", args: { pid: win.pid } },
    { name: "drag", args: { pid: 42, window_id: 101, ...points, delivery_mode: "background" } },
  ]);
  await f.capture();
  f.opts.win = { ...win, bounds: { ...bounds, x: bounds.x + 10 } };
  const blocked = await f.call("drag", points);
  assert.equal(blocked.structuredContent.code, "screenshot_stale");
  assert.equal(f.calls.filter(call => call.name === "drag").length, 1);
});

test("0.53.0 does not dispatch missing/stale tokens or replay a refused frame", async () => {
  const f = fixture();
  f.opts.state.elements = [{ ...row, element_token: undefined }];
  await f.capture({ include_screenshot: false });
  assert.equal((await f.call("click", { element_index: 1 })).structuredContent.code, "stale_tree");
  assert.equal(f.calls.filter(call => call.name === "click").length, 0);
  delete f.opts.state.elements;
  await f.capture();
  f.opts.result.click = { isError: true, structuredContent: { refusal: { code: "session_ended" } } };
  const refused = await f.call("click", { x: 50, y: 50 });
  assert.equal(refused.structuredContent.action_result.delivery, "not_sent");
  assert.deepEqual(f.calls.slice(-2).map(call => call.name), ["click", "start_session"]);
  await f.capture({ include_screenshot: false });
  f.opts.result.start_session = { isError: true };
  await f.call("click", { element_index: 1 });
  assert.deepEqual(f.calls.slice(-2).map(call => call.name), ["click", "start_session"]);
  assert.equal(f.calls.filter(call => call.name === "click").length, 2);
});

test("paste writes the clipboard once and uses the existing guarded native route", async () => {
  const f = fixture();
  const result = await f.call("paste_text", { text: "fixture text" });
  assert.equal(result.structuredContent.action_result.delivery, "sent");
  assert.deepEqual(f.calls.map(call => call.name), ["list_windows", "clipboard_write"]);
  assert.equal(f.calls.at(-1).args.text, "fixture text");
  assert.equal(f.native.length, 1);
});

test("configuration follows the negotiated driver version and failed probing exits starting", async () => {
  for (const [version, args] of [["0.53.0", { max_image_dimension: 1280 }],
    ["0.28.2", { key: "max_image_dimension", value: 1280 }]]) {
    const f = fixture(version);
    await f.runtime._cua("set_config", { key: "max_image_dimension", value: 1280 });
    assert.deepEqual(f.calls.at(-1).args, args);
    await assert.rejects(f.runtime.start(), /Fixture driver unavailable/);
    assert.equal(f.runtime.status, "error");
    assert.match(f.runtime.lastError, /Fixture driver unavailable/);
  }
});
