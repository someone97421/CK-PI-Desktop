import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../adapter/file-actions.js", import.meta.url), "utf8");
const file = (name = "示例.txt", text = "文件内容", mimeType = "text/plain") => ({
  name, mimeType, blob: new Blob([text], { type: mimeType }),
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(reader = async () => file()) {
  const created = new Map();
  const revoked = [];
  const clicks = [];
  const reads = [];
  const timers = new Map();
  const listeners = new Map();
  let timerId = 0;
  let urlId = 0;
  let document;
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.listeners = new Map();
      this.textContent = "";
    }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); }
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; delete this[key]; }
    addEventListener(type, fn) {
      const group = this.listeners.get(type) || [];
      group.push(fn);
      this.listeners.set(type, group);
    }
    emit(type, extra = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (const fn of this.listeners.get(type) || []) fn(event);
      return event;
    }
    click() {
      if (this.disabled) return;
      if (this.tagName === "a") clicks.push({ name: this.download, url: this.href, target: this.target, blob: created.get(this.href) });
      this.emit("click");
    }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    pause() { this.paused = true; }
    load() { this.loaded = true; }
    querySelectorAll(selector) {
      const tags = selector.split(",").map(tag => tag.trim());
      return this.children.flatMap(node => [...(tags.includes(node.tagName) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
  }
  document = { createElement: tag => new Node(tag) };
  document.body = new Node("body");
  const trigger = new Node("button");
  document.body.append(trigger);
  trigger.focus();
  const window = {
    __piDesktopReadRemoteFile(context) { reads.push(context); return reader(context); },
    addEventListener(type, fn) { listeners.set(type, fn); },
  };
  vm.runInNewContext(source, {
    window, document, Blob, Uint8Array, TextDecoder,
    URL: {
      createObjectURL(blob) { const url = `blob:test-${++urlId}`; created.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const find = className => {
    const walk = node => node.className?.split(" ").includes(className) ? node : node.children.map(walk).find(Boolean);
    return walk(document.body);
  };
  return {
    actions: window.__piDesktopFileMenu.actions, document, trigger, reads, created, revoked, clicks, timers, find,
    event(type) { listeners.get(type)?.(); },
    flushTimers() { for (const { fn } of [...timers.values()]) fn(); },
  };
}

test("同步动作顺序固定、延迟读取并保留文件和会话上下文", async () => {
  const app = fixture();
  const context = { path: "/项目/示例.txt", sessionId: "session-1" };
  const actions = app.actions(context);
  assert.ok(Array.isArray(actions));
  assert.deepEqual(Array.from(actions, action => [action.id, action.label]), [["preview", "预览"], ["download", "下载"]]);
  assert.equal(app.reads.length, 0);
  context.path = "另一个文件";
  await actions[1].run();
  assert.equal(app.reads[0].path, "/项目/示例.txt");
  assert.equal(app.reads[0].sessionId, "session-1");
  app.flushTimers();
});

test("下载保留原始 Blob、中文文件名，不弹出窗口，延迟释放 URL", async () => {
  const original = file("原始数据.bin", new Uint8Array([0, 255, 13, 10]), "application/octet-stream");
  const app = fixture(async () => original);
  await app.actions({ path: "/数据.bin" })[1].run();
  assert.equal(app.clicks[0].name, original.name);
  assert.equal(app.clicks[0].blob, original.blob);
  assert.deepEqual(new Uint8Array(await app.clicks[0].blob.arrayBuffer()), new Uint8Array([0, 255, 13, 10]));
  assert.equal(app.clicks[0].target, undefined);
  assert.equal(app.document.body.querySelectorAll("a").length, 0);
  assert.equal(app.revoked.length, 0);
  assert.equal([...app.timers.values()][0].delay, 60000);
  app.flushTimers();
  assert.deepEqual(app.revoked, [app.clicks[0].url]);
  assert.equal(app.timers.size, 0);
});

test("文本代码按纯文本展示，关闭后恢复焦点", async () => {
  const app = fixture(async () => file("代码.ts", '<script>alert("x")</script>', "application/octet-stream"));
  await app.actions({ path: "/代码.ts" })[0].run();
  assert.equal(app.find("lan-file-text").textContent, '<script>alert("x")</script>');
  assert.equal(app.document.body.querySelectorAll("iframe").length, 0);
  app.find("lan-file-controls").children[1].click();
  assert.equal(app.find("lan-file-dialog"), undefined);
  assert.equal(app.document.activeElement, app.trigger);
});

test("HTML sandbox 仅允许脚本，URL 在关闭而非加载完成时释放", async () => {
  const app = fixture(async () => file("页面.html", "<h1>页面</h1>", "application/octet-stream"));
  await app.actions({ path: "/页面.html" })[0].run();
  const frame = app.find("lan-file-html");
  assert.equal(frame.attributes.sandbox, "allow-scripts");
  const url = frame.src;
  assert.equal(app.created.get(url).type, "text/html");
  frame.emit("load");
  assert.deepEqual(app.revoked, []);
  const event = app.find("lan-file-dialog").emit("cancel");
  assert.equal(event.defaultPrevented, true);
  assert.equal(frame.src, "about:blank");
  assert.deepEqual(app.revoked, [url]);
  assert.equal(app.document.activeElement, app.trigger);
});

test("读取中关闭和并发替换不会创建旧预览 URL", async () => {
  const pending = deferred();
  let count = 0;
  const app = fixture(() => ++count === 1 ? pending.promise : Promise.resolve(file("新图.png", "图片", "image/png")));
  const first = app.actions({ path: "/旧图.png" })[0].run();
  assert.match(app.find("lan-file-status").textContent, /正在读取/);
  await app.actions({ path: "/新图.png" })[0].run();
  pending.resolve(file("旧图.png", "图片", "image/png"));
  await first;
  assert.equal(app.created.size, 1);
  assert.equal(app.find("lan-file-title").textContent, "新图.png");
  app.find("lan-file-dialog").emit("click");
  assert.equal(app.revoked.length, 1);
  assert.equal(app.document.activeElement, app.trigger);
});

test("读取后但文本解析完成前关闭不会重新挂载内容", async () => {
  const pending = deferred();
  const parsing = deferred();
  const original = file();
  original.blob.arrayBuffer = () => { parsing.resolve(); return pending.promise; };
  const app = fixture(async () => original);
  const run = app.actions({ path: "/示例.txt" })[0].run();
  await parsing.promise;
  app.find("lan-file-dialog").emit("cancel");
  pending.resolve(new Uint8Array([65]).buffer);
  await run;
  assert.equal(app.find("lan-file-dialog"), undefined);
  assert.equal(app.created.size, 0);
});

test("未知二进制及伪装文本均拒绝文本预览，仍可原样下载", async () => {
  for (const [name, bytes] of [["数据.bin", [65, 0, 255]], ["数据.txt", [65, 0, 255]], ["无效编码.txt", [255, 254, 255]]]) {
    const original = file(name, new Uint8Array(bytes), "application/octet-stream");
    const app = fixture(async () => original);
    await app.actions({ path: `/${name}` })[0].run();
    assert.match(app.find("lan-file-status").textContent, /无法预览/);
    assert.equal(app.find("lan-file-text"), undefined);
    app.find("lan-file-controls").children[0].click();
    assert.equal(app.clicks[0].blob, original.blob);
    assert.equal(app.reads.length, 1);
    app.event("pagehide");
    assert.equal(app.revoked.length, 1);
    assert.equal(app.timers.size, 0);
  }
});

test("图片、PDF、音频及视频使用对应组件并在替换与关闭时释放资源", async () => {
  let current;
  const app = fixture(async () => current);
  let previousMedia;
  for (const [kind, name, mime] of [["image", "a.png", "image/png"], ["pdf", "a.pdf", "application/octet-stream"], ["audio", "a.mp3", "audio/mpeg"], ["video", "a.mp4", "video/mp4"]]) {
    current = file(name, "数据", mime);
    await app.actions({ path: `/${name}` })[0].run();
    const media = app.find(`lan-file-${kind}`);
    assert.ok(media);
    if (kind === "pdf") assert.equal(app.created.get(media.src).type, "application/pdf");
    if (["audio", "video"].includes(kind)) assert.equal(media.controls, true);
    if (previousMedia?.tagName === "audio") assert.equal(previousMedia.paused, true);
    previousMedia = media;
  }
  app.event("pagehide");
  assert.equal(previousMedia.paused, true);
  assert.equal(previousMedia.loaded, true);
  assert.equal(app.created.size, 4);
  assert.equal(new Set(app.revoked).size, 4);
  assert.equal(app.revoked.length, 4);
});

test("读取失败保持 reject，预览显示错误且不产生下载或 URL", async () => {
  const failure = new Error("没有读取权限");
  const app = fixture(async () => { throw failure; });
  await assert.rejects(app.actions({ path: "/文件" })[1].run(), error => error === failure);
  await assert.rejects(app.actions({ path: "/文件", sessionId: "s" })[0].run(), error => error === failure);
  assert.match(app.find("lan-file-status").textContent, /没有读取权限/);
  assert.equal(app.find("lan-file-status").attributes.role, "alert");
  assert.equal(app.created.size, 0);
  assert.equal(app.clicks.length, 0);
  app.find("lan-file-dialog").emit("cancel");
});

test("HTML 使用主程序解析后的资源地址，关闭时停止 iframe 而不制造 Blob URL", async () => {
  const previewUrl = "http://127.0.0.1:7878/api/file-view/token/session/posix/project/index.html";
  const app = fixture(async () => ({ ...file("index.html", "<h1>内容</h1>", "text/html"), previewUrl }));
  await app.actions({ path: "index.html", sessionId: "session" })[0].run();
  const frame = app.find("lan-file-html");
  assert.equal(frame.src, previewUrl);
  assert.equal(app.created.size, 0);
  app.find("lan-file-dialog").emit("cancel");
  assert.equal(frame.src, "about:blank");
});
