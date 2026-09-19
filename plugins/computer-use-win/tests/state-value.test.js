"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeExecutors } = require("../tools");
const { attachReadValue, validateReadValue } = require("../state-value");
const target = { pid: 42, window_id: 100 };
const args = { app: "Notepad", window_id: 100, include_screenshot: false, read_value: { automation_id: "amount", role: "Edit" } };
const observation = () => ({ content: [{ type: "text", text: "fresh partial AX" }], structuredContent: {
  ...target, _capture_target_match: true, tree_actionable: false, elements_complete: false,
  action_result: { delivery: "not_sent", goal: "unconfirmed" },
} });
const read = value => ({ status: "read", source: "uia_value_pattern", value, code: "read", match_count: 1, complete: true, target });
function fixture(reader, result = observation()) {
  const calls = [];
  const runtime = { targets: new Map([["notepad", { ...target }]]), _sessionEpoch: 3,
    async callTool(name, forwarded) { calls.push({ name, args: forwarded }); return result; },
    _childEnv() { return {}; },
  };
  return { runtime, calls, tools: makeExecutors(runtime, async () => ({ enabled: true }), { readControlValue: reader }) };
}
for (const value of ["61.25", "", " 61.2500\r\n"]) {
  test(`exact value is preserved, not rounded or normalized: ${JSON.stringify(value)}`, async () => {
    const f = fixture(async (actual, selector) => { assert.deepEqual(actual, target); assert.deepEqual(selector, args.read_value); return read(value); });
    const result = await f.tools.get_app_state(args);
    assert.equal(result.structuredContent.read_value.value, value);
    assert.equal(result.structuredContent.read_value.source, "uia_value_pattern");
    assert.equal(result.structuredContent.action_result.goal, "unconfirmed");
    assert.equal(result.structuredContent.tree_actionable, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, "get_app_state");
    assert.equal(f.calls[0].args.refresh, true);
    assert.equal(f.calls[0].args.read_value, undefined);
  });
}
for (const selector of [null, [], {}, { name: "" }, { automation_id: 12 }, { name: "x", unknown: true }]) {
  test(`invalid read selector makes no runtime/helper call: ${JSON.stringify(selector)}`, async () => {
    let reads = 0;
    const f = fixture(async () => { reads++; return read("61"); });
    const result = await f.tools.get_app_state({ ...args, read_value: selector });
    assert.equal(result.ok, false);
    assert.equal(result.structuredContent.code, "validation_error");
    assert.equal(f.calls.length, 0); assert.equal(reads, 0);
  });
}
test("read and wait cannot be combined", async () => {
  const f = fixture(() => { throw new Error("must not run"); });
  const result = await f.tools.get_app_state({ ...args, wait_for: { kind: "value_equals", name: "Amount", value: "61" } });
  assert.equal(result.structuredContent.code, "validation_error"); assert.equal(f.calls.length, 0);
});
test("unavailable pattern does not publish a guessed value", async () => {
  const f = fixture(async () => ({ status: "unavailable", code: "pattern_unavailable", value: "61" }));
  const result = await f.tools.get_app_state(args);
  assert.equal(result.structuredContent.read_value.status, "unavailable");
  assert.equal(result.structuredContent.read_value.value, undefined);
});
for (const patch of [{ match_count: 2 }, { complete: false }, { source: "label" }, { target: { pid: 99, window_id: 100 } }, { value: undefined }]) {
  test(`unproven native value is rejected: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(async () => ({ ...read("61"), ...patch }));
    const result = await f.tools.get_app_state(args);
    assert.equal(result.structuredContent.read_value.code, "invalid_value_result");
    assert.equal(result.structuredContent.read_value.value, undefined);
  });
}
for (const change of ["stop", "epoch", "target"]) {
  test(`read result discarded after ${change}`, async () => {
    const f = fixture(async () => {
      if (change === "stop") f.runtime.stoppedByUser = true;
      if (change === "epoch") f.runtime._sessionEpoch++;
      if (change === "target") f.runtime.targets.clear();
      return read("61.25");
    });
    const result = await f.tools.get_app_state(args);
    assert.equal(result.structuredContent.read_value.status, "error");
    assert.equal(result.structuredContent.read_value.value, undefined);
  });
}
test("unusable observation target never invokes reader", async () => {
  let reads = 0;
  const result = observation(); result.structuredContent._capture_target_match = false;
  const f = fixture(() => { reads++; return read("61"); }, result);
  const output = await f.tools.get_app_state(args);
  assert.equal(output.structuredContent.read_value.code, "observation_target_unavailable"); assert.equal(reads, 0);
});
test("read value obeys existing app denylist", async () => {
  let reads = 0;
  const f = fixture(() => { reads++; return read("61"); });
  const result = await f.tools.get_app_state({ ...args, app: "powershell.exe" });
  assert.equal(result.ok, false); assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test("read_value with both outputs disabled still works by forcing a tree capture", async () => {
  const f = fixture(async () => read("61.25"));
  const result = await f.tools.get_app_state({ ...args, include_tree: false });
  assert.equal(result.structuredContent.read_value.status, "read");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.include_tree, true);
});
