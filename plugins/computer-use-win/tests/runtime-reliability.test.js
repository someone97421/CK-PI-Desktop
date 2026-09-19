"use strict";
// Isolated VM: every RPC, clipboard and native input transport is mocked.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const runtimePath = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(runtimePath, "utf8");
const button = { element_index: 1, element_token: "token-1", role: "Button", label: "Save", frame: { x: 0, y: 0, w: 100, h: 100 } };
const image = { type: "image", mimeType: "image/png", data: "YWJj" };
const state = (elements = [button], extra = {}, screenshot = false) => ({ content: screenshot ? [image] : [], structuredContent: { snapshot_id: "same-driver-id", elements, ...extra } });
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({ platform = "win32", actionResult, capture, native, clipboardFails = false } = {}) {
  const calls = { cua: [], native: [], starts: 0, banners: 0, clipboard: 0 };
  const sandbox = {
    module: { exports: {} }, Buffer, console, setTimeout, clearTimeout,
    process: { platform, env: {} }, __dirname: path.dirname(runtimePath),
    require(name) {
      if (name === "node:child_process") return {
        spawn() { throw new Error("Live process prohibited"); },
        spawnSync(exe, args) {
          calls.native.push({ exe, args });
          assert.ok(args.some((arg) => arg.endsWith("windows-send-key.ps1")), "No focus or paste fallback helper");
          if (native instanceof Error) throw native;
          if (native) return native;
          const expected = args.includes("-Control") || args.includes("-Shift") ? 4 : 2;
          return { status: 0, stdout: JSON.stringify({ ok: true, code: "transport_sent", sent: expected, expected,
            foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 0 }) };
        },
      };
      if (name === "node:fs") return { ...fs, existsSync: () => true };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      if (name === "electron") return { clipboard: { writeText() { calls.clipboard++; if (clipboardFails) throw new Error("clipboard unavailable"); } } };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: runtimePath });
  const api = sandbox.module.exports;
  const runtime = new api.ComputerUseRuntime();
  runtime.targets.set("notepad", { app: "notepad", pid: 42, window_id: 100 });
  runtime.ensureRunning = async () => { calls.starts++; };
  runtime.beginControl = () => { calls.banners++; };
  runtime.endControl = () => {};
  let captures = 0;
  runtime._cua = async (name, payload, timeout) => {
    calls.cua.push({ name, payload, timeout });
    if (name === "get_window_state") {
      captures++;
      return capture ? capture(captures, payload, runtime) : state([button], {}, payload.include_screenshot);
    }
    if (name === "list_windows") return { structuredContent: { windows: [
      { app_name: "notepad", pid: 42, window_id: 100 }, { app_name: "notepad", pid: 42, window_id: 200 },
    ] } };
    if (name === "clipboard_write") return clipboardFails ? { isError: true } : { structuredContent: { ok: true } };
    if (name === "bring_to_front") return {};
    if (actionResult instanceof Error) throw actionResult;
    return actionResult || { structuredContent: { verified: true, effect: "confirmed" } };
  };
  return { runtime, calls, api,
    call: (name, args = {}, opts = {}) => runtime.callTool(name, { app: "notepad", ...args }, opts),
    snapshot: (args = {}) => runtime.callTool("get_app_state", { app: "notepad", include_screenshot: false, ...args }),
    wait: (predicate, args = {}) => runtime.callTool("get_app_state", { app: "notepad", include_screenshot: false,
      wait_for: predicate, wait_timeout_ms: 220, poll_interval_ms: 100, ...args }),
  };
}

for (const actionResult of [
  { structuredContent: { verified: false, effect: "unverifiable" } },
  { isError: true, structuredContent: { code: "background_unavailable" } },
  { isError: true, content: [{ type: "text", text: "background occluded; foreground recommended" }] },
  new Error("transport timeout"),
]) {
  test("uncertain/error CUA action is delivered at most once", async () => {
    const f = fixture({ actionResult });
    const result = await f.call("click", { x: 10, y: 10 });
    assert.equal(f.calls.cua.filter((c) => c.name === "click").length, 1);
    assert.equal(f.calls.cua.filter((c) => c.name === "bring_to_front").length, 0);
    assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
    assert.equal(result.structuredContent.action_result.retry_safe, false);
    assert.equal(result.structuredContent.verify_needed, true);
  });
}

test("overlay foreground is selected before its only action", async () => {
  const f = fixture({ actionResult: { isError: true }, capture: () => state([{ ...button, label: "删除记录" }]) });
  await f.snapshot();
  await f.call("click", { element_index: 1 });
  assert.deepEqual(f.calls.cua.slice(1).map((c) => c.name), ["bring_to_front", "click"]);
  assert.equal(f.calls.cua.at(-1).payload.delivery_mode, "foreground");
});

test("type_text does not replay after an element-index error", async () => {
  const f = fixture({ capture: () => state([]), actionResult: { isError: true, content: [{ type: "text", text: "WinUI requires element_index ValuePattern" }] } });
  await f.call("type_text", { text: "one insertion" });
  assert.equal(f.calls.cua.filter((c) => c.name === "type_text").length, 1);
  assert.equal(f.calls.cua.filter((c) => c.name === "get_window_state").length, 1);
});

for (const sent of [0, 1, 3, 4]) {
  test(`Windows paste sends ctrl+v once; sent=${sent} classified conservatively`, async () => {
    const f = fixture({ native: { status: sent === 4 ? 0 : 1, stdout: JSON.stringify({ ok: sent === 4,
      code: sent === 4 ? "transport_sent" : "send_input_partial", sent, expected: 4,
      foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 0 }) } });
    const result = await f.call("paste_text", { text: "SECRET CLIPBOARD" });
    assert.equal(f.calls.native.length, 1);
    assert.ok(f.calls.native[0].args.includes("-Control"));
    assert.equal(f.calls.native[0].args[f.calls.native[0].args.indexOf("-Key") + 1], "v");
    assert.deepEqual(f.calls.cua.map((c) => c.name), ["clipboard_write", "bring_to_front"]);
    const a = result.structuredContent.action_result;
    assert.equal(a.delivery, sent === 0 ? "not_sent" : sent < 4 ? "partial" : "sent");
    assert.equal(a.goal, "unconfirmed");
    assert.equal(a.retry_safe, sent === 0);
    assert.doesNotMatch(JSON.stringify(a.evidence), /SECRET/);
  });
}

for (const native of [new Error("helper timeout"), { status: 0, stdout: "malformed" }]) {
  test("unknown native paste result never implies not_sent or retries", async () => {
    const f = fixture({ native });
    const result = await f.call("press_key", { key: "Control_L+v" });
    assert.equal(f.calls.native.length, 1);
    assert.equal(result.structuredContent.action_result.delivery, "unknown");
    assert.equal(result.structuredContent.action_result.retry_safe, false);
    assert.deepEqual(f.calls.cua.map((c) => c.name), ["bring_to_front"]);
  });
}

test("clipboard failure is structured and sends no paste", async () => {
  const f = fixture({ clipboardFails: true });
  const result = await f.call("paste_text", { text: "secret" });
  assert.equal(result.structuredContent.action_result.delivery, "not_sent");
  assert.equal(result.structuredContent.code, "clipboard_write_failed");
  assert.equal(f.calls.native.length, 0);
  assert.doesNotMatch(JSON.stringify(result.structuredContent.action_result.evidence), /secret/);
  assert.equal(f.api.needsPasteFallback(result), false);
});

test("macOS paste uses exactly one command+v on error", async () => {
  const f = fixture({ platform: "darwin", actionResult: new Error("uncertain") });
  await f.call("paste_text", { text: "value" });
  assert.equal(f.calls.native.length, 0);
  assert.deepEqual(f.calls.cua.map((c) => c.name), ["clipboard_write", "hotkey"]);
  assert.deepEqual(Array.from(f.calls.cua.at(-1).payload.keys), ["command", "v"]);
});

for (const isError of [false, true]) for (const observe of [false, true]) {
  test(`public structured fields and diagnostics survive error=${isError}, observe=${observe}`, async () => {
    const f = fixture({ actionResult: { isError, target: { hwnd: 100 }, diagnostic: "transport detail",
      content: [{ type: "text", text: "result" }, image], structuredContent: { verified: true, effect: "confirmed", sent: 4, expected: 4 } } });
    const result = await f.call("click", { x: 1, y: 1 }, { observe });
    const presented = f.api.presentResult(result, { observe });
    assert.deepEqual(plain(presented.structuredContent), plain(result.structuredContent));
    assert.equal(presented.target.hwnd, 100);
    assert.equal(presented.diagnostic, "transport detail");
    assert.equal(presented.ok, !isError);
    assert.equal(presented.structuredContent.action_result.goal, "unconfirmed");
    assert.equal(presented.structuredContent.action_result.ui_change, "unknown");
    if (observe) assert.equal(presented.images.length, 1);
  });
}

test("an action invalidates AX: pixel stays pixel, explicit index fails stale_tree", async () => {
  const f = fixture();
  await f.snapshot();
  await f.call("click", { x: 10, y: 10 });
  assert.equal(f.calls.cua.at(-1).payload.element_token, "token-1");
  await f.call("click", { x: 10, y: 10 });
  assert.equal(f.calls.cua.at(-1).payload.x, 10);
  assert.equal(f.calls.cua.at(-1).payload.element_token, undefined);
  const before = f.calls.cua.length;
  const stale = await f.call("click", { element_index: 1 });
  assert.equal(stale.structuredContent.code, "stale_tree");
  assert.equal(stale.structuredContent.action_result.delivery, "not_sent");
  assert.equal(f.calls.cua.length, before);
});

test("local query only uses a valid tree; refresh replaces tokens and query+screenshot fetches tree", async () => {
  const f = fixture({ capture: (n, p) => state([{ ...button, element_token: `fresh-${n}` }], {}, p.include_screenshot) });
  const first = await f.snapshot();
  const local = await f.snapshot({ query: "save" });
  assert.equal(f.calls.cua.length, 1);
  assert.equal(local.structuredContent.query_local, true);
  assert.equal(local.structuredContent.tree_version, first.structuredContent.tree_version);
  const refreshed = await f.snapshot({ query: "save", refresh: true });
  assert.equal(refreshed.structuredContent.elements[0].element_token, "fresh-2");
  assert.equal(f.runtime.targets.get("notepad").elements[0].element_token, "fresh-2");
  await f.snapshot({ query: "save", include_screenshot: true });
  assert.equal(f.calls.cua.at(-1).payload.include_accessibility_tree, true);
  assert.equal(f.calls.cua.at(-1).payload.query, undefined);
  assert.equal(f.runtime.targets.get("notepad").elements[0].element_token, "fresh-3");
  await f.call("click", { x: 150, y: 150 });
  const fresh = await f.snapshot({ query: "save" });
  assert.notEqual(fresh.structuredContent.query_local, true);
});

test("same snapshot id has independent image/tree versions and honest timestamps", async () => {
  const f = fixture();
  const first = (await f.snapshot({ include_screenshot: true })).structuredContent;
  const second = (await f.snapshot({ include_screenshot: true, include_tree: false })).structuredContent;
  assert.equal(first.snapshot_id, second.snapshot_id);
  assert.equal(second.image_version, first.image_version + 1);
  assert.equal(second.tree_version, first.tree_version);
  assert.equal(second.tree_captured_at, first.tree_captured_at);
  assert.equal(second.tree_actionable, false);
  assert.ok(second.observation_id > first.observation_id);
  assert.equal((await f.call("click", { element_index: 1 })).structuredContent.code, "stale_tree");
  const third = (await f.snapshot({ refresh: true })).structuredContent;
  assert.equal(third.image_version, second.image_version);
  assert.equal(third.image_captured_at, second.image_captured_at);
  assert.equal(third.tree_version, second.tree_version + 1);
  assert.equal(f.runtime.lastFrame.image_version, second.image_version);
});

test("capture failure invalidates old tokens without advancing versions", async () => {
  const f = fixture({ capture: (n) => n === 1 ? state() : { isError: true } });
  await f.snapshot();
  await f.snapshot({ refresh: true });
  assert.equal(f.runtime.targets.get("notepad").tree_actionable, false);
  assert.equal(f.runtime.targets.get("notepad").tree_version, 1);
  assert.equal((await f.call("click", { element_index: 1 })).structuredContent.code, "stale_tree");
});

test("target-window changes cannot reuse AX tokens or old images", async () => {
  const f = fixture();
  await f.snapshot({ include_screenshot: true });
  const result = await f.call("click", { window_id: 200, element_index: 1 });
  assert.equal(result.structuredContent.code, "stale_tree");
  assert.equal(f.calls.cua.filter((c) => c.name === "click").length, 0);
  assert.equal(f.runtime.lastFrame.imageDataUrl, null);
  assert.equal(f.runtime.targets.get("notepad").snapshot_id, null);
});

for (const [predicate, elements] of [
  [{ kind: "text_present", text: "SAV[ED]" }, [{ label: "File sav[ed] successfully" }]],
  [{ kind: "text_absent", text: "loading" }, []],
  [{ kind: "value_equals", name: "AMOUNT", role: "EDIT", value: "" }, [{ name: "Amount", role: "Edit", value: "" }]],
  [{ kind: "value_changed", name: "Amount", baseline: "" }, [{ label: "amount", value: "1" }]],
]) {
  test(`wait ${predicate.kind} confirms only explicit predicate evidence`, async () => {
    const f = fixture({ capture: () => state(elements) });
    const result = await f.wait(predicate);
    assert.equal(result.structuredContent.wait.status, "matched");
    assert.equal(result.structuredContent.wait.attempts, 1);
    assert.equal(result.structuredContent.action_result.goal, "confirmed");
    assert.equal(result.structuredContent.wait.evidence[0].observation_id, result.structuredContent.observation_id);
    assert.equal(f.calls.banners, 0);
    assert.ok(f.calls.cua.every((c) => c.name === "get_window_state" && c.payload.include_screenshot === false && c.payload.include_accessibility_tree === true));
  });
}

test("wait polls full fresh trees, bypasses query cache, and returns matching final screenshot", async () => {
  const f = fixture({ capture: (n, p) => state([{ label: n < 3 ? "loading" : "Done" }], {}, p.include_screenshot) });
  await f.snapshot();
  const result = await f.wait({ kind: "text_present", text: "done" }, { include_screenshot: true, query: "irrelevant", wait_timeout_ms: 500 });
  assert.equal(result.structuredContent.wait.status, "matched");
  assert.equal(result.structuredContent.wait.attempts, 3);
  assert.equal(result.content.filter((c) => c.type === "image").length, 1);
  assert.equal(result.structuredContent.wait.evidence[0].tree_version, result.structuredContent.tree_version);
  assert.deepEqual(f.calls.cua.map((c) => c.payload.include_screenshot), [false, false, false, true]);
  assert.ok(f.calls.cua.every((c) => c.payload.query === undefined));
});

test("final screenshot race cannot confirm a mismatching frame", async () => {
  const f = fixture({ capture: (n, p) => state([{ label: p.include_screenshot ? "loading" : "done" }], {}, p.include_screenshot) });
  const result = await f.wait({ kind: "text_present", text: "done" }, { include_screenshot: true, wait_timeout_ms: 30 });
  assert.equal(result.structuredContent.wait.status, "timeout");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.equal(result.structuredContent.wait.evidence.length, 0);
});

test("wait honors include_tree=false but retains matched evidence", async () => {
  const f = fixture({ capture: (n, p) => state([{ label: "done" }], {}, p.include_screenshot) });
  const result = await f.wait({ kind: "text_present", text: "done" }, { include_tree: false, include_screenshot: true });
  assert.equal(result.structuredContent.elements, undefined);
  assert.equal(result.structuredContent.wait.status, "matched");
  assert.equal(result.structuredContent.wait.evidence[0].matches[0].name, "done");
  assert.equal(result.content.filter((c) => c.type === "image").length, 1);
});

for (const [label, predicate, observation] of [
  ["literal not regex", { kind: "text_present", text: "d.*e" }, state([{ label: "done" }])],
  ["not a substring name", { kind: "value_equals", name: "Amount", value: "1" }, state([{ label: "Amount total", value: "1" }])],
  ["ambiguous", { kind: "value_equals", name: "Amount", value: "1" }, state([{ label: "Amount", value: "1" }, { label: "amount", value: "1" }])],
  ["missing changed", { kind: "value_changed", name: "Amount", baseline: "0" }, state([])],
  ["value missing", { kind: "value_equals", name: "Amount", value: "1" }, state([{ label: "Amount" }])],
  ["degraded absence", { kind: "text_absent", text: "loading" }, state([], { degraded: true })],
  ["truncated value", { kind: "value_changed", name: "Amount", baseline: "0" }, state([{ label: "Amount", value: "1" }], { truncated: true })],
  ["incomplete absence", { kind: "text_absent", text: "loading" }, state([], { tree_complete: false })],
  ["failed capture", { kind: "text_absent", text: "loading" }, { isError: true, structuredContent: { elements: [] } }],
  ["structured failed capture", { kind: "text_absent", text: "loading" }, state([], { ok: false })],
  ["failed positive", { kind: "text_present", text: "done" }, state([{ label: "done" }], { status: "failed" })],
  ["missing tree", { kind: "text_absent", text: "loading" }, { structuredContent: {} }],
  ["unchanged value", { kind: "value_changed", name: "Amount", baseline: "1" }, state([{ name: "Amount", value: "1" }])],
]) {
  test(`wait fails closed: ${label}`, async () => {
    const f = fixture({ capture: () => observation });
    const result = await f.wait(predicate, { wait_timeout_ms: 10 });
    assert.equal(result.structuredContent.wait.status, "timeout");
    assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
    assert.equal(result.structuredContent.wait.evidence.length, 0);
    const expectedReasons = {
      "not a substring name": "target_missing", ambiguous: "ambiguous_target",
      "missing changed": "target_missing", "value missing": "value_missing",
      "truncated value": "incomplete_tree",
    };
    if (expectedReasons[label]) assert.equal(result.structuredContent.wait.reason, expectedReasons[label]);
  });
}

test("wait screenshot error never brings window front or focuses it", async () => {
  const f = fixture({ capture: () => state([{ label: "done" }], { screenshot_error: "occluded" }) });
  const result = await f.wait({ kind: "text_present", text: "done" }, { include_screenshot: true });
  assert.equal(result.structuredContent.wait.status, "matched");
  assert.ok(f.calls.cua.every((c) => c.name === "get_window_state"));
  assert.equal(f.calls.native.length, 0);
});

test("a stalled RPC is bounded and a late completion cannot refresh cached AX", async () => {
  let finish;
  const f = fixture({ capture: () => new Promise((resolve) => { finish = resolve; }) });
  const start = Date.now();
  const result = await f.wait({ kind: "text_present", text: "done" }, { wait_timeout_ms: 25 });
  assert.ok(Date.now() - start < 1000);
  assert.equal(result.structuredContent.wait.status, "timeout");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.ok(f.calls.cua[0].timeout <= 25);
  finish(state([{ label: "done" }]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.notEqual(f.runtime.targets.get("notepad").tree_actionable, true);
  assert.equal(f.runtime.targets.get("notepad").tree_version, undefined);
});

test("stalled target lookup is bounded without a capture or GUI recovery", async () => {
  const f = fixture();
  f.runtime._resolveTarget = () => new Promise(() => {});
  const result = await f.wait({ kind: "text_absent", text: "loading" }, { wait_timeout_ms: 10 });
  assert.equal(result.structuredContent.wait.status, "timeout");
  assert.equal(f.calls.cua.length, 0);
});

test("cancel during stalled RPC stops wait without restarting or GUI actions", async () => {
  const f = fixture({ capture: () => new Promise(() => {}) });
  setTimeout(() => { f.runtime.stoppedByUser = true; }, 10);
  const result = await f.wait({ kind: "text_present", text: "done" }, { wait_timeout_ms: 2000 });
  assert.equal(result.structuredContent.wait.status, "cancelled");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.equal(f.calls.starts, 1);
  assert.equal(f.calls.cua.length, 1);
  assert.equal(f.calls.banners, 0);
  assert.equal(f.calls.native.length, 0);
});

test("already stopped wait neither starts driver nor captures", async () => {
  const f = fixture();
  f.runtime.stoppedByUser = true;
  const result = await f.wait({ kind: "text_present", text: "done" });
  assert.equal(result.structuredContent.wait.status, "cancelled");
  assert.equal(f.calls.starts, 0);
  assert.equal(f.calls.cua.length, 0);
});

for (const args of [
  { refresh: "true" }, { wait_for: null }, { wait_for: {} }, { wait_for: { kind: "regex", text: "x" } },
  { wait_for: { kind: "text_present", text: " " } }, { wait_for: { kind: "text_absent" } },
  { wait_for: { kind: "value_equals", name: "Amount" } }, { wait_for: { kind: "value_changed", name: "Amount" } },
  { wait_for: { kind: "value_equals", name: "", value: "" } },
  { wait_for: { kind: "value_equals", name: "Amount", value: 1 } },
  { wait_for: { kind: "text_present", text: "x", regex: true } },
  { wait_timeout_ms: -1 }, { wait_timeout_ms: 30001 }, { wait_timeout_ms: "10" }, { wait_timeout_ms: NaN },
  { poll_interval_ms: 99 }, { poll_interval_ms: 5001 }, { poll_interval_ms: null, refresh: 1 },
  { refresh: null }, { wait_timeout_ms: null }, { poll_interval_ms: null },
]) {
  test(`invalid state arguments fail before driver startup: ${JSON.stringify(args)}`, async () => {
    const f = fixture();
    const result = await f.snapshot(args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "validation_error");
    assert.equal(f.calls.starts, 0);
    assert.equal(f.calls.cua.length, 0);
  });
}

test("zero wait timeout is valid and bounded", async () => {
  const f = fixture({ capture: () => new Promise(() => {}) });
  const result = await f.wait({ kind: "text_present", text: "done" }, { wait_timeout_ms: 0 });
  assert.equal(result.structuredContent.wait.status, "timeout");
  assert.notEqual(result.structuredContent.code, "validation_error");
});

test("transient read errors may be polled again, never interpreted as absence", async () => {
  const f = fixture({ capture: (n) => { if (n === 1) throw new Error("read failed"); return state([{ label: "done" }]); } });
  const result = await f.wait({ kind: "text_present", text: "done" }, { wait_timeout_ms: 500 });
  assert.equal(result.structuredContent.wait.status, "matched");
  assert.equal(result.structuredContent.wait.attempts, 2);
  assert.ok(f.calls.cua.every((c) => c.name === "get_window_state"));
});

test("action-attached captures also advance image versions without making AX reusable", async () => {
  const f = fixture({ actionResult: state([button], {}, true) });
  const first = await f.snapshot({ include_screenshot: true });
  const action = await f.call("click", { x: 200, y: 200 });
  assert.equal(action.structuredContent.image_version, first.structuredContent.image_version + 1);
  assert.equal(action.structuredContent.tree_version, first.structuredContent.tree_version + 1);
  assert.equal(action.structuredContent.tree_actionable, false);
  assert.equal(f.runtime.lastFrame.image_version, action.structuredContent.image_version);
  assert.equal(f.runtime.lastFrame.imageDataUrl, "data:image/png;base64,YWJj");
});

test("explicit indices missing from a fresh tree fail closed at the public boundary", async () => {
  const f = fixture({ capture: () => state([]) });
  await f.snapshot();
  const result = await f.call("click", { element_index: 1 });
  assert.equal(result.structuredContent.code, "stale_tree");
  assert.equal(f.calls.cua.length, 1);
});

test("structured failed capture does not advance tree version", async () => {
  const f = fixture({ capture: (n) => n === 1 ? state() : state([], { ok: false }) });
  await f.snapshot();
  const result = await f.snapshot({ refresh: true });
  assert.equal(result.isError, true);
  assert.equal(f.runtime.targets.get("notepad").tree_version, 1);
  assert.equal(f.runtime.targets.get("notepad").tree_actionable, false);
});

test("only the exact paste chord is routed to paste_text", () => {
  const { api } = fixture();
  assert.equal(api.isPasteChord("Ctrl+v"), true);
  assert.equal(api.isPasteChord("Ctrl+Shift+v"), false);
  assert.equal(api.isPasteChord("Win+v"), false);
});

test("wait deadline includes stalled driver startup", async () => {
  const f = fixture();
  f.runtime.ensureRunning = () => new Promise(() => {});
  const start = Date.now();
  const result = await f.wait({ kind: "text_present", text: "done" }, { wait_timeout_ms: 20 });
  assert.ok(Date.now() - start < 1000);
  assert.equal(result.structuredContent.wait.status, "timeout");
  assert.equal(result.structuredContent.wait.attempts, 0);
  assert.equal(f.calls.cua.length, 0);
});

test("cancellation during driver startup is a structured cancelled wait", async () => {
  const f = fixture();
  f.runtime.ensureRunning = () => new Promise(() => {});
  setTimeout(() => { f.runtime.stoppedByUser = true; }, 5);
  const result = await f.wait({ kind: "text_present", text: "done" });
  assert.equal(result.structuredContent.wait.status, "cancelled");
  assert.equal(f.calls.cua.length, 0);
});
