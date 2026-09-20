"use strict";
// Public contracts only. All runtime calls are mocked; no desktop input occurs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { OCU_TOOLS, STOP_TOOL, makeExecutors } = require("../tools");
const manifest = require("../manifest.json");

function shape(value) {
  if (Array.isArray(value)) return value.map(shape);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description").map(([key, item]) => [key, shape(item)]));
}

const evidence = {
  schema_version: 1, action: "click", delivery: "unknown", ui_change: "unknown",
  goal: "unconfirmed", retry_safe: false, evidence: [],
};
function fixture(result) {
  const calls = [];
  const runtime = { async callTool(...args) { calls.push(args); return result; } };
  return { calls, executors: makeExecutors(runtime, async () => ({ enabled: true })) };
}

test("facade remains thirteen desktop tools with matching manifest names", () => {
  assert.equal(OCU_TOOLS.length + 1, 13);
  const all = [...OCU_TOOLS, STOP_TOOL];
  assert.deepEqual(all.map(x => x.name).sort(), manifest.contributes.agentTools.map(x => x.name).sort());
});

test("observation schema matches manifest including nested wait contracts", () => {
  const runtime = OCU_TOOLS.find(x => x.name === "get_app_state").schema;
  const declared = manifest.contributes.agentTools.find(x => x.name === "get_app_state").schema;
  assert.deepEqual(shape(runtime), shape(declared));
});

test("wait request forwards literal predicate and bounds without adding an action", async () => {
  const f = fixture({ content: [{ type: "text", text: "wait matched" }], structuredContent: { wait: { status: "matched" } } });
  const predicate = { kind: "value_changed", name: "Status", role: "Edit", baseline: "" };
  const result = await f.executors.get_app_state({ app: "Notepad", include_screenshot: false, refresh: true,
    wait_for: predicate, wait_timeout_ms: 30000, poll_interval_ms: 1000 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "get_app_state");
  assert.deepEqual(f.calls[0][1].wait_for, predicate);
  assert.equal(f.calls[0][1].wait_timeout_ms, 30000);
  assert.equal(f.calls[0][1].poll_interval_ms, 1000);
  assert.equal(f.calls[0][1].refresh, true);
  assert.equal(result.structuredContent.wait.status, "matched");
});

test("action diagnostics survive facade presentation", async () => {
  const structuredContent = { action_result: evidence, code: "unknown_delivery", target_pid: 42 };
  const f = fixture({ content: [{ type: "text", text: "verify before continuing" }], structuredContent });
  const result = await f.executors.click({ app: "Notepad", window_id: 100, x: 25, y: 25 });
  assert.deepEqual(result.structuredContent, structuredContent);
  assert.equal(f.calls.length, 1);
  assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
});

test("failed partial paste stays an error with counts preserved", async () => {
  const structuredContent = { action_result: { ...evidence, action: "paste_text", delivery: "partial" },
    sent: 2, expected: 4, code: "send_input_partial" };
  const f = fixture({ isError: true, content: [{ type: "text", text: "No retry." }], structuredContent });
  const result = await f.executors.paste_text({ app: "Notepad", text: "test" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.structuredContent, structuredContent);
  assert.equal(f.calls.length, 1);
});

test("image/tree versions survive a no-image public response", async () => {
  const structuredContent = { observation_id: 4, image_version: 2, tree_version: 3,
    image_captured_at: 1000, tree_captured_at: 1100, tree_valid: true };
  const f = fixture({ content: [{ type: "text", text: "tree only" }], structuredContent });
  const result = await f.executors.get_app_state({ app: "Notepad", include_screenshot: false });
  assert.deepEqual(result.structuredContent, structuredContent);
});

test("public partial crop request returns invalid_region instead of disappearing", async () => {
  const f = fixture({ content: [{ type: "text", text: "state" }] });
  const result = await f.executors.get_app_state({ app: "Notepad", region_x: 10 });
  assert.equal(result.structuredContent.region_crop.code, "invalid_region");
  assert.equal(f.calls[0][1].region_x, undefined);
});

test("action tool schemas match manifest for every registered tool", () => {
  for (const name of ["click", "perform_secondary_action", "scroll", "drag", "type_text", "press_key", "paste_text", "set_value"]) {
    const runtime = OCU_TOOLS.find(x => x.name === name).schema;
    const declared = manifest.contributes.agentTools.find(x => x.name === name).schema;
    assert.deepEqual(shape(runtime), shape(declared), name);
  }
});

test("delivery_mode forwards through the press_key facade", async () => {
  const f = fixture({ content: [{ type: "text", text: "ok" }], structuredContent: {} });
  await f.executors.press_key({ app: "Notepad", key: "t", delivery_mode: "foreground" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "press_key");
  assert.equal(f.calls[0][1].delivery_mode, "foreground");
});

test("action observe with a partial region reports invalid_region instead of disappearing", async () => {
  const f = fixture({ content: [{ type: "text", text: "ok" }] });
  const result = await f.executors.press_key({ app: "Notepad", key: "t", observe: true, region_x: 10 });
  assert.equal(result.structuredContent.region_crop.code, "invalid_region");
  assert.equal(f.calls[0][1].region_x, undefined);
});

test("region args on a non-observe action are stripped and reported as observe_required", async () => {
  const f = fixture({ content: [{ type: "text", text: "ok" }], structuredContent: {} });
  const result = await f.executors.type_text({ app: "Notepad", text: "hi", region_x: 0, region_y: 0, region_width: 10, region_height: 10 });
  assert.equal(f.calls[0][1].region_x, undefined);
  assert.equal(result.structuredContent.region_crop.code, "observe_required");
});

test("secondary Select and unsupported patterns never become a default click", async () => {
  for (const action of ["Select", "Toggle", "Expand", "Collapse", "ScrollIntoView", "SetFocus", "Scroll", "CustomAction", "", "toString", "__proto__"]) {
    const f = fixture({ content: [{ type: "text", text: "must not invoke" }] });
    const result = await f.executors.perform_secondary_action({ app: "explorer.exe", window_id: 100,
      element_index: "33", action, observe: true });
    assert.equal(f.calls.length, 0, action);
    assert.equal(result.ok, false);
    assert.equal(result.structuredContent.code, "unsupported_secondary_action");
    assert.equal(result.structuredContent.action_result.action, "perform_secondary_action");
    assert.equal(result.structuredContent.action_result.delivery, "not_sent");
    assert.equal(result.structuredContent.transport_sent, false);
  }
});

test("supported secondary actions retain their semantics and public action identity", async () => {
  for (const [action, routed, extra] of [["Invoke", "click", {}], ["Set_Value", "set_value", { value: "" }],
    ["ScrollUp", "scroll", { direction: "up" }], ["ScrollDown", "scroll", { direction: "down" }],
    ["ScrollLeft", "scroll", { direction: "left" }], ["ScrollRight", "scroll", { direction: "right" }]]) {
    const f = fixture({ content: [{ type: "text", text: "unverified" }], structuredContent: { action_result: evidence } });
    const result = await f.executors.perform_secondary_action({ app: "explorer.exe", window_id: 100,
      element_index: "33", action, value: "", text: "must not replace explicit empty value" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], routed);
    for (const [key, value] of Object.entries(extra)) assert.equal(f.calls[0][1][key], value);
    assert.equal(f.calls[0][1].action, undefined);
    assert.equal(f.calls[0][1].text, undefined);
    assert.equal(f.calls[0][1].app, "explorer.exe");
    assert.equal(f.calls[0][1].window_id, 100);
    assert.equal(String(f.calls[0][1].element_index), "33");
    assert.equal(result.structuredContent.requested_action, action);
    assert.equal(result.structuredContent.action_result.action, "perform_secondary_action");
    assert.equal(result.structuredContent.action_result.routed_action, routed);
    assert.equal(result.structuredContent.action_result.delivery, "unknown");
  }
});
