// Dependency-free, isolated remote settings tests. No listener or real host.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { openModelSettings, pendingConfigurationNotice } from "../web/model-settings.js";

const require = createRequire(import.meta.url);
const { createModelSettings } = require("../model-settings.cjs");
const { createHostAdapter } = require("../host-adapter.cjs");
const model = { providerId: "provider", providerName: "Provider", modelId: "model", key: "provider/model", label: "Model", thinkingLevels: ["off", "high"] };
const base = { id: "session", mode: "agent", permissionMode: "ask", providerId: "provider", modelId: "model", modelKey: model.key, thinkingLevel: "off" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("adapter requests main-owned deferral and preserves actual versus queued settings", async () => {
  const calls = [];
  const adapter = createHostAdapter({ desktop: {
    listOperations: async () => [{ id: "session/configure" }],
    invoke: async call => {
      calls.push(call);
      if (call.operation === "session/get") return { session: base };
      assert.equal(call.operation, "session/configure");
      return { session: { ...base, pendingConfiguration: { mode: "agent", permissionMode: "auto" } }, queued: true };
    },
  } });
  const result = await adapter.invoke("models.configure", { sessionId: base.id, permissionMode: "auto" }, { isAuthorized: () => true });
  assert.deepEqual(calls.at(-1).args, [base.id, { mode: "agent", permissionMode: "auto", deferUntilIdle: true }]);
  assert.equal(calls.at(-1).confirm, true);
  assert.equal(result.queued, true);
  assert.equal(result.session.permissionMode, "ask");
  assert.equal(result.session.pendingConfiguration.permissionMode, "auto");
});

test("subsequent edits use queued mode and model, without replacing untouched fields", async () => {
  const current = { ...base, pendingConfiguration: { mode: "plan", providerId: "new", modelId: "model", thinkingLevel: "high" } };
  let saved;
  const service = createModelSettings({
    getSession: async () => current,
    listModels: async () => [{ ...model, providerId: "new" }],
    configureSession: async (id, config) => {
      saved = config;
      return { session: { ...current, pendingConfiguration: { ...current.pendingConfiguration, ...config } }, queued: true };
    },
    serializeSession: session => session,
  });
  await service.configure(base.id, { thinkingLevel: "off", permissionMode: "accept-edits" });
  assert.deepEqual(saved, { mode: "plan", permissionMode: "accept-edits", thinkingLevel: "off" });
});

test("invalid modes and incorrect queued receipts do not report success", async () => {
  let calls = 0;
  const service = createModelSettings({
    getSession: async () => base, listModels: async () => [model], serializeSession: session => session,
    configureSession: async () => { calls++; return { session: base, queued: true }; },
  });
  await assert.rejects(service.configure(base.id, { permissionMode: "unrestricted" }), { code: "INVALID_PARAMS" });
  assert.equal(calls, 0);
  await assert.rejects(service.configure(base.id, { permissionMode: "auto" }), /设置与请求不一致/);
});

// Minimal DOM implements only the APIs this module uses; browser layout is not tested.
class Element extends EventTarget {
  constructor(tag = "") {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {};
    this.value = ""; this.disabled = false; this.className = ""; this.dataset = {};
    this.classList = { add: name => { this.className += ` ${name}`; } };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = value; if (key === "disabled") this.disabled = true; }
  getAttribute(key) { return this.attrs[key]; }
  querySelectorAll() { return []; }
  blur() {}
}
globalThis.Node = Element;
globalThis.document = {
  createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
  createTextNode: text => Object.assign(new Element("#text"), { textContent: text }),
};
const walk = element => [element, ...element.children.flatMap(walk)];

async function open(session = base, save = async () => ({ session: base, queued: false })) {
  const saved = [], errors = [], calls = [];
  let isOpen = true, options;
  const sheet = {
    body: new Element("body"), panel: new Element("panel"),
    isOpen: () => isOpen, setBusy: busy => { sheet.busy = busy; },
    close: () => { isOpen = false; options.onClose(); }, showError: error => errors.push(error),
  };
  openModelSettings({
    sessionId: session.id, read: async () => ({ items: [model], session }),
    save: async (operation, input) => { calls.push({ operation, input }); return save(operation, input); },
    openSheet: value => { options = value; return sheet; },
    isCurrent: () => true, onCatalog: () => {}, onSaved: (...args) => saved.push(args),
  });
  await tick();
  const find = label => [...walk(sheet.body), ...walk(sheet.panel)].find(node => node.getAttribute("aria-label") === label);
  const change = (label, value) => { const field = find(label); field.value = value; field.dispatchEvent(new Event("change")); };
  return { sheet, saved, errors, calls, find, change };
}

test("running/waiting-approval UI accepts a queued receipt without displaying it as active", async () => {
  const pendingConfiguration = { mode: "agent", permissionMode: "auto" };
  const ui = await open({ ...base, running: true }, async () => ({ session: { ...base, pendingConfiguration }, queued: true }));
  ui.change("权限模式", "auto");
  ui.find("应用设置").dispatchEvent(new Event("click"));
  await tick();
  assert.equal(ui.calls.length, 1);
  assert.deepEqual(ui.saved[0][1], { queued: true });
  assert.equal(ui.saved[0][0].permissionMode, "ask");
  assert.equal(ui.saved[0][0].pendingConfiguration.permissionMode, "auto");
  assert.deepEqual(ui.errors, []);
  assert.match(pendingConfigurationNotice(ui.saved[0][0]), /下一轮开始前生效/);
  assert.match(pendingConfigurationNotice(ui.saved[0][0]), /原提交权限/);
});

test("reopening shows pending draft; reverting sends actual value to replace pending", async () => {
  const ui = await open({ ...base, pendingConfiguration: { permissionMode: "auto" } });
  assert.equal(ui.find("权限模式").value, "auto");
  assert.equal(ui.find("应用设置").disabled, true);
  ui.change("权限模式", "ask");
  ui.find("应用设置").dispatchEvent(new Event("click"));
  await tick();
  assert.deepEqual(ui.calls[0].input, { sessionId: base.id, permissionMode: "ask" });
  assert.equal(ui.saved[0][1].queued, false);
  assert.equal(pendingConfigurationNotice(ui.saved[0][0]), "");
});

test("cancel discards unsubmitted changes and repeated clicks cannot double-submit", async () => {
  const cancelled = await open();
  cancelled.change("权限模式", "auto");
  cancelled.sheet.close();
  cancelled.find("应用设置").dispatchEvent(new Event("click"));
  await tick();
  assert.equal(cancelled.calls.length, 0);
  let finish;
  const ui = await open(base, () => new Promise(resolve => { finish = resolve; }));
  ui.change("权限模式", "auto");
  const apply = ui.find("应用设置");
  apply.dispatchEvent(new Event("click")); apply.dispatchEvent(new Event("click"));
  assert.equal(ui.calls.length, 1);
  finish({ session: { ...base, permissionMode: "auto" }, queued: false });
  await tick();
  assert.equal(ui.saved.length, 1);
});

test("failure keeps the draft for retry and displays retained main-queue errors", async () => {
  const ui = await open(base, async () => { throw new Error("host unavailable"); });
  ui.change("权限模式", "auto");
  ui.find("应用设置").dispatchEvent(new Event("click")); await tick();
  assert.equal(ui.sheet.isOpen(), true);
  assert.equal(ui.find("权限模式").value, "auto");
  assert.equal(ui.find("应用设置").disabled, false);
  assert.deepEqual(ui.errors, ["host unavailable"]);
  assert.equal(ui.saved.length, 0);
  assert.match(pendingConfigurationNotice({ ...base, pendingConfiguration: { permissionMode: "auto" }, pendingConfigurationError: "failed to save" }), /failed to save/);
  const retry = await open({ ...base, pendingConfiguration: { permissionMode: "auto" }, pendingConfigurationError: "failed to save" }, async () => ({ session: { ...base, permissionMode: "auto" }, queued: false }));
  assert.equal(retry.find("应用设置").disabled, false);
  retry.find("应用设置").dispatchEvent(new Event("click")); await tick();
  assert.deepEqual(retry.calls[0].input, { sessionId: base.id });
  assert.equal(retry.saved[0][0].permissionMode, "auto");
});
