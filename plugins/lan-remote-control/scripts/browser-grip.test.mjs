import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../adapter/browser-grip.js", import.meta.url), "utf8");
const origin = "chrome-extension://afeafocngkodbmaipcngoamamfmekgfo";
function fixture({ embedded = true, parentOrigin = origin, reducedMotion = false } = {}) {
  const listeners = new Map(), messages = [], animations = [], timers = new Map(), frames = [];
  let document, observer, uuid = 0;
  class Node {
    constructor(tag, className = "") { this.tag = tag; this.className = className; this.children = []; this.style = {}; this.dataset = {}; this.listeners = new Map(); this.attributes = {}; }
    get isConnected() { return this === document.body || !!this.parent?.isConnected; }
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
    get firstElementChild() { return this.children[0]; }
    set innerHTML(value) { this.html = value; this.append(new Node("svg")); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; if (key === "data-dragging") delete this.dataset.dragging; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(child, next) { child.parent = this; const index = this.children.indexOf(next); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    querySelector(selector) { return this.children.find(child => child.className.split(" ").includes(selector.slice(1))) ?? this.children.map(child => child.querySelector(selector)).find(Boolean); }
    closest(selector) { return this.className.split(" ").includes(selector.slice(1)) ? this : this.parent?.closest(selector); }
    cloneNode() { return new Node(this.tag, this.className); }
    getBoundingClientRect() { return { left: 50, top: this.tag === "input" ? 40 : 100, width: this.tag === "input" ? 300 : 28, height: 28 }; }
    animate(keyframes, options) { const animation = { keyframes, options }; animations.push(animation); return animation; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, event = {}) { const value = { preventDefault() { this.defaultPrevented = true; }, ...event }; this.listeners.get(type)?.(value); return value; }
  }
  document = { createElement: tag => new Node(tag), querySelectorAll: () => [left] };
  document.body = new Node("body");
  const shell = new Node("section", "composer-shell"), left = new Node("div", "composer-left");
  const plus = new Node("div", "composer-plus"), mode = new Node("button", "mode-btn"), input = new Node("input", "composer-input");
  left.append(plus, mode); shell.append(input, left); document.body.append(shell);
  const window = { innerWidth: 400, matchMedia: () => ({ matches: reducedMotion }), addEventListener: (type, fn) => listeners.set(type, fn) };
  const parent = embedded ? { postMessage: (message, targetOrigin) => messages.push({ message: JSON.parse(JSON.stringify(message)), targetOrigin }) } : window;
  vm.runInNewContext(source, {
    window, parent, document, URLSearchParams, location: { search: `?parentOrigin=${encodeURIComponent(parentOrigin)}` },
    crypto: { randomUUID: () => `drag-${++uuid}` },
    MutationObserver: class { constructor(callback) { this.callback = callback; observer = this; } observe() { this.connected = true; } disconnect() { this.connected = false; } },
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, cancelAnimationFrame() {},
    setTimeout: (callback) => { const id = Symbol(); timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
  });
  return {
    document, left, plus, mode, messages, animations, timers,
    get button() { return left.querySelector(".lan-composer-grip"); },
    event(type, event) { listeners.get(type)?.(event); },
    result(id, ok, eventOrigin = origin) { listeners.get("message")?.({ source: parent, origin: eventOrigin, data: { type: "pi-desktop:element-picker-result", sessionId: id, ok, error: "捕捉失败" } }); },
    mutate() { observer.callback(); for (const callback of frames.splice(0)) callback(); },
    start() { const transfer = { types: [], setData(type) { this.types.push(type); }, setDragImage(image, x, y) { this.dragImage = { image, x, y }; } }; this.button.emit("dragstart", { dataTransfer: transfer }); return transfer; },
  };
}

test("准星复用输入工具栏按钮样式，紧邻添加文件且重复刷新不增加按钮", () => {
  const app = fixture();
  assert.deepEqual(app.left.children, [app.plus, app.button, app.mode]);
  assert.equal(app.button.className, "icon-btn icon-btn-square lan-composer-grip");
  assert.equal(app.button.draggable, true);
  app.mutate(); app.mutate();
  assert.equal(app.left.children.length, 3);
});

test("独立远控网页和不合法父来源都不显示抓手", () => {
  assert.equal(fixture({ embedded: false }).button, undefined);
  assert.equal(fixture({ parentOrigin: "https://example.com" }).button, undefined);
});

test("拖动使用透明占位图，保留同一捕捉 ID 且等待成功回执再播放动画", () => {
  const app = fixture();
  const transfer = app.start();
  assert.deepEqual(transfer.types, ["application/x-browse-element-drag-1"]);
  assert.notEqual(transfer.dragImage.image, app.button);
  assert.equal(transfer.dragImage.image.tag, "canvas");
  assert.deepEqual([transfer.dragImage.image.width, transfer.dragImage.image.height, transfer.dragImage.x, transfer.dragImage.y], [1, 1, 0, 0]);
  app.mutate();
  assert.equal(transfer.dragImage.image.parent, null);
  assert.deepEqual(app.messages[0], { message: { type: "pi-desktop:element-picker", action: "start", sessionId: "drag-1" }, targetOrigin: origin });
  app.button.emit("dragend", { dataTransfer: { dropEffect: "copy" } });
  assert.equal(app.messages[1].message.cancel, false);
  assert.equal(app.animations.length, 0);
  app.result("old-id", true); app.result("drag-1", true, "https://example.com");
  assert.equal(app.animations.length, 0);
  app.result("drag-1", true);
  assert.equal(app.animations.length, 1);
  app.result("drag-1", true);
  assert.equal(app.animations.length, 1);
  assert.equal(app.timers.size, 0);
});

test("取消、失败及减少动态效果不播放成功动画", () => {
  const cancel = fixture(); cancel.start(); cancel.event("keydown", { key: "Escape" }); cancel.result("drag-1", true);
  assert.equal(cancel.messages.at(-1).message.cancel, true);
  assert.equal(cancel.animations.length, 0);
  const failed = fixture(); failed.start(); failed.result("drag-1", false);
  assert.equal(failed.animations.length, 0);
  assert.match(failed.document.body.children.at(-1).textContent, /捕捉失败/);
  const reduced = fixture({ reducedMotion: true }); reduced.start(); reduced.result("drag-1", true);
  assert.equal(reduced.animations.length, 0);
});
