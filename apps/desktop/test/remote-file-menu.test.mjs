import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
function load(source, imports) {
  const module = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)((id) => { assert.ok(id in imports, `unmocked ${id}`); return imports[id]; }, module, module.exports);
  return module.exports;
}
const source = await read("../src/components/FileReference.tsx");
const extensionSource = await read("../src/lib/file-menu-extension.ts");
const settle = () => new Promise(resolve => setImmediate(resolve));

async function menu(remote) {
  const calls = { resolve: [], plugin: [], open: [], reveal: [], close: [], preview: [] };
  const frames = [];
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { documentElement: { dataset: { webRemote: String(remote) } }, body: {}, activeElement: null };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  window.__piDesktopFileMenu = { actions: (context) => [
    { id: "preview", label: "预览", run: async () => calls.plugin.push(["preview", context]) },
    { id: "download", label: "下载", run: async () => calls.plugin.push(["download", context]) },
  ] };
  const state = { activeSessionId: "selected-session", sessions: [{ id: "reference-owner" }], workspace: { path: "/workspace" }, showToast() {} };
  const cells = [];
  const effects = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = initial;
    return [cells[index], (value) => { cells[index] = value; }];
  };
  const jsx = (type, props) => ({ type, props });
  const { FileRefMenu } = load(`${source}\nexport { FileRefMenu };`, {
    react: { useState, useEffect: (callback) => effects.push(callback), useLayoutEffect() {}, useRef: () => ({ current: null }), useCallback: value => value },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "react-dom": { createPortal: node => node },
    "react-i18next": { useTranslation: () => ({ t: key => key }) },
    "../lib/api": { api: {
      fsResolveRef: async (...args) => { calls.resolve.push(args); return { match: { absolutePath: "/workspace/file.txt", root: "workspace", relativePath: "file.txt" } }; },
      fsOpen: async (...args) => calls.open.push(args), fsReveal: async (...args) => calls.reveal.push(args),
    } },
    "../lib/chat-links": { safeDecodeUri: value => value, toWorkspaceRel: value => value },
    "../stores/app-store": { useAppStore: selector => selector(state) },
    "../hooks/use-preview-target": { useOpenChatFileRef: () => (...args) => calls.preview.push(args) },
    "../lib/session-workspace": { sessionWorkspacePath: (_session, path) => path },
    "../lib/file-menu-extension": load(extensionSource, {}),
    "../plugins/renderer-slots/use-slots": { useSlotSessionId: () => "reference-owner" },
    "./ui": { PortalTooltip() {}, useTooltip() {} },
    "./icons": { IconCopy() {}, IconExternal() {}, IconFileText() {}, IconFolderOpen() {}, IconPanelOpen() {}, IconDownload() {} },
  });
  const render = () => {
    cursor = 0;
    const tree = FileRefMenu({ rawRef: "@file.txt:12", position: { x: 10, y: 10 }, onClose: (...args) => calls.close.push(args) });
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  render();
  await settle();
  const tree = render();
  const items = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "button") items.push(node);
    for (const child of [node.props?.children].flat(Infinity)) visit(child);
  }
  visit(tree);
  return { calls, items, frames, label: item => [item.props.children].flat(Infinity).filter(value => typeof value === "string").join("") };
}

test("远控与侧栏文件菜单由插件置顶预览和下载，动作捕获引用所属会话", async () => {
  const state = await menu(true);
  assert.deepEqual(state.items.slice(0, 3).map(state.label), ["预览", "下载", "chat.fileMenuCopyContent"]);
  assert.deepEqual(state.calls.resolve[0], ["file.txt", "reference-owner"]);
  state.items[1].props.onClick();
  assert.equal(state.calls.plugin.length, 0, "等待菜单关闭及焦点恢复后再运行动作");
  state.frames.shift()();
  await settle();
  assert.deepEqual(state.calls.plugin, [["download", { path: "/workspace/file.txt", sessionId: "reference-owner" }]]);
  const open = state.items.find(item => state.label(item) === "chat.openFile");
  open.props.onClick(); state.frames.shift()(); await settle();
  assert.deepEqual(state.calls.open, [["/workspace/file.txt", undefined, "reference-owner"]]);
});

test("桌面菜单继续使用原有预览动作，不显示远端下载扩展", async () => {
  const state = await menu(false);
  assert.equal(state.label(state.items[0]), "chat.previewFile");
  assert.equal(state.items.some(item => state.label(item) === "下载"), false);
  state.items[0].props.onClick();
  assert.deepEqual(state.calls.preview, [["/workspace/file.txt"]]);
  assert.deepEqual(state.calls.plugin, []);
});
