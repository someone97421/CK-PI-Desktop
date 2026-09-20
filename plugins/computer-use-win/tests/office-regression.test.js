"use strict";
// Every capture, action, clipboard and native helper is mocked; no desktop input.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const runtimePath = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(runtimePath, "utf8");
const image = { type: "image", mimeType: "image/png", data: "YWJj" };
const filename = { element_index: 7, element_token: "s000001:7", role: "Edit", label: "文件名",
  enabled: true, frame: { x: 1080, y: 765, w: 343, h: 24 }, actions: ["set_value", "text"] };
const state = (elements = [filename], extra = {}) => ({ structuredContent: {
  pid: 42, window_id: 100, snapshot_id: "s000001", elements_complete: false, elements, ...extra,
} });
const timeoutResult = () => ({ isError: true, content: [{ type: "text", text: "UIA capture timed out: provider unresponsive" }],
  structuredContent: { code: "uia_timeout" } });
function fixture({ app = "WINWORD", capture = () => state(), actionResult, onCua, listWindows, clock } = {}) {
  const calls = { cua: [], native: [] };
  const SandboxDate = clock ? class extends Date { static now() { return clock.now; } } : Date;
  const sandbox = { module: { exports: {} }, Buffer, console, Date: SandboxDate, setTimeout, clearTimeout,
    __dirname: path.dirname(runtimePath), process: { platform: "win32", env: {} },
    require(name) {
      if (name === "./powershell") return { resolvePowerShell: () => "powershell.exe" };
      if (name === "node:child_process") return {
        spawn() { throw new Error("Live process prohibited"); },
        spawnSync(exe, args) {
          assert.ok(args.some(arg => arg.endsWith("windows-send-key.ps1")), "No focus search helper");
          calls.native.push(args);
          const expected = 2 * (1 + ["-Control", "-Shift", "-Alt"].filter(flag => args.includes(flag)).length);
          return { status: 0, stdout: JSON.stringify({ ok: true, code: "transport_sent", sent: expected, expected,
            target_hwnd: 100, target_pid: 42, foreground_hwnd: 101, focus_hwnd: 102, last_error: 0 }) };
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
  runtime.targets.set(app.toLowerCase(), { app, app_name: app, pid: 42, window_id: 100 });
  runtime.ensureRunning = async () => {};
  runtime.beginControl = runtime.endControl = runtime._rememberFrame = () => {};
  let captures = 0;
  runtime._cua = async (name, payload, timeout) => {
    calls.cua.push({ name, payload, timeout });
    if (onCua) onCua(name, runtime);
    if (name === "get_window_state") return capture(++captures, payload, runtime);
    if (name === "list_windows" && listWindows) return listWindows(payload, timeout, runtime);
    return actionResult || { structuredContent: { transport_sent: true, sent: 4, expected: 4, code: "transport_sent" } };
  };
  return { runtime, calls, cached: () => runtime.targets.get(app.toLowerCase()),
    snapshot: (args = {}) => runtime.callTool("get_app_state", { app, include_screenshot: false, ...args }),
    call: (name, args = {}, options = {}) => runtime.callTool(name, { app, ...args }, options),
  };
}

for (const [app, name, element, args] of [
  ["WINWORD", "set_value", filename, { value: "Report.docx" }],
  ["WINWORD", "click", { ...filename, role: "Button", label: "更多选项", actions: ["Invoke"] }, {}],
  ["POWERPNT", "click", { ...filename, role: "MenuItem", label: "复制", actions: ["Invoke"] }, {}],
]) {
  test(`${app} partial snapshot: explicit ${name} ${element.label} delivered once, then invalidated`, async () => {
    const f = fixture({ app, capture: () => state([element], { truncated: true }) });
    const observed = await f.snapshot();
    assert.equal(observed.structuredContent.tree_actionable, false);
    assert.equal(observed.structuredContent.snapshot_actionable, true);
    const result = await f.call(name, { element_index: 7, ...args });
    const deliveries = f.calls.cua.filter(call => call.name === name);
    assert.equal(result.structuredContent.action_result.delivery, "sent");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.snapshot_id, "s000001");
    assert.equal(deliveries[0].payload.element_token, "s000001:7");
    assert.equal(f.cached().snapshot_actionable, false);
    assert.equal((await f.call(name, { element_index: 7, ...args })).structuredContent.code, "stale_tree");
    assert.equal(f.calls.cua.filter(call => call.name === name).length, 1);
  });
}

for (const extra of [
  { pid: 99 }, { window_id: 999 }, { capture: { target_pid: 99 } }, { _capture_target_match: false },
  { cached: true }, { from_cache: true }, { fresh: false }, { tree_stale: true },
  { query: "filename" }, { query_local: true }, { tree_error: "provider unavailable" },
  { snapshot_id: null }, { degraded: true },
]) {
  test(`untrusted partial capture refuses explicit action: ${JSON.stringify(extra)}`, async () => {
    const f = fixture({ capture: () => state([filename], extra) });
    await f.snapshot();
    const result = await f.call("set_value", { element_index: 7, value: "test" });
    assert.equal(result.structuredContent.action_result.delivery, "not_sent");
    assert.equal(f.calls.cua.filter(call => call.name === "set_value").length, 0);
  });
}

for (const complete of [false, true]) for (const patch of [
  { enabled: false }, { disabled: true }, { visible: false }, { offscreen: true },
  { password: true }, { is_password: true },
  { is_offscreen: true }, { is_visible: false }, { enabled: undefined },
  { element_token: "s000000:7" },
  { element_token: "s000001:8" }, { element_token: "" }, { element_index: 8 },
]) {
  test(`complete=${complete} rejects unavailable/mismatching element ${JSON.stringify(patch)}`, async () => {
    const f = fixture({ capture: () => state([{ ...filename, ...patch }], { elements_complete: complete }) });
    await f.snapshot();
    assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
    assert.equal((await f.call("click", { element_index: 7 })).structuredContent.action_result.delivery, "not_sent");
    assert.equal(f.calls.cua.filter(call => call.name === "click").length, 0);
  });
}
for (const index of [-1, 1.5, NaN, Infinity, true, "1e0", " 7 ", "missing", 99]) {
  test(`invalid/missing index ${String(index)} never reaches driver`, async () => {
    const f = fixture();
    await f.snapshot();
    assert.throws(() => f.runtime._elementFields("WINWORD", index), { code: "stale_tree" });
  });
}
test("duplicate indices are ambiguous, and legacy tokenless controls require a complete tree", async () => {
  const duplicate = fixture({ capture: () => state([filename, filename]) });
  await duplicate.snapshot();
  assert.throws(() => duplicate.runtime._elementFields("WINWORD", 7), /ambiguous/);
  for (const complete of [false, true]) {
    const f = fixture({ capture: () => state([{ ...filename, element_token: undefined }], { elements_complete: complete }) });
    await f.snapshot();
    const result = await f.call("set_value", { element_index: 7, value: "test" });
    assert.equal(result.structuredContent.action_result.delivery, complete ? "sent" : "not_sent");
  }
});
test("filtered local and refreshed observations authorize only returned original indices", async () => {
  for (const refresh of [false, true]) {
    const other = { ...filename, element_index: 22, element_token: "s000001:22", label: "Other" };
    const f = fixture({ capture: () => state([filename, other], { elements_complete: true }) });
    await f.snapshot();
    const query = await f.snapshot({ query: "文件名", refresh });
    assert.equal(query.structuredContent.snapshot_actionable, true);
    assert.equal(query.structuredContent.tree_actionable, false);
    assert.deepEqual(Array.from(query.structuredContent.elements, el => el.element_index), [7]);
    assert.throws(() => f.runtime._elementFields("WINWORD", 22), { code: "stale_tree" });
    assert.equal(f.runtime._elementFields("WINWORD", 7).element_token, "s000001:7");
    assert.equal((await f.call("set_value", { element_index: 7, value: "report.docx" })).structuredContent.action_result.delivery, "sent");
    assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
  }
});

for (const complete of [false, true]) {
  test(`Office type_text keeps current focus across repeated typing, complete=${complete}`, async () => {
    const f = fixture({ capture: () => state([{ ...filename, label: "Microsoft Search" }], { elements_complete: complete }) });
    await f.snapshot();
    await f.call("type_text", { text: "document text" });
    await f.call("type_text", { text: " more text" });
    assert.equal(f.calls.cua.filter(call => call.name === "get_window_state").length, 1);
    const actions = f.calls.cua.filter(call => call.name === "type_text");
    assert.equal(actions.length, 2);
    assert.ok(actions.every(call => call.payload.element_index === undefined));
    assert.equal(f.calls.native.length, 0);
  });
}
test("partial snapshots cannot automatically pick Edit or upgrade pixel clicks", async () => {
  const f = fixture({ app: "notepad", capture: () => state([{ ...filename, frame: { x: 0, y: 0, w: 100, h: 100 } }]) });
  await f.snapshot();
  await f.call("type_text", { text: "focused text" });
  assert.equal(f.calls.cua.find(call => call.name === "type_text").payload.element_index, undefined);
  await f.snapshot();
  await f.call("click", { x: 10, y: 10 });
  assert.equal(f.calls.cua.find(call => call.name === "click").payload.element_index, undefined);
});
test("partial exact snapshots do not prove cancellation absence", async () => {
  const f = fixture();
  const blocked = await f.call("press_key", { key: "Escape" });
  assert.equal(blocked.structuredContent.code, "escape_cancellation_state_uncertain");
  assert.equal(f.calls.native.length, 0);
  const popup = fixture({ capture: n => state(n === 1 ? [{ ...filename, role: "MenuItem", label: "复制" }] : []) });
  const result = await popup.call("press_key", { key: "Escape" });
  assert.equal(popup.calls.native.length, 1);
  assert.equal(result.structuredContent.cancellation.status, "unverified");
  assert.equal(result.structuredContent.cancellation.reason, "partial_tree_marker_absence_unverified");
  assert.equal(popup.cached().snapshot_actionable, false);
});

for (const failure of [timeoutResult, () => { throw new Error("UIA provider timed out"); },
  () => state([], { tree_error: "provider unresponsive" })]) {
  test("UIA timeout falls back once to read-only screenshot, with original tree error", async () => {
    const f = fixture({ capture: n => n === 1 ? failure() : { content: [image], structuredContent: { pid: 42, window_id: 100 } } });
    const result = await f.snapshot({ include_screenshot: true });
    assert.equal(f.calls.cua.length, 2);
    assert.ok(f.calls.cua.every(call => call.name === "get_window_state"));
    assert.deepEqual(f.calls.cua.map(call => call.payload.include_accessibility_tree), [true, false]);
    assert.equal(result.structuredContent.tree_unavailable, true);
    assert.equal(result.structuredContent.tree_actionable, false);
    assert.equal(result.structuredContent.snapshot_actionable, false);
    assert.match(JSON.stringify(result.structuredContent.tree_error), /timed out|unresponsive/);
    assert.ok(result.content.some(item => item.type === "image"));
    assert.match(result.content[0].text, /tree unavailable/);
  });
}
test("tree-only timeout and unrelated capture errors never request a hidden screenshot", async () => {
  const f = fixture({ capture: timeoutResult });
  assert.equal((await f.snapshot()).isError, true);
  assert.equal(f.calls.cua.length, 1);
  assert.equal(f.calls.cua[0].payload.include_screenshot, false);
  const denied = fixture({ capture: () => ({ isError: true, content: [{ type: "text", text: "access denied" }] }) });
  assert.equal((await denied.snapshot({ include_screenshot: true })).isError, true);
  assert.equal(denied.calls.cua.length, 1);
});
for (const partial of [false, true]) {
  test(`post-action timeout preserves delivery partial=${partial}, no replay`, async () => {
    const f = fixture({ actionResult: { ...(partial ? { isError: true } : {}), structuredContent: {
      sent: partial ? 2 : 4, expected: 4, code: partial ? "send_input_partial" : "transport_sent",
    } }, capture: n => n === 1 ? timeoutResult() : { content: [image], structuredContent: {} } });
    const result = await f.call("click", { x: 30, y: 40 }, { observe: true });
    assert.equal(result.structuredContent.action_result.delivery, partial ? "partial" : "sent");
    assert.equal(result.structuredContent.code, partial ? "send_input_partial" : "transport_sent");
    assert.equal(result.structuredContent.observation_error, "post_action_capture_failed");
    assert.equal(result.structuredContent.observation.tree_unavailable, true);
    assert.equal(f.calls.cua.filter(call => call.name === "click").length, 1);
    assert.equal(f.calls.cua.filter(call => call.name === "get_window_state").length, 2);
    assert.ok(result.content.some(item => item.type === "image"));
  });
}
for (const phase of [1, 2]) for (const change of ["stop", "epoch", "cancel"]) {
  test(`timeout fallback phase ${phase} honours ${change}`, async () => {
    const context = { active: true, deadline: Date.now() + 1000 };
    const f = fixture({ capture: (n, payload, runtime) => {
      if (n === phase) {
        if (change === "stop") runtime.stoppedByUser = true;
        if (change === "epoch") runtime._sessionEpoch = 1;
        if (change === "cancel") context.active = false;
      }
      return n === 1 ? timeoutResult() : { content: [image], structuredContent: {} };
    } });
    await assert.rejects(f.runtime._getAppState({ app: "WINWORD", include_screenshot: true, _waitContext: context }));
    assert.equal(f.calls.cua.length, phase);
    assert.notEqual(f.cached().snapshot_actionable, true);
    assert.equal(f.cached().image_version, undefined);
  });
}
test("stalled screenshot fallback obeys deadline and late response cannot cache", async () => {
  let release;
  const f = fixture({ capture: n => n === 1 ? timeoutResult() : new Promise(resolve => { release = resolve; }) });
  await assert.rejects(f.runtime._getAppState({ app: "WINWORD", include_screenshot: true,
    _waitContext: { active: true, deadline: Date.now() + 40 } }), { code: "wait_timeout" });
  assert.equal(f.calls.cua.length, 2);
  release({ content: [image], structuredContent: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cached().image_version, undefined);
});

for (const key of ["Ctrl+s", "Ctrl+Shift+s", "Shift+Home", "Ctrl+Shift+Left", "Tab", "Shift+Tab"]) {
  test(`Office ${key} delegates owned-panel focus to one native helper`, async () => {
    const f = fixture();
    const result = await f.call("press_key", { key });
    assert.equal(result.isError, undefined);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.cua.length, 0);
    assert.equal(f.calls.native[0].includes("-Office"), key !== "Tab");
  });
}
test("ordinary navigation keeps one foreground preparation", async () => {
  const f = fixture({ app: "notepad" });
  await f.call("press_key", { key: "Tab" });
  assert.deepEqual(f.calls.cua.map(call => call.name), ["bring_to_front"]);
  assert.equal(f.calls.native.length, 1);
});
for (const app of ["WINWORD", "notepad"]) for (const pasteOnly of [false, true]) {
  test(`${app} Windows pasteOnly=${pasteOnly} skips owner activation`, async () => {
    const f = fixture({ app });
    await f.call(pasteOnly ? "press_key" : "paste_text", pasteOnly ? { key: "Ctrl+v" } : { text: "filename" });
    assert.deepEqual(f.calls.cua.map(call => call.name), pasteOnly ? [] : ["clipboard_write"]);
    assert.equal(f.calls.native.length, 1);
  });
}
for (const change of ["stop", "epoch"]) for (const name of ["press_key", "paste_text"]) {
  test(`${name} cancels ${change} during target preparation`, async () => {
    const f = fixture();
    f.runtime._resolveTarget = async () => {
      if (change === "stop") f.runtime.stoppedByUser = true;
      else f.runtime._sessionEpoch = 1;
      return f.cached();
    };
    const result = await f.call(name, { key: "Ctrl+s", text: "text" });
    assert.equal(result.structuredContent.action_result.delivery, "not_sent");
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.cua.length, 0);
  });
}
for (const change of ["stop", "epoch"]) {
  test(`paste cancels ${change} after clipboard preparation`, async () => {
    const f = fixture({ onCua(name, runtime) {
      if (name !== "clipboard_write") return;
      if (change === "stop") runtime.stoppedByUser = true;
      else runtime._sessionEpoch = 1;
    } });
    const result = await f.call("paste_text", { text: "text" });
    assert.equal(result.structuredContent.action_result.delivery, "not_sent");
    assert.equal(f.calls.native.length, 0);
    assert.deepEqual(f.calls.cua.map(call => call.name), ["clipboard_write"]);
  });
}

test("unrelated unavailable cancellation marker cannot block an exact returned control", async () => {
  const f = fixture({ capture: () => state([filename, { role: "MenuItem", enabled: false, visible: false }]) });
  await f.snapshot();
  assert.equal((await f.call("set_value", { element_index: 7, value: "report.docx" })).structuredContent.action_result.delivery, "sent");
});
test("independent post-action capture authorizes its new token and preserves action outcome", async () => {
  const f = fixture({ capture: n => ({ ...state([{ ...filename, element_token: `fresh-${n}:7` }], { snapshot_id: `fresh-${n}` }), content: [image] }) });
  await f.snapshot();
  const result = await f.call("set_value", { element_index: 7, value: "report.docx" }, { observe: true });
  assert.equal(result.structuredContent.snapshot_actionable, true);
  assert.equal(result.structuredContent.observation.snapshot_actionable, true);
  assert.equal(result.structuredContent.observation.snapshot_id, "fresh-2");
  assert.equal(result.structuredContent.action_result.delivery, "sent");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.equal(f.cached().snapshot_actionable, true);
  await f.call("set_value", { element_index: 7, value: "next.docx" });
  assert.equal(f.calls.cua.filter(call => call.name === "set_value")[1].payload.element_token, "fresh-2:7");
  assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
});
test("failed screenshot-only fallback retains original UIA error and never tries a third capture", async () => {
  const f = fixture({ capture: n => {
    if (n === 1) return timeoutResult();
    throw new Error("screenshot unavailable");
  } });
  const result = await f.snapshot({ include_screenshot: true });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent.tree_error), /provider unresponsive/);
  assert.equal(result.structuredContent.tree_actionable, false);
  assert.equal(f.calls.cua.length, 2);
});
test("stalled fallback is cancelled promptly by session epoch and cannot publish later", async () => {
  let release;
  const f = fixture({ capture: (n, payload, runtime) => {
    if (n === 1) return timeoutResult();
    setTimeout(() => { runtime._sessionEpoch = 1; }, 5);
    return new Promise(resolve => { release = resolve; });
  } });
  await assert.rejects(f.runtime._getAppState({ app: "WINWORD", include_screenshot: true }), { code: "session_changed" });
  release({ content: [image], structuredContent: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cached().image_version, undefined);
  assert.equal(f.calls.cua.length, 2);
});

test("driver-attached state without independent capture cannot authorize indices", async () => {
  const f = fixture({ actionResult: state() });
  await f.snapshot();
  await f.call("set_value", { element_index: 7, value: "report.docx" });
  assert.equal(f.cached().snapshot_actionable, false);
  assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
});

test("query cannot resolve duplicate indices by hiding one duplicate", async () => {
  const f = fixture({ capture: () => state([filename, { ...filename, label: "Other" }]) });
  const result = await f.snapshot({ query: "文件名", refresh: true });
  assert.equal(result.structuredContent.elements.length, 1);
  assert.throws(() => f.runtime._elementFields("WINWORD", 7), /ambiguous/);
});

test("cached query cannot widen its last authorization or revive stale tokens", async () => {
  const f = fixture({ capture: n => state([filename, { ...filename, element_index: 22, element_token: "s000001:22", label: "Other" }]) });
  await f.snapshot({ query: "文件名", refresh: true });
  const hidden = await f.snapshot({ query: "Other" });
  assert.equal(hidden.structuredContent.query_local, true);
  assert.equal(hidden.structuredContent.elements.length, 0);
  assert.throws(() => f.runtime._elementFields("WINWORD", 22), { code: "stale_tree" });
  await f.call("click", { x: 1, y: 1 });
  const refreshed = await f.snapshot({ query: "文件名" });
  assert.equal(refreshed.structuredContent.query_local, false);
  assert.equal(f.calls.cua.filter(call => call.name === "get_window_state").length, 2);
});

for (const extra of [{ pid: 99 }, { cached: true }, { tree_error: "failed" }]) {
  test(`query and post-action observation reject unhealthy capture ${JSON.stringify(extra)}`, async () => {
    const f = fixture({ capture: () => ({ ...state([filename], extra), content: [image] }) });
    assert.equal((await f.snapshot({ query: "文件名" })).structuredContent.snapshot_actionable, false);
    const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
    assert.equal(result.structuredContent.snapshot_actionable, false);
    assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
  });
}

test("screenshot-only capture revokes a post-action token", async () => {
  const f = fixture({ capture: () => ({ ...state(), content: [image] }) });
  await f.call("click", { x: 1, y: 1 }, { observe: true });
  assert.equal(f.cached().snapshot_actionable, true);
  await f.snapshot({ include_screenshot: true, include_tree: false });
  assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
});

for (const change of ["stop", "epoch"]) {
  test(`post-action capture cannot publish after ${change}`, async () => {
    const f = fixture({ capture: (n, payload, runtime) => {
      if (change === "stop") runtime.stoppedByUser = true;
      else runtime._sessionEpoch = 1;
      return { ...state(), content: [image] };
    } });
    const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
    assert.equal(result.structuredContent.action_result.delivery, "sent");
    assert.notEqual(f.cached().snapshot_actionable, true);
    assert.ok(result.structuredContent.observation_error);
  });
}

test("a later capture supersedes pending post-action capture without losing its token", async () => {
  let release;
  const f = fixture({ capture: n => n === 1 ? new Promise(resolve => { release = resolve; })
    : { ...state([{ ...filename, element_token: "new:7" }], { snapshot_id: "new" }), content: [image] } });
  const pending = f.runtime._observeAction({ app: "WINWORD" }, { structuredContent: { delivery: "sent" } });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.runtime._getAppState({ app: "WINWORD", include_screenshot: false, refresh: true });
  release({ ...state(), content: [image] });
  const result = await pending;
  assert.equal(result.structuredContent.observation_error, "observation_superseded");
  assert.equal(f.runtime._elementFields("WINWORD", 7).element_token, "new:7");
});

const postRefusal = "foreground_unavailable: exact target HWND 0x64 or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0xc8).";
const preRefusal = "foreground_unavailable: Windows did not activate exact target HWND 0x64 (actual foreground HWND 0xc8); no mouse input was sent.";
const refused = text => ({ isError: true, content: [{ type: "text", text }], structuredContent: { code: "tool_invocation_failed" } });
const absentList = () => ({ structuredContent: { windows: [{ pid: 42, window_id: 200 }] } });
function assertInconclusive(result, reason) {
  const verification = result.structuredContent.window_verification;
  assert.equal(verification.status, "inconclusive");
  assert.equal(verification.source, "list_windows");
  assert.equal(verification.pid, 42);
  assert.equal(verification.window_id, 100);
  assert.equal(verification.reason, reason);
  assert.notEqual(result.structuredContent.code, "target_window_closed");
}

for (const observe of [false, true]) {
  test(`post-click refusal plus independently absent target reports closed, observe=${observe}`, async () => {
    const f = fixture({ actionResult: refused(postRefusal), listWindows: absentList });
    f.runtime.targets.set("winword.exe", { app: "WINWORD.EXE", pid: 42, window_id: 100 });
    f.runtime.targets.set("other-window", { app: "WINWORD", pid: 42, window_id: 200 });
    const result = await f.call("click", { x: 1264, y: 16, window_id: 100 }, { observe });
    assert.equal(result.isError, false);
    const s = result.structuredContent;
    assert.equal(s.code, "target_window_closed");
    assert.equal(s.pid, 42);
    assert.equal(s.window_id, 100);
    assert.equal(s.observation.status, "target_window_closed");
    assert.equal(s.action_result.delivery, "unknown");
    assert.equal(s.action_result.retry_safe, false);
    assert.equal(s.action_result.ui_change, "changed");
    assert.equal(s.action_result.goal, "unconfirmed");
    assert.ok(s.action_result.evidence.some(item => item.kind === "target_window_absent" && item.pid === 42 && item.window_id === 100));
    assert.equal(s.warning.message, postRefusal);
    assert.equal(f.runtime.targets.has("winword"), false);
    assert.equal(f.runtime.targets.has("winword.exe"), false);
    assert.equal(f.runtime.targets.has("other-window"), true);
    assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "list_windows"]);
    assert.ok(f.calls.cua[1].timeout > 0 && f.calls.cua[1].timeout <= 5000);
    assert.deepEqual(Object.keys(f.calls.cua[1].payload), []);
  });
}

for (const [label, reason, listWindows] of [
  ["error", "enumeration_error", () => ({ ...absentList(), isError: true })],
  ["throw", "enumeration_error", () => { const error = new Error("list failed"); error.code = "private_driver_code"; throw error; }],
  ["RPC timeout", "timeout", () => { throw new Error("runtime timeout: tools/call"); }],
  ["missing", "malformed", () => ({ structuredContent: {} })],
  ["empty", "empty", () => ({ structuredContent: { windows: [] } })],
  ["malformed", "malformed", () => ({ structuredContent: { windows: [{ pid: 42 }] } })],
  ["cached", "enumeration_error", () => ({ structuredContent: { ...absentList().structuredContent, cached: true } })],
  ["present", "target_present", () => ({ structuredContent: { windows: [{ pid: 42, window_id: 100 }, { pid: 99, window_id: 200 }] } })],
]) {
  test(`post-click refusal remains error when list is ${label}`, async () => {
    const f = fixture({ actionResult: refused(postRefusal), listWindows });
    const result = await f.call("click", { x: 1, y: 1 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "tool_invocation_failed");
    assert.equal(result.structuredContent.action_result.delivery, "unknown");
    assert.equal(result.structuredContent.action_result.retry_safe, false);
    assert.equal(result.structuredContent.action_result.ui_change, "unknown");
    assertInconclusive(result, reason);
    assert.equal(JSON.stringify(result).includes("private_driver_code"), false);
    assert.ok(f.cached());
    assert.equal(f.calls.cua.filter(call => call.name === "click").length, 1);
  });
}

for (const text of [preRefusal, "click failed", `prefix ${postRefusal}`, postRefusal.replace("0x64", "0x65")]) {
  test(`only exact post-click refusal checks closure: ${text}`, async () => {
    const f = fixture({ actionResult: refused(text), listWindows: absentList });
    const result = await f.call("click", { x: 1, y: 1 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.action_result.delivery, text === preRefusal ? "not_sent" : "unknown");
    assert.equal(result.structuredContent.action_result.retry_safe, text === preRefusal);
    assert.equal(result.structuredContent.code, "tool_invocation_failed");
    assert.deepEqual(f.calls.cua.map(call => call.name), ["click"]);
  });
}

test("independent window list can confirm absence after three virtual seconds", async () => {
  const clock = { now: 1000 };
  let release;
  const f = fixture({ clock, actionResult: refused(postRefusal),
    listWindows: () => new Promise(resolve => { release = resolve; }) });
  f.runtime._waitStep = async (work, context) => {
    assert.equal(context.deadline - clock.now, 5000);
    const pending = work();
    clock.now += 3000;
    release(absentList());
    return pending;
  };
  const result = await f.call("click", { x: 1, y: 1 });
  assert.equal(result.structuredContent.code, "target_window_closed");
  assert.equal(f.calls.cua[1].timeout, 5000);
});

test("five-second virtual timeout is inconclusive and a late list cannot clear target", async () => {
  const clock = { now: 1000 };
  let release;
  const f = fixture({ clock, actionResult: refused(postRefusal),
    listWindows: () => new Promise(resolve => { release = resolve; }) });
  f.runtime._waitStep = async (work, context) => {
    assert.equal(context.deadline - clock.now, 5000);
    work();
    clock.now = context.deadline;
    const error = new Error("not public");
    error.code = "wait_timeout";
    throw error;
  };
  const result = await f.call("click", { x: 1, y: 1 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.action_result.delivery, "unknown");
  assert.equal(result.structuredContent.action_result.retry_safe, false);
  assertInconclusive(result, "timeout");
  release(absentList());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.cached());
  assert.equal(f.calls.cua.length, 2);
});

test("independent observation replaces stale driver-attached tokens in public fields", async () => {
  const f = fixture({ actionResult: state([{ ...filename, element_token: "attached:7" }], { snapshot_id: "attached", delivery: "unknown" }),
    capture: () => ({ ...state(), content: [image] }) });
  const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
  assert.equal(result.structuredContent.snapshot_id, "s000001");
  assert.equal(result.structuredContent.elements[0].element_token, "s000001:7");
  assert.equal(result.structuredContent.action_result.delivery, "unknown");
  assert.equal(result.structuredContent.action_result.retry_safe, false);
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
});

test("pre-input refusal plus missing target observation preserves not_sent error and identity", async () => {
  const f = fixture({ actionResult: refused(preRefusal), listWindows: absentList,
    capture: () => refused("No window exists with the specified window_id") });
  const result = await f.call("click", { x: 1, y: 1, window_id: 100 }, { observe: true });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "tool_invocation_failed");
  assert.equal(result.structuredContent.action_result.delivery, "not_sent");
  assert.equal(result.structuredContent.action_result.ui_change, "unknown");
  assert.equal(result.structuredContent.pid, 42);
  assert.equal(result.structuredContent.window_id, 100);
  assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "get_window_state"]);
});

for (const change of ["stop", "epoch"]) {
  test(`window list cannot confirm closure after ${change}`, async () => {
    const f = fixture({ actionResult: refused(postRefusal), capture: () => ({ ...state(), content: [image] }),
      listWindows: (payload, timeout, runtime) => {
      if (change === "stop") runtime.stoppedByUser = true;
      else runtime._sessionEpoch = 1;
      return absentList();
    } });
    const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.action_result.delivery, "unknown");
    assertInconclusive(result, change === "stop" ? "stopped" : "session_changed");
    assert.ok(f.cached());
    assert.notEqual(f.cached().snapshot_actionable, true);
    assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "list_windows"]);
  });
}

test("closed target retains explicit original transport counts", async () => {
  const original = refused(postRefusal);
  original.structuredContent.sent = 2;
  original.structuredContent.expected = 4;
  const f = fixture({ actionResult: original, listWindows: absentList });
  const result = await f.call("click", { x: 1, y: 1 });
  assert.equal(result.structuredContent.code, "target_window_closed");
  assert.equal(result.structuredContent.action_result.delivery, "partial");
  assert.equal(result.structuredContent.action_result.retry_safe, false);
});

test("truncated window list does not establish closure", async () => {
  const f = fixture({ actionResult: refused(postRefusal), listWindows: () => ({
    structuredContent: { ...absentList().structuredContent, truncated: true },
  }) });
  const result = await f.call("click", { x: 1, y: 1 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "tool_invocation_failed");
  assertInconclusive(result, "incomplete");
});

for (const [name, args] of [["click", { x: 1, y: 1 }], ["scroll", { direction: "down" }],
  ["set_value", { element_index: 7, value: "report.docx" }]]) for (const throws of [false, true]) {
  test(`${name} async dispatch epoch change skips post-observation, throws=${throws}`, async () => {
    const f = fixture({ capture: () => ({ ...state(), content: [image] }) });
    await f.snapshot();
    const dispatch = f.runtime._dispatch.bind(f.runtime);
    f.runtime._dispatch = async (...parameters) => {
      const result = await dispatch(...parameters);
      await new Promise(resolve => setImmediate(resolve));
      f.runtime._sessionEpoch = (f.runtime._sessionEpoch || 0) + 1;
      if (throws) throw new Error("old session action failed");
      return result;
    };
    const result = await f.call(name, args, { observe: true });
    assert.equal(f.runtime.stoppedByUser, false);
    assert.equal(f.calls.cua.filter(call => call.name === "get_window_state").length, 1);
    assert.equal(f.calls.cua.filter(call => call.name === name).length, 1);
    assert.equal(f.cached().snapshot_actionable, false);
    assert.equal(result.structuredContent.snapshot_actionable, false);
    assert.equal(result.structuredContent.observation, undefined);
    assert.equal(result.structuredContent.action_result.delivery, throws ? "unknown" : "sent");
    assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
    assert.throws(() => f.runtime._elementFields("WINWORD", 7), { code: "stale_tree" });
  });
}

for (const extra of [{ query: "other" }, { query_local: true }, { filtered: true },
  { is_filtered: true }, { filter: { pid: 99 } }, { filters: ["visible"] }]) for (const envelope of [false, true]) {
  test(`filtered window list cannot prove closure, envelope=${envelope}, ${JSON.stringify(extra)}`, async () => {
    const f = fixture({ actionResult: refused(postRefusal), listWindows: () => envelope
      ? { ...absentList(), ...extra }
      : { structuredContent: { ...absentList().structuredContent, ...extra } } });
    const result = await f.call("click", { x: 1, y: 1 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "tool_invocation_failed");
    assert.equal(result.structuredContent.action_result.delivery, "unknown");
    assert.equal(result.structuredContent.action_result.retry_safe, false);
    assert.equal(result.structuredContent.action_result.ui_change, "unknown");
    assertInconclusive(result, "filtered");
    assert.ok(result.content.some(item => item.text?.includes(postRefusal)));
    assert.ok(f.cached());
    assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "list_windows"]);
  });
}

const closeButton = { ...filename, role: "Button", label: "Close", actions: ["Invoke"] };
const invokeSuccess = (extra = {}) => ({ content: [{ ...image }], structuredContent: {
  ok: true, success: true, verified: true, effect: "confirmed", pid: 42, window_id: 100, ...extra,
} });
const degradedEmpty = () => state([], { elements_complete: false, degraded: true,
  degraded_reason: "ax_tree_empty", tree_stale: true, image_stale: true });

test("background Word Invoke plus degraded empty observation independently confirms closure", async () => {
  const f = fixture({ actionResult: invokeSuccess({ snapshot_id: "old", elements: [filename], elements_complete: true,
    screenshot_png_b64: "YWJj", tree_stale: true, image_stale: true }),
    capture: n => n === 1 ? state([closeButton], { elements_complete: true }) : degradedEmpty(),
    listWindows: absentList });
  await f.snapshot();
  f.runtime.targets.set("winword.exe", { app: "WINWORD.EXE", pid: 42, window_id: 100 });
  f.runtime.targets.set("other-document", { app: "WINWORD", pid: 42, window_id: 200 });
  const result = await f.call("click", { element_index: 7 }, { observe: true });
  const s = result.structuredContent;
  assert.equal(result.isError, false);
  assert.equal(s.code, "target_window_closed");
  assert.equal(s.window_verification.status, "absent");
  assert.equal(s.window_verification.source, "list_windows");
  assert.equal(s.pid, 42);
  assert.equal(s.window_id, 100);
  assert.equal(s.action_result.delivery, "unknown");
  assert.equal(s.action_result.goal, "unconfirmed");
  assert.equal(s.action_result.ui_change, "changed");
  assert.ok(s.action_result.evidence.some(item => item.kind === "target_window_absent" && item.pid === 42 && item.window_id === 100));
  assert.ok(s.action_result.evidence.some(item => item.kind === "ui_change" && item.value === "changed"));
  for (const key of ["elements", "elements_complete", "snapshot_id", "tree_stale", "image_stale", "screenshot_png_b64"]) {
    assert.equal(s[key], undefined, `${key} should not survive closure verification`);
  }
  assert.equal(result.content.some(item => item.type === "image"), false);
  assert.equal(f.runtime.targets.has("winword"), false);
  assert.equal(f.runtime.targets.has("winword.exe"), false);
  assert.equal(f.runtime.targets.has("other-document"), true);
  assert.deepEqual(f.calls.cua.map(call => call.name), ["get_window_state", "click", "get_window_state", "list_windows"]);
  assert.equal(f.calls.cua[1].payload.delivery_mode, "background");
  assert.deepEqual(Object.keys(f.calls.cua[3].payload), []);
});

test("background PowerPoint Invoke plus observation exception independently confirms closure", async () => {
  const f = fixture({ app: "POWERPNT", actionResult: invokeSuccess(),
    capture: n => {
      if (n === 1) return state([closeButton], { elements_complete: true });
      throw new Error("UIA provider crashed after Invoke");
    },
    listWindows: absentList });
  await f.snapshot();
  const result = await f.call("click", { element_index: 7 }, { observe: true });
  assert.equal(result.structuredContent.code, "target_window_closed");
  assert.equal(result.structuredContent.action_result.delivery, "unknown");
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
  assert.match(result.structuredContent.warning.message, /UIA provider crashed after Invoke/);
  assert.equal(f.calls.cua.filter(call => call.name === "click").length, 1);
  assert.equal(f.calls.cua.filter(call => call.name === "list_windows").length, 1);
});

test("a complete healthy empty tree is a valid observation, not a closure signal", async () => {
  const f = fixture({ actionResult: invokeSuccess({ transport_sent: true, sent: 1, expected: 1 }),
    capture: () => state([], { elements_complete: true }), listWindows: absentList });
  const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
  assert.notEqual(result.structuredContent.code, "target_window_closed");
  assert.equal(result.structuredContent.action_result.delivery, "sent");
  assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "get_window_state"]);
  assert.ok(f.cached());
});

for (const [label, reason, listWindows] of [
  ["empty", "empty", () => ({ structuredContent: { windows: [] } })],
  ["malformed", "malformed", () => ({ structuredContent: { windows: [{ pid: 42 }] } })],
  ["filtered", "filtered", () => ({ structuredContent: { windows: [{ pid: 42, window_id: 200 }], filtered: true } })],
  ["incomplete", "incomplete", () => ({ structuredContent: { windows: [{ pid: 42, window_id: 200 }], windows_complete: false } })],
  ["truncated", "incomplete", () => ({ structuredContent: { windows: [{ pid: 42, window_id: 200 }], truncated: true } })],
]) {
  test(`failed observation cannot confirm closure from ${label} window list`, async () => {
    const f = fixture({ actionResult: invokeSuccess({ transport_sent: true, sent: 1, expected: 1 }),
      capture: degradedEmpty, listWindows });
    const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
    assert.notEqual(result.structuredContent.code, "target_window_closed");
    assert.equal(result.structuredContent.action_result.delivery, "sent");
    assertInconclusive(result, reason);
    assert.ok(f.cached());
    assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "get_window_state", "list_windows"]);
  });
}

for (const change of ["stop", "epoch"]) {
  test(`failed observation cannot confirm closure after ${change} during independent listing`, async () => {
    const f = fixture({ actionResult: invokeSuccess(), capture: degradedEmpty,
      listWindows: (payload, timeout, runtime) => {
        if (change === "stop") runtime.stoppedByUser = true;
        else runtime._sessionEpoch = (runtime._sessionEpoch || 0) + 1;
        return absentList();
      } });
    const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
    assert.notEqual(result.structuredContent.code, "target_window_closed");
    assertInconclusive(result, change === "stop" ? "stopped" : "session_changed");
    assert.ok(f.cached());
  });
}

test("explicit pre-input not_sent refusal is never upgraded by failed observation", async () => {
  const f = fixture({ actionResult: refused(preRefusal), capture: degradedEmpty, listWindows: absentList });
  const result = await f.call("click", { x: 1, y: 1, window_id: 100 }, { observe: true });
  assert.equal(result.structuredContent.action_result.delivery, "not_sent");
  assert.equal(result.structuredContent.action_result.ui_change, "unknown");
  assert.equal(result.structuredContent.code, "tool_invocation_failed");
  assert.equal(result.structuredContent.window_verification, undefined);
  assert.deepEqual(f.calls.cua.map(call => call.name), ["click", "get_window_state"]);
});

test("same HWND reused by another PID is not accepted as target absence", async () => {
  const f = fixture({ actionResult: invokeSuccess(), capture: degradedEmpty,
    listWindows: () => ({ structuredContent: { windows: [{ pid: 99, window_id: 100 }] } }) });
  const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
  assert.notEqual(result.structuredContent.code, "target_window_closed");
  assertInconclusive(result, "hwnd_reused");
  assert.ok(f.cached());
});

test("old snapshot fields do not prove closure when the independent list is inconclusive", async () => {
  const f = fixture({ actionResult: invokeSuccess({ snapshot_id: "old", elements: [filename],
    elements_complete: true, tree_stale: true, image_stale: true }),
    capture: degradedEmpty, listWindows: () => ({ structuredContent: { windows: [] } }) });
  const result = await f.call("click", { x: 1, y: 1 }, { observe: true });
  assert.notEqual(result.structuredContent.code, "target_window_closed");
  assertInconclusive(result, "empty");
  assert.ok(f.cached());
});
