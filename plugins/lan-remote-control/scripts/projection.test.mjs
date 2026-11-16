import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../adapter/projection.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../adapter/projection.css", import.meta.url), "utf8");

const key = "__piLanProjection";
function fixture({ saved, denyHistory = false } = {}) {
  const listeners = new Map();
  const emit = (type, detail) => {
    for (const fn of [...(listeners.get(type) || [])]) fn(detail);
  };
  const entries = [saved || {}];
  let index = 0;
  const navigations = [];
  const pending = [];
  const frames = new Map();
  let frameId = 0;
  const window = {
    addEventListener(type, fn) { const group = listeners.get(type) || []; group.push(fn); listeners.set(type, group); },
    dispatchEvent(event) { emit(event.type, event); },
  };
  const history = {
    get state() { return entries[index]; },
    pushState(state) { if (denyHistory) throw new Error("unavailable"); entries.splice(++index); entries.push(state); },
    replaceState(state) { if (denyHistory) throw new Error("unavailable"); entries[index] = state; },
    go(delta) { pending.push(() => { const next = index + delta; if (next < 0 || next >= entries.length) return; index = next; emit("popstate", { state: entries[index] }); }); },
    back() { this.go(-1); },
  };
  window.addEventListener("pi-desktop:projection-navigate", (event) => navigations.push(event.detail.layer));
  const document = {
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  vm.runInNewContext(source, {
    window, document, history, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  return {
    entries, navigations, history,
    state(layer, ready = true, navigationRejected = false) { emit("pi-desktop:projection-state", { detail: { ready, layer, page: "chat", navigationRejected } }); },
    flush() { while (pending.length) pending.shift()(); },
    escape(editable = false) {
      const event = { key: "Escape", target: { closest: () => editable }, preventDefault() { this.defaultPrevented = true; } };
      emit("keydown", event);
      return event;
    },
  };
}

test("三级前进、浏览器返回和前进保持同一条层级历史", () => {
  const app = fixture();
  app.state("projects"); app.state("chat"); app.state("workpanel");
  assert.deepEqual(app.entries.map(state => state[key].layer), ["projects", "chat", "workpanel"]);
  app.history.back(); app.flush();
  assert.deepEqual(app.navigations, ["chat"]);
  app.state("chat");
  app.history.back(); app.flush(); app.state("projects");
  app.history.go(1); app.flush(); app.state("chat");
  assert.deepEqual(app.navigations, ["chat", "projects", "chat"]);
  assert.equal(app.entries.length, 3);
});

test("界面返回复用历史，不追加往返记录", () => {
  const app = fixture();
  app.state("projects"); app.state("chat"); app.state("workpanel");
  app.state("chat"); app.flush();
  assert.equal(app.history.state[key].layer, "chat");
  assert.equal(app.navigations.length, 0);
  app.state("projects"); app.flush();
  assert.equal(app.history.state[key].layer, "projects");
});

test("从项目直接打开三级时补齐二级返回路径", () => {
  const app = fixture();
  app.state("projects"); app.state("workpanel");
  assert.deepEqual(app.entries.map(state => state[key].layer), ["projects", "chat", "workpanel"]);
  app.escape(); app.flush();
  assert.deepEqual(app.navigations, ["chat"]);
});

test("初始聊天也有一级返回入口，输入时 Escape 留给输入框", () => {
  const app = fixture();
  app.state("chat");
  assert.deepEqual(app.entries.map(state => state[key].layer), ["projects", "chat"]);
  assert.equal(app.escape(true).defaultPrevented, undefined);
  assert.equal(app.escape().defaultPrevented, true);
  app.flush();
  assert.deepEqual(app.navigations, ["projects"]);
});

test("刷新恢复历史后接收实际层反馈，无法恢复三级时仍可继续导航", () => {
  const app = fixture({ saved: { other: 42, [key]: { layer: "workpanel", depth: 2 } } });
  app.state("projects", false);
  assert.equal(app.navigations.length, 0);
  app.state("projects");
  assert.deepEqual(app.navigations, ["workpanel"]);
  app.state("projects", true, true);
  assert.equal(app.history.state[key].layer, "projects");
  assert.equal(app.history.state.other, 42);
  app.state("chat");
  assert.equal(app.history.state[key].layer, "chat");
});

test("浏览器禁用历史写入时仍可用 Escape 返回", () => {
  const app = fixture({ denyHistory: true });
  app.state("projects"); app.state("chat"); app.state("workpanel");
  app.escape();
  assert.deepEqual(app.navigations, ["chat"]);
});

test("恢复三级时忽略中间二级，避免重复追加返回历史", () => {
  const app = fixture();
  app.state("projects"); app.state("chat"); app.state("workpanel");
  app.state("projects"); app.flush();
  app.history.go(2); app.flush();
  app.state("chat");
  assert.equal(app.history.state[key].layer, "workpanel");
  app.state("workpanel");
  assert.equal(app.entries.length, 3);
  app.history.back(); app.flush(); app.state("chat");
  assert.equal(app.history.state[key].layer, "chat");
});

test("异步后退期间连续返回按最终层落定，不弹回二级", () => {
  const app = fixture();
  app.state("projects"); app.state("chat"); app.state("workpanel");
  app.state("chat"); app.state("projects");
  app.flush();
  assert.equal(app.history.state[key].layer, "projects");
  assert.deepEqual(app.navigations, []);
});

test("后退尚未完成又重新打开三级时保留原历史", () => {
  const app = fixture();
  app.state("projects"); app.state("chat"); app.state("workpanel");
  app.state("chat"); app.state("workpanel");
  app.flush();
  assert.equal(app.history.state[key].layer, "workpanel");
  assert.equal(app.entries.length, 3);
  assert.deepEqual(app.navigations, []);
});

test("投影适配层隐藏远控页面无效的三大窗口控制键", () => {
  assert.match(cssSource, /\.app-shell\[data-projection-layer\] > \.window-controls/);
  assert.match(cssSource, /display:\s*none/);
  assert.match(cssSource, /--ds-window-controls-width:\s*0px/);
});
