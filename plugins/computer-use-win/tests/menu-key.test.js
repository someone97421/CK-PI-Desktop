"use strict";
// All transports and driver calls are mocked. This suite never sends keys.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const runtimePath = path.join(__dirname, "..", "runtime.js");
const source = fs.readFileSync(runtimePath, "utf8");
const overlay = [{ label: "删除记录", element_index: 1 }];
const editor = [{ label: "BITABLE_TEXT_EDITOR", element_index: 2 }];
const normal = [{ role: "Document", label: "Notes", element_index: 3 }];

function fixture({ platform = "win32", elements = overlay, live = elements, native, reindexError, liveResult,
  treeActionable = true, afterCapture } = {}) {
  const calls = { native: [], cua: [], action: [], state: [] };
  const exports = {};
  let now = 1_000_000;
  const target = { pid: 42, window_id: 100, app: "notepad" };
  const sandbox = {
    module: { exports }, exports, Buffer, console, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    __dirname: path.dirname(runtimePath), process: { platform, env: {} },
    require(name) {
      if (name === "./powershell") return { resolvePowerShell: () => "powershell.exe" };
      if (name === "node:child_process") return {
        spawn() { throw new Error("Unexpected spawn"); },
        spawnSync(exe, args, opts) {
          calls.native.push({ exe, args, opts });
          assert.ok(args.some((arg) => arg.endsWith("windows-send-key.ps1")), "no UIA focus helper");
          assert.equal(args[args.indexOf("-TargetPid") + 1], "42");
          if (typeof native === "function") {
            const response = native(calls.native.length);
            if (response) return response;
          }
          if (native instanceof Error) throw native;
          if (native && typeof native !== "function") return native;
          const expected = args.includes("-Shift") ? 4 : 2;
          return { status: 0, stdout: JSON.stringify({ ok: true, code: "transport_sent", sent: expected, expected,
            foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 0 }), stderr: "" };
        },
      };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: runtimePath });
  const runtime = Object.create(sandbox.module.exports.ComputerUseRuntime.prototype);
  runtime.targets = new Map([["notepad", { pid: 42, window_id: 100, elements, tree_actionable: treeActionable }]]);
  runtime._resolveTarget = async () => ({ ...runtime.targets.get("notepad"), ...target });
  runtime._childEnv = () => ({});
  runtime._cua = async (name, payload) => {
    calls.cua.push({ name, payload });
    if (reindexError === "throw") throw new Error("reindex unavailable");
    if (reindexError === "isError") return { isError: true, content: [{ type: "text", text: "state failed" }] };
    let result;
    if (liveResult) result = typeof liveResult === "function" ? liveResult({ runtime, name, payload }) : liveResult;
    else result = { structuredContent: live === null ? {} : { elements: live, snapshot_id: "fresh" } };
    if (afterCapture && name === "get_window_state") afterCapture(runtime);
    return result;
  };
  const getAppState = runtime._getAppState.bind(runtime);
  runtime._getAppState = (args) => { calls.state.push({ ...args }); return getAppState(args); };
  runtime._cuaAction = async (name, payload, observe) => {
    calls.action.push({ name, payload, observe });
    return { structuredContent: { effect: "unverifiable", delivery_mode: "background" } };
  };
  return { calls, runtime, target, advance: (ms) => { now += ms; },
    press: (key) => runtime._pressKey({ app: "notepad", key }, false),
    snapshot: (args = {}) => runtime._getAppState({ app: "notepad", include_screenshot: false, include_tree: true, ...args }) };
}

for (const key of ["End", "Down", "Up", "Home", "Page_Down", "Page_Up", "Delete", "Insert", "Escape", "Shift+Tab", "Shift+F10", "Menu"]) {
  test(`${key}: recognized Windows overlay uses native once, never cua action`, async () => {
    const f = fixture();
    const result = await f.press(key);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.action.length, 0);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.transport_sent, true);
    assert.equal(result.structuredContent.effect, "unverifiable");
    assert.notEqual(result.structuredContent.verified, true);
    assert.ok(f.calls.cua.every((call) => ["get_window_state", "bring_to_front"].includes(call.name)));
  });
}

for (const sent of [0, 1]) {
  test(`native failure sent=${sent} propagates with no replay`, async () => {
    const f = fixture({ native: { status: 1, stderr: "x".repeat(5000), stdout: JSON.stringify({
      ok: false, code: sent ? "send_input_partial" : "send_input_failed", sent, expected: 2,
      foreground_hwnd: 100, focus_hwnd: 101, target_hwnd: 100, target_pid: 42, last_error: 5,
    }) } });
    const result = await f.press("Down");
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.sent, sent);
    assert.ok(result.structuredContent.diagnostic.length <= 800);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.action.length, 0);
  });
}

for (const native of [{ status: 0, stdout: "not json", stderr: "" }, { status: 0, stdout: "null" }, new Error("timeout")]) {
  test("malformed/exceptional helper result fails without retry", async () => {
    const f = fixture({ native });
    assert.equal((await f.press("End")).isError, true);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.action.length, 0);
  });
}

test("Menu fresh editor guard sends Escape only, without UIA refocus", async () => {
  const f = fixture({ elements: [], live: editor });
  const result = await f.press("Menu");
  assert.equal(f.calls.native.length, 1);
  const args = f.calls.native[0].args;
  assert.equal(args[args.indexOf("-Key") + 1], "escape");
  assert.equal(f.calls.action.length, 0);
  assert.equal(f.calls.cua.filter((call) => call.name === "get_window_state").length, 2);
  assert.equal(result.structuredContent.cell_editing, true);
});

test("failed editing Escape is not claimed successful", async () => {
  const f = fixture({ live: editor, native: { status: 1, stdout: "", stderr: "failed" } });
  const result = await f.press("Menu");
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /sent Escape only/);
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.action.length, 0);
});

test("explicit editor Escape uses native once", async () => {
  const f = fixture({ elements: editor });
  await f.press("Escape");
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.action.length, 0);
  assert.equal(f.calls.cua.filter((call) => call.name === "get_window_state").length, 2);
});

for (const reindexError of ["throw", "isError"]) {
  test(`live reindex ${reindexError} fails closed even with cached editor`, async () => {
    const f = fixture({ elements: editor, reindexError });
    assert.equal((await f.press("Menu")).isError, true);
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 0);
  });
}

test("missing live tree fails closed; explicitly healthy empty tree can open Menu", async () => {
  const missing = fixture({ elements: editor, live: null });
  assert.equal((await missing.press("Menu")).isError, true);
  assert.equal(missing.calls.native.length, 0);
  assert.equal(missing.calls.action.length, 0);
  const empty = fixture({ elements: editor, live: [] });
  assert.equal((await empty.press("Menu")).isError, undefined);
  assert.equal(empty.calls.native.length, 1);
  assert.equal(empty.calls.action.length, 0);
  assert.equal(empty.runtime.targets.get("notepad").elements.length, 0);
});

for (const key of ["End", "Down", "Escape"]) {
  test(`normal Notepad ${key} uses the guarded native route`, async () => {
    const f = fixture({ elements: [], live: [] });
    const result = await f.press(key);
    assert.equal(f.calls.native.length, 1);
    assert.equal(f.calls.action.length, 0);
    assert.equal(result.structuredContent.path, "win32-hwnd");
  });
}

for (const key of ["Menu", "End", "Down", "Escape", "Shift+F10"]) {
  test(`macOS ${key} never invokes or annotates Win32`, async () => {
    const f = fixture({ platform: "darwin" });
    const result = await f.press(key);
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /win32|native|overlay_unverified/);
  });
}

for (const [key, expected] of [
  ["Control_L+Down", ["ctrl", "down"]], ["Alt+End", ["alt", "end"]],
  ["Win+Home", ["win", "home"]], ["Command+Down", ["ctrl", "down"]],
  ["Control_L+F10", ["ctrl", "f10"]], ["Shift+Down", ["shift", "down"]],
]) {
  test(`${key}: unsupported non-menu modifiers stay intact on cua`, async () => {
    const f = fixture();
    await f.press(key);
    assert.equal(f.calls.native.length, 0);
    assert.deepEqual(Array.from(f.calls.action[0].payload.keys), expected);
  });
}

for (const key of ["Ctrl+Menu", "Alt+Shift+F10", "Win+Menu", "Command+Menu"]) {
  test(`${key}: unsupported menu chord fails closed, modifiers never stripped`, async () => {
    const f = fixture();
    assert.equal((await f.press(key)).isError, true);
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 0);
  });
}

test("editing non-menu hotkey never requests UIA focus", async () => {
  const f = fixture({ elements: editor });
  await f.press("Control_L+a");
  assert.equal(f.calls.native.length, 0);
  assert.deepEqual(Array.from(f.calls.action[0].payload.keys), ["ctrl", "a"]);
});

for (const opener of ["Menu", "Shift+F10"]) {
  test(`${opener} then End/Down retains native routing without an external snapshot`, async () => {
    const f = fixture({ elements: normal });
    await f.press(opener);
    const deadline = f.runtime._nativeMenuContext.expiresAt;
    f.advance(10_000);
    await f.press("End");
    await f.press("Down");
    assert.equal(f.calls.native.length, 3);
    assert.equal(f.calls.cua.filter(c => c.name === "get_window_state").length, 1, "only the pre-Menu guard fetched a tree");
    assert.equal(f.calls.cua.filter(c => c.name === "bring_to_front").length, 1, "Menu route prepares the foreground once");
    assert.equal(f.calls.action.length, 0);
    assert.equal(f.runtime._nativeMenuContext.expiresAt, deadline, "navigation cannot extend the deadline");
  });
}

for (const closer of ["Escape", "Return"]) {
  test(`${closer} clears native menu context`, async () => {
    const f = fixture({ elements: normal });
    await f.press("Menu");
    await f.press(closer);
    await f.press("Down");
    assert.equal(f.calls.native.length, 3);
    assert.equal(f.calls.action.length, 0);
    assert.equal(f.runtime._nativeMenuContext, null);
  });
}

for (const mismatch of ["expiry", "window", "pid"]) {
  test(`menu context clears on ${mismatch} and cannot revive`, async () => {
    const f = fixture({ elements: normal });
    await f.press("Menu");
    if (mismatch === "expiry") f.advance(30_000);
    if (mismatch === "window") f.target.window_id = 200;
    if (mismatch === "pid") f.target.pid = 43;
    await f.press("Down");
    f.target.window_id = 100; f.target.pid = 42;
    await f.press("End");
    assert.equal(f.calls.native.length, 3);
    assert.equal(f.calls.action.length, 0);
    assert.equal(f.runtime._nativeMenuContext, null);
  });
}

for (const failureAt of [1, 2]) {
  test(`native failure at action ${failureAt} clears context without replay`, async () => {
    const f = fixture({ elements: normal, native: (n) => n === failureAt ? { status: 1, stdout: "" } : null });
    await f.press("Menu");
    if (failureAt === 2) assert.equal((await f.press("Down")).isError, true);
    assert.equal(f.runtime._nativeMenuContext, null);
    await f.press("End");
    assert.equal(f.calls.native.length, failureAt + 1);
    assert.equal(f.calls.action.length, 0);
  });
}

test("editing Escape downgrade never arms menu navigation", async () => {
  const f = fixture({ live: editor });
  await f.press("Menu");
  await f.press("Down");
  assert.equal(f.calls.native.length, 2);
  assert.equal(f.calls.action.length, 0);
  assert.equal(f.runtime._nativeMenuContext, null);
});

test("menu context never strips modifiers and clears on unrelated hotkeys", async () => {
  const f = fixture({ elements: normal });
  await f.press("Menu");
  await f.press("Ctrl+Down");
  await f.press("Down");
  assert.deepEqual(Array.from(f.calls.action[0].payload.keys), ["ctrl", "down"]);
  assert.equal(f.calls.native.length, 2);
  assert.equal(f.calls.action.length, 1);
});

for (const live of [[], normal]) {
  test(`fresh full ${live.length ? "non-menu" : "empty"} tree clears context and old element tokens`, async () => {
    let fresh = normal;
    const f = fixture({ elements: normal, liveResult: () => ({ structuredContent: { snapshot_id: "new", elements: fresh } }) });
    await f.press("Menu");
    f.runtime.targets.get("notepad").elements = [{ ...overlay[0], element_index: 99, element_token: "old-token" }];
    f.runtime.targets.get("notepad").snapshot_id = "old";
    fresh = live;
    await f.snapshot();
    assert.equal(f.runtime._nativeMenuContext, null);
    const cached = f.runtime.targets.get("notepad");
    assert.equal(cached.snapshot_id, "new");
    assert.equal(cached.elements.length, live.length);
    assert.throws(() => f.runtime._elementFields("notepad", 99), { code: "stale_tree" });
    await f.press("Down");
    assert.equal(f.calls.native.length, 2);
    assert.equal(f.calls.action.length, 0);
  });
}

test("fresh generic menu tree retains context; query and screenshot-only trees cannot clear it", async () => {
  let fresh = normal;
  const f = fixture({ elements: normal, liveResult: () => ({ structuredContent: { snapshot_id: "new", elements: fresh } }) });
  await f.press("Menu");
  fresh = [{ role: "MenuItem", label: "Copy", element_index: 4 }];
  await f.snapshot();
  assert.ok(f.runtime._nativeMenuContext);
  await f.snapshot({ query: "not found" });
  fresh = [];
  await f.snapshot({ include_tree: false, include_screenshot: true });
  await f.press("Down");
  assert.equal(f.calls.native.length, 2);
  assert.equal(f.calls.action.length, 0);
});

for (const flags of [
  { isError: true }, { degraded: true }, { degraded_reason: "timeout" },
  { truncated: true }, { tree_truncated: true }, { incomplete: true }, { partial: true },
  { complete: false }, { tree_complete: false }, { is_full: false }, { has_more: true },
  { metadata: { depth_limit_reached: true } }, { tree_status: "partial" },
  { max_depth_reached: true }, { depth_limited: true }, { accessibility_tree_complete: false },
  { query_local: true }, { query: "filtered" },
]) {
  test(`Menu rejects fresh tree quality flags ${JSON.stringify(flags)}`, async () => {
    const f = fixture({ elements: editor, liveResult: { structuredContent: { elements: normal, ...flags } } });
    assert.equal((await f.press("Menu")).isError, true);
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 0);
    assert.equal(f.runtime._nativeMenuContext, null);
  });
}

for (const flags of [{ degraded: true }, { truncated: true }, { incomplete: true }]) {
  test(`Menu preserves and rejects top-level quality flags ${JSON.stringify(flags)}`, async () => {
    const f = fixture({ liveResult: { ...flags, structuredContent: { elements: normal } } });
    assert.equal((await f.press("Menu")).isError, true);
    assert.equal(f.calls.native.length, 0);
  });
}

for (const [label, elements] of [
  ["400 elements", Array.from({ length: 400 }, (_, i) => ({ ...normal[0], element_index: i }))],
  ["depth 20", [{ ...normal[0], depth: 20 }]],
  ["depth over 20", [{ ...normal[0], depth: 21 }]],
]) {
  test(`Menu conservatively rejects driver cap: ${label}`, async () => {
    const f = fixture({ live: elements });
    assert.equal((await f.press("Menu")).isError, true);
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 0);
    const guardFetch = f.calls.cua.find(c => c.name === "get_window_state");
    assert.equal(guardFetch.payload.max_elements, 400);
    assert.equal(guardFetch.payload.max_depth, 20);
  });
}

test("Menu accepts a fresh tree below caps with explicitly healthy flags", async () => {
  const f = fixture({ liveResult: { structuredContent: {
    elements: Array.from({ length: 399 }, (_, i) => ({ ...normal[0], element_index: i, depth: 19 })),
    degraded: false, truncated: false, complete: true, error: null,
  } } });
  assert.equal((await f.press("Menu")).isError, undefined);
  assert.equal(f.calls.native.length, 1);
});

for (const failure of ["error", "throw", "degraded"]) {
  test(`fresh snapshot ${failure} clears existing menu context`, async () => {
    let fail = false;
    const f = fixture({ elements: normal, liveResult: () => {
      if (fail && failure === "throw") throw new Error("unavailable");
      if (fail && failure === "error") return { isError: true };
      return { structuredContent: { elements: normal, degraded: fail } };
    } });
    await f.press("Menu");
    fail = true;
    if (failure === "throw") await assert.rejects(f.snapshot());
    else await f.snapshot();
    assert.equal(f.runtime._nativeMenuContext, null);
  });
}

test("native activation source preserves owned popups and checks focus immediately before sending", () => {
  const ps = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-send-key.ps1"), "utf8");
  const activation = ps.slice(ps.indexOf("static bool EnsureForeground("), ps.indexOf("static bool CheckTarget("));
  assert.match(activation, /!IsWindow\(hwnd\).*actualPid != pid/);
  assert.match(activation, /!IsWindow\(root\).*actualPid != pid/);
  assert.ok(activation.indexOf("actualPid != pid") < activation.indexOf("ShowWindow(root, 9)"));
  assert.ok(activation.indexOf("if (BelongsTo(") < activation.indexOf("ShowWindow(root, 9)"));
  assert.match(activation, /bool restored = IsIconic\(root\);\s*if \(restored\) ShowWindow\(root, 9\)/);
  assert.match(activation, /System\.Threading\.Thread\.Sleep\(300\);/);
  assert.match(activation, /if \(IsIconic\(root\)\) \{ result\.code = "restore_incomplete"; return false; \}/);
  assert.equal((ps.match(/SetForegroundWindow\(root\)/g) || []).length, 1);
  assert.match(activation, /if \(belongs\) return true;/);
  assert.match(activation, /long remaining = 300 - result.activation_wait_ms;/);
  assert.match(activation, /if \(remaining <= 0\) \{ result.code = "foreground_mismatch"; return false; \}/);
  assert.doesNotMatch(activation, /SendInput|!activated/);
  assert.doesNotMatch(ps, /AttachThreadInput|SetFocus|keybd_event|SendKeys/);
  assert.match(ps, /if \(!EnsureForeground\(hwnd, pid, result\)\) return result;/);
  assert.match(ps, /GetGUIThreadInfo\(thread, ref info\)/);
  assert.match(ps, /if \(!CheckTarget\(hwnd, pid, result\)\) return result;\s*SetLastError\(0\);\s*result.sent = SendInput/);
});

test("fresh full empty tree without a new snapshot ID clears the old snapshot and tokens", async () => {
  const f = fixture({ elements: [{ ...editor[0], element_token: "stale" }], liveResult: { structuredContent: { elements: [] } } });
  f.runtime.targets.get("notepad").snapshot_id = "old";
  await f.snapshot();
  assert.equal(f.runtime.targets.get("notepad").elements.length, 0);
  assert.equal(f.runtime.targets.get("notepad").snapshot_id, undefined);
  assert.throws(() => f.runtime._elementFields("notepad", 2), { code: "stale_tree" });
});

test("Menu partial live tree with visible editor sends one Escape and no Menu/CUA action", async () => {
  const f = fixture({ elements: normal, liveResult: { structuredContent: {
    elements: [{ role: "Group", name: "BITABLE_TEXT_EDITOR_CONTAINER_ID_PREFIX_42", element_index: 9 }],
    elements_complete: false, truncated: true,
  } } });
  const result = await f.press("Menu");
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.native[0].args[f.calls.native[0].args.indexOf("-Key") + 1], "escape");
  assert.equal(f.calls.action.length, 0);
  assert.equal(result.structuredContent.cell_editing, true);
  assert.equal(f.calls.state[0].refresh, true);
  assert.equal(f.calls.state[0].include_tree, true);
  assert.equal(f.calls.state[0].include_screenshot, false);
});

test("Menu partial live tree without editor blocks with not_sent and truthful code", async () => {
  const f = fixture({ liveResult: { structuredContent: { elements: normal, elements_complete: false } } });
  const result = await f.press("Menu");
  assert.equal(result.structuredContent.code, "menu_tree_incomplete");
  assert.equal(result.structuredContent.delivery, "not_sent");
  assert.match(result.content[0].text, /partial tree.*no positive/i);
  assert.equal(f.calls.native.length, 0);
  assert.equal(f.calls.action.length, 0);
});

for (const [label, liveResult] of [
  ["error", { isError: true, structuredContent: { elements: editor } }],
  ["degraded", { structuredContent: { elements: editor, degraded: true } }],
  ["query", { structuredContent: { elements: editor, query: "BITABLE" } }],
  ["cached", { structuredContent: { elements: editor, from_cache: true } }],
  ["hidden", { structuredContent: { elements: [{ ...editor[0], hidden: true }] } }],
  ["disabled", { structuredContent: { elements: [{ ...editor[0], enabled: false }] } }],
  ["foreign", { structuredContent: { elements: editor, pid: 99, window_id: 999 } }],
]) {
  test(`Menu rejects ${label} editor evidence without native delivery`, async () => {
    const f = fixture({ elements: editor, liveResult });
    const result = await f.press("Menu");
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.delivery, "not_sent");
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 0);
  });
}

test("plain Escape reindexes non-actionable tree and uses partial positive editor evidence once", async () => {
  const f = fixture({ elements: normal, treeActionable: false, liveResult: { structuredContent: {
    elements: [{ role: "Edit", name: "number-editor-input-7", element_index: 7 }], incomplete: true,
  } } });
  const result = await f.press("Escape");
  assert.equal(f.calls.state.length, 2);
  assert.equal(f.calls.state[0].refresh, true);
  assert.equal(f.calls.native.length, 1);
  assert.equal(f.calls.action.length, 0);
  assert.equal(result.structuredContent.cell_editing, true);
});

test("plain Escape refresh failure never uses stale editor marker or CUA", async () => {
  const f = fixture({ elements: editor, treeActionable: false, reindexError: "throw" });
  const result = await f.press("Escape");
  assert.equal(result.structuredContent.code, "escape_live_capture_failed");
  assert.equal(result.structuredContent.delivery, "not_sent");
  assert.equal(f.calls.native.length, 0);
  assert.equal(f.calls.action.length, 0);
});

for (const change of ["stop", "epoch"]) {
  for (const key of ["Menu", "Escape"]) {
    test(`${key} sends no input when ${change} changes after refresh`, async () => {
      const f = fixture({ elements: normal, treeActionable: key === "Menu", live: editor,
        afterCapture(runtime) {
          if (change === "stop") runtime.stoppedByUser = true;
          else runtime._sessionEpoch = (runtime._sessionEpoch || 0) + 1;
        } });
      const result = await f.press(key);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.delivery, "not_sent");
      assert.equal(f.calls.native.length, 0);
      assert.equal(f.calls.action.length, 0);
    });
  }
}

for (const [label, liveResult] of [
  ["top-level error", { error: "capture failed", structuredContent: { elements: editor } }],
  ["nested capture error", { structuredContent: { elements: editor, metadata: { capture_error: "timeout" } } }],
  ["nested failed status", { structuredContent: { elements: editor, metadata: { capture_status: "failed" } } }],
  ["cached tree", { structuredContent: { elements: editor, from_cache: true } }],
  ["nested cached tree", { structuredContent: { elements: editor, metadata: { cache_hit: true } } }],
  ["foreign window", { structuredContent: { elements: editor, pid: 99, window_id: 999 } }],
  ["explicit target mismatch", { structuredContent: { elements: editor, _capture_target_match: false } }],
]) {
  test(`${label} cannot become actionable or authorize Menu/Escape from cache`, async () => {
    const f = fixture({ elements: editor, liveResult });
    await f.snapshot();
    assert.equal(f.runtime.targets.get("notepad").tree_actionable, false);
    const escape = await f.press("Escape");
    assert.equal(escape.structuredContent.delivery, "not_sent");
    const menu = await f.press("Menu");
    assert.equal(menu.structuredContent.delivery, "not_sent");
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.action.length, 0);
  });
}
