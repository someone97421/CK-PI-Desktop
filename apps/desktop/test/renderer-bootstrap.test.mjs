import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const fixtures = new Map([
  ["react", 'export default { StrictMode: "strict" };'],
  ["react/jsx-runtime", 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;'],
  ["react-dom/client", 'export default { createRoot: () => ({ render: () => globalThis.bootEvents.push("render") }) };'],
  ["i18next", 'const i18n = { language: "en", use() { return this; }, init() {} }; export default i18n;'],
  ["react-i18next", 'export const initReactI18next = {};'],
  ["@pi-desktop/i18n", 'export const catalogs = { en: { app: { uiCrashed: "crashed" } } }; export const flattenCatalog = x => x; export const resolveLocale = () => "en";'],
  ["./lib/scrollbar-reveal", 'export const installScrollbarReveal = () => {};'],
  ["./App", 'globalThis.consumerIds.push(crypto.randomUUID()); export default function App() {}'],
  ["./components/PluginLauncher", 'export function PluginLauncher() {}'],
  // 语言模块的导入会初始化状态库；这里保留它在模块求值时使用 UUID 的契约。
  ["./lib/app-language", 'globalThis.consumerIds.push(crypto.randomUUID()); export const resolveOsLocale = () => "en"; export const initLanguageSync = () => globalThis.bootEvents.push("language-sync");'],
]);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", logLevel: "silent",
  plugins: [{
    name: "bootstrap-boundary",
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, ({ path }) => fixtures.has(path) ? { path, namespace: "fixture" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: fixtures.get(path), loader: "js" }));
      plugin.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
    },
  }],
});

function environment(native = false, { rejectFirstLogin = false } = {}) {
  const errors = [];
  const bootEvents = [];
  const consumerIds = [];
  let loginAttempts = 0;
  const root = element("root");
  const crypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const originalUuid = () => "native-uuid";
  if (native) crypto.randomUUID = originalUuid;
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const window = {
    location: { origin: "http://192.168.8.10:7878", search: "" },
    addEventListener() {}, dispatchEvent() {},
    ...(native ? { piDesktop: { platform: "darwin", locale: "en" } } : {}),
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = new Map();
    constructor() { queueMicrotask(() => this.listeners.get("open")?.()); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(text) {
      if (JSON.parse(text).type === "auth") queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ type: "ready", protocolVersion: 2 }) }));
    }
    close() { this.readyState = 3; }
  }
  const context = vm.createContext({
    window, parent: window, location: window.location,
    document: {
      documentElement: { dataset: {}, style: { setProperty() {} } },
      getElementById: id => id === "root" ? root : null,
      createElement: element,
    },
    navigator: { language: "en" },
    crypto, localStorage, sessionStorage: localStorage,
    bootEvents, consumerIds, URL, URLSearchParams, Headers, AbortSignal, TextEncoder, TextDecoder,
    WebSocket: Socket, CustomEvent: class {}, queueMicrotask,
    fetch: async (url) => {
      if (String(url).endsWith("/api/login") && ++loginAttempts === 1 && rejectFirstLogin) {
        return { ok: false, status: 401, json: async () => ({ error: { code: "UNAUTHORIZED", message: "密码错误" } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { token: "bootstrap-test-token" } }) };
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
    console: { error: error => errors.push(error) },
  });
  return { context, root, crypto, originalUuid, errors, bootEvents, consumerIds };
}

function element(tag) {
  return {
    tag, children: [], listeners: new Map(), attributes: new Map(), value: "", textContent: "",
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() {},
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    },
    append(...children) {
      for (const child of children) { child.parent = this; this.children.push(child); }
    },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); },
  };
}
function descendant(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = descendant(child, predicate);
    if (found) return found;
  }
  return null;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("HTTP 缺少 randomUUID 时先完成 Web 桥和认证，再初始化状态消费者", async () => {
  const state = environment();
  vm.runInContext(bundle.outputFiles[0].text, state.context);
  await settle();
  assert.equal(state.errors.length, 0);
  assert.deepEqual(state.consumerIds, []);
  assert.equal(typeof state.crypto.randomUUID, "function");
  const form = descendant(state.root, node => node.tag === "form");
  assert.ok(form);
  const field = descendant(form, node => node.name === "password");
  field.value = "bootstrap-test-password";
  form.listeners.get("submit")({ preventDefault() {} });
  await settle();
  assert.equal(state.errors.length, 0);
  assert.deepEqual(state.bootEvents, ["language-sync", "render"]);
  assert.equal(state.consumerIds.length, 2);
  for (const id of state.consumerIds) assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.notEqual(state.consumerIds[0], state.consumerIds[1]);
});

test("桌面预加载可用时直接启动，保留原生 randomUUID", async () => {
  const state = environment(true);
  vm.runInContext(bundle.outputFiles[0].text, state.context);
  await settle();
  assert.equal(state.errors.length, 0);
  assert.deepEqual(state.bootEvents, ["language-sync", "render"]);
  assert.deepEqual(state.consumerIds, ["native-uuid", "native-uuid"]);
  assert.equal(state.crypto.randomUUID, state.originalUuid);
});

test("登录失败后恢复输入，重复提交不并发，重试成功后清理登录页", async () => {
  const state = environment(false, { rejectFirstLogin: true });
  vm.runInContext(bundle.outputFiles[0].text, state.context);
  await settle();
  const form = descendant(state.root, node => node.tag === "form");
  const field = descendant(form, node => node.name === "password");
  const reveal = descendant(form, node => node.tag === "button" && node.type === "button");
  const status = descendant(form, node => node.tag === "output");
  field.value = "bootstrap-wrong-password";
  reveal.listeners.get("click")();
  assert.equal(field.type, "text");
  form.listeners.get("submit")({ preventDefault() {} });
  form.listeners.get("submit")({ preventDefault() {} });
  assert.equal(field.disabled, true);
  assert.equal(field.value, "");
  assert.equal(field.type, "password");
  await settle();
  assert.equal(status.textContent, "密码错误");
  assert.equal(field.disabled, false);
  assert.equal(field.attributes.get("aria-invalid"), "true");
  assert.deepEqual(state.consumerIds, []);
  field.value = "bootstrap-correct-password";
  field.listeners.get("input")();
  assert.equal(status.textContent, "");
  form.listeners.get("submit")({ preventDefault() {} });
  await settle();
  assert.equal(state.errors.length, 0);
  assert.deepEqual(state.bootEvents, ["language-sync", "render"]);
  assert.equal(descendant(state.root, node => node.tag === "form"), null);
  assert.equal(form.listeners.has("submit"), false);
  assert.equal(field.listeners.has("input"), false);
  assert.equal(reveal.listeners.has("click"), false);
});
