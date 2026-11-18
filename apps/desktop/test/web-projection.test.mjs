import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { build, transformSync } = createRequire(require.resolve("vite/package.json"))("esbuild");
const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const responsiveSource = source("styles/responsive.css");
class ProjectionEvent extends Event {
  constructor(type, { detail } = {}) { super(type); this.detail = detail; }
}
const projectionModule = { exports: {} };
vm.runInNewContext(transformSync(source("lib/web-projection.ts"), { loader: "ts", format: "cjs" }).code, {
  module: projectionModule, exports: projectionModule.exports, CustomEvent: ProjectionEvent,
});
const { webProjectionEnabled, projectionLayerFor, projectionNavigationLayer, listenProjectionNavigation, publishProjectionState } = projectionModule.exports;

test("只有远控桥和插件投影同时启用才改变展示", () => {
  for (const webRemote of [undefined, "false", "true"]) {
    for (const lanProjection of [undefined, "false", "true"]) {
      assert.equal(webProjectionEnabled({ webRemote, lanProjection }), webRemote === "true" && lanProjection === "true");
    }
  }
});

test("层级由原生侧栏与右栏呈现状态决定，左栏优先", () => {
  for (const collapsed of [false, true]) {
    for (const open of [false, true]) {
      for (const exiting of [false, true]) {
        assert.equal(projectionLayerFor(collapsed, open, exiting), !collapsed ? "projects" : open || exiting ? "workpanel" : "chat");
      }
    }
  }
});

test("导航只接受三个已知层级，忽略缺失或未知值", () => {
  for (const layer of ["projects", "chat", "workpanel"]) assert.equal(projectionNavigationLayer({ detail: { layer } }), layer);
  for (const detail of [undefined, null, {}, { layer: "settings" }, { layer: 1 }]) assert.equal(projectionNavigationLayer({ detail }), null);
});

test("先注册导航再发布初态，首次同步 history 恢复不会丢失", () => {
  const historySource = source("features/app/useCompactHistory.ts");
  const listen = historySource.indexOf("listenProjectionNavigation(window");
  assert.ok(listen >= 0 && listen < historySource.indexOf("publishProjectionState(window"));
  const target = new EventTarget();
  const requests = [];
  const cleanup = listenProjectionNavigation(target, { ready: true, layer: "projects", page: "chat" }, layer => { requests.push(layer); return true; });
  let restoring = true;
  target.addEventListener("pi-desktop:projection-state", () => {
    if (restoring) {
      restoring = false;
      target.dispatchEvent(new ProjectionEvent("pi-desktop:projection-navigate", { detail: { layer: "chat" } }));
    }
  });
  publishProjectionState(target, { ready: true, layer: "projects", page: "chat" });
  assert.deepEqual(requests, ["chat"]);
  cleanup();
});

test("无会话的三级恢复回报实际层级，同层导航也回执且不修改状态", () => {
  const target = new EventTarget();
  const actual = { ready: true, layer: "chat", page: "chat" };
  let requests = 0;
  const cleanup = listenProjectionNavigation(target, actual, () => { requests++; return false; });
  const replies = [];
  let applyingHistory = false;
  target.addEventListener("pi-desktop:projection-state", event => {
    replies.push(event.detail);
    applyingHistory = false;
  });
  applyingHistory = true;
  target.dispatchEvent(new ProjectionEvent("pi-desktop:projection-navigate", { detail: { layer: "workpanel" } }));
  assert.equal(applyingHistory, false);
  assert.deepEqual(JSON.parse(JSON.stringify(replies[0])), { ...actual, navigationRejected: true });
  target.dispatchEvent(new ProjectionEvent("pi-desktop:projection-navigate", { detail: { layer: "chat" } }));
  assert.equal(requests, 1);
  assert.equal(replies.length, 2);
  cleanup();
  target.dispatchEvent(new ProjectionEvent("pi-desktop:projection-navigate", { detail: { layer: "workpanel" } }));
  assert.equal(requests, 1);
});

const shellSource = source("features/app/AppShell.tsx");
const fixtures = new Map([
  ["react", 'export const lazy = () => "LazyPage"; export const Suspense = "Suspense"; export const useState = initial => [initial, () => {}]; export const useRef = initial => globalThis.refs[globalThis.refIndex++] ??= { current: initial };'],
  ["react/jsx-runtime", 'export const Fragment = "Fragment"; export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;'],
  ["./useAppShellRuntime", 'export const useAppShellRuntime = () => globalThis.runtime;'],
  ["../../components/ui", 'export const cx = (...values) => values.filter(Boolean).join(" "); export const TooltipButton = "TooltipButton";'],
  ["../../hooks/use-copy-tex", 'export const useCopyTex = () => {};'],
]);
for (const match of shellSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
  const [, names, path] = match;
  if (fixtures.has(path)) continue;
  fixtures.set(path, names.split(",").map(value => value.trim()).filter(value => value && !value.startsWith("type ")).map(name => `export const ${name} = ${JSON.stringify(name)};`).join("\n"));
}
for (const page of ["Settings", "PullRequests", "Scheduled", "Plugins"]) fixtures.set(`../../pages/${page}Page`, `export const ${page}Page = "${page}Page";`);
const shellBundle = await build({
  entryPoints: [fileURLToPath(new URL("../src/features/app/AppShell.tsx", import.meta.url))],
  bundle: true, write: false, format: "iife", globalName: "Shell", platform: "browser", jsx: "automatic", logLevel: "silent",
  plugins: [{ name: "projection-shell-boundary", setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, ({ path }) => fixtures.has(path) ? { path, namespace: "fixture" } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: fixtures.get(path), loader: "js" }));
  } }],
});
const context = vm.createContext({});
vm.runInContext(shellBundle.outputFiles[0].text, context);
function render(overrides = {}, { retain = false } = {}) {
  if (!retain) context.refs = [];
  context.refIndex = 0;
  context.runtime = {
    ready: true, page: "chat", compact: true, compactLayer: "projects",
    sidebarCollapsed: false, sidebarWidth: 275, workPanelMaximized: false,
    t: key => key, ...overrides,
  };
  return context.Shell.AppShell();
}
function nodes(root, predicate, parents = [], path = "root") {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap((item, index) => nodes(item, predicate, parents, `${path}/${index}`));
  return [
    ...(predicate(root) ? [{ node: root, parents, path }] : []),
    ...nodes(root.props?.children, predicate, [...parents, root], `${path}/children`),
  ];
}
const byType = (tree, type) => nodes(tree, node => node.type === type);
const mainPane = (tree) => nodes(tree, node => node.props?.className === "main-pane")[0];
const visibility = (entry) => entry.parents.filter(node => node.type === "PortalVisibilityProvider").every(node => node.props.visible);

test("共用紧凑层切换和路由切换始终保留同一位置的 ChatSurface 与 Sidebar", () => {
  let chatPath;
  let sidebarPath;
  for (const layer of ["projects", "chat", "workpanel"]) {
    for (const page of ["chat", "plugins", "scheduled", "settings"]) {
      const tree = render({ compactLayer: layer, page, sidebarCollapsed: layer !== "projects", workPanelMaximized: true, presentedWorkPanelOpen: layer === "workpanel" });
      assert.equal(tree.props["data-compact-layout"], "true");
      assert.equal(tree.props["data-compact-layer"], layer);
      assert.ok(!("data-projection-layer" in tree.props));
      const chats = byType(tree, "ChatSurface");
      const sidebars = byType(tree, "Sidebar");
      assert.equal(chats.length, 1);
      assert.equal(sidebars.length, 1);
      chatPath ??= chats[0].path;
      sidebarPath ??= sidebars[0].path;
      assert.equal(chats[0].path, chatPath);
      assert.equal(sidebars[0].path, sidebarPath);
      assert.equal(chats[0].node.props.visible, page === "chat" && layer === "chat");
      assert.equal(mainPane(tree).node.props.inert, layer !== "chat" ? true : undefined);
      assert.equal(mainPane(tree).node.props["aria-hidden"], layer !== "chat" ? true : undefined);
      assert.equal(visibility(chats[0]), page !== "settings" && layer === "chat");
      assert.equal(visibility(sidebars[0]), page !== "settings" && layer === "projects");
      assert.equal(sidebars[0].node.props.inactive, layer !== "projects");
      assert.equal(sidebars[0].node.props.compact, true);
      if (page === "settings") assert.equal(byType(tree, "LazyPage")[0].node.props.compact, true);
    }
  }
});

test("紧凑右栏使用原 WorkPanel 的全宽预算并禁用自动侧栏回弹", () => {
  const tree = render({ compactLayer: "workpanel", sidebarCollapsed: true, presentedWorkPanelOpen: true });
  const panel = byType(tree, "WorkPanel")[0];
  assert.equal(panel.node.props.maximized, true);
  assert.equal(panel.node.props.onAutoCollapseSidebar, undefined);
  assert.equal(panel.node.props.compact, true);
  assert.equal(visibility(panel), true);
});

test("三级返回二级与一级保留同一原 WorkPanel，并阻断隐藏面板及 Portal", () => {
  const unopened = render();
  assert.equal(byType(unopened, "WorkPanel").length, 0);
  const opened = render({ compactLayer: "workpanel", sidebarCollapsed: true, presentedWorkPanelOpen: true }, { retain: true });
  const original = byType(opened, "WorkPanel")[0];
  assert.equal(original.node.props.inactive, false);
  for (const layer of ["chat", "projects", "workpanel"]) {
    const tree = render({ compactLayer: layer, sidebarCollapsed: layer !== "projects", presentedWorkPanelOpen: layer === "workpanel" }, { retain: true });
    const retained = byType(tree, "WorkPanel")[0];
    assert.equal(retained.path, original.path);
    assert.equal(retained.node.props.inactive, layer !== "workpanel");
    assert.equal(retained.node.props.panelBlocked, layer !== "workpanel");
    assert.equal(visibility(retained), layer === "workpanel");
  }
  render({ compact: false, presentedWorkPanelOpen: true });
  assert.equal(byType(render({ compact: false }, { retain: true }), "WorkPanel").length, 0);
});

test("桌面保留原挂载、最大化和宽度回调路径", () => {
  const autoCollapseSidebar = () => {};
  const desktop = render({ compact: false, sidebarCollapsed: true, autoCollapseSidebar, presentedWorkPanelOpen: true });
  assert.equal(desktop.props["data-compact-layer"], undefined);
  assert.equal(byType(desktop, "Sidebar").length, 0);
  assert.equal(byType(desktop, "ChatSurface").length, 1);
  const panel = byType(desktop, "WorkPanel")[0].node;
  assert.equal(panel.props.maximized, false);
  assert.equal(panel.props.onAutoCollapseSidebar, autoCollapseSidebar);
  const maximized = render({ compact: false, workPanelMaximized: true });
  assert.equal(mainPane(maximized), undefined);
  assert.equal(byType(maximized, "ChatSurface").length, 0);
});

test("桌面窄窗切层保留普通聊天与已打开面板，隐藏层阻断交互和 Portal", () => {
  const showCompactChat = () => {};
  const toggleSidebar = () => {};
  const wide = render({ compact: false, sidebarCollapsed: true, presentedWorkPanelOpen: true });
  const chatPath = byType(wide, "ChatSurface")[0].path;
  const panelPath = byType(wide, "WorkPanel")[0].path;
  for (const layer of ["workpanel", "chat", "projects", "chat"]) {
    const tree = render({ compactLayer: layer, sidebarCollapsed: true, showCompactChat, toggleSidebar }, { retain: true });
    const chat = byType(tree, "ChatSurface")[0];
    const panel = byType(tree, "WorkPanel")[0];
    const sidebar = byType(tree, "Sidebar")[0];
    assert.equal(tree.props["data-compact-layout"], "true");
    assert.equal(tree.props["data-compact-layer"], layer);
    assert.equal(chat.path, chatPath);
    assert.equal(panel.path, panelPath);
    assert.equal(chat.node.props.visible, layer === "chat");
    assert.equal(mainPane(tree).node.props.inert, layer !== "chat" ? true : undefined);
    assert.equal(visibility(chat), layer === "chat");
    assert.equal(panel.node.props.inactive, layer !== "workpanel");
    assert.equal(panel.node.props.panelBlocked, layer !== "workpanel");
    assert.equal(visibility(panel), layer === "workpanel");
    assert.equal(sidebar.node.props.inactive, layer !== "projects");
    assert.equal(visibility(sidebar), layer === "projects");
    assert.equal(sidebar.node.props.onOpenConversation, showCompactChat);
    assert.equal(sidebar.node.props.onToggleSidebar, showCompactChat);
    assert.equal(byType(tree, "ConversationTopbar")[0].node.props.compact, true);
    assert.equal(byType(tree, "ConversationTopbar")[0].node.props.onToggleSidebar, toggleSidebar);
    if (layer === "workpanel") {
      const back = nodes(tree, node => node.props?.className === "compact-panel-back title-nav-btn no-drag")[0];
      assert.equal(back.node.props.onClick, showCompactChat);
    }
  }
  const settings = render({ compactLayer: "chat", page: "settings" }, { retain: true });
  assert.equal(mainPane(settings).node.props["aria-hidden"], undefined);
  assert.equal(visibility(byType(settings, "ChatSurface")[0]), false);
  const restored = render({ compact: false, sidebarCollapsed: true, presentedWorkPanelOpen: true }, { retain: true });
  assert.equal(byType(restored, "ChatSurface")[0].path, chatPath);
  assert.equal(byType(restored, "WorkPanel")[0].path, panelPath);
});

test("接缝涉及的 TSX 文件可独立解析", () => {
  for (const path of ["components/Sidebar.tsx", "components/workpanel/WorkPanel.tsx", "components/remote/RemoteWorkspace.tsx", "features/app/useAppShellRuntime.tsx"]) {
    assert.doesNotThrow(() => transformSync(source(path), { loader: "tsx", jsx: "automatic" }));
  }
});

test("紧凑布局打开其他页面时整块隐藏保留的聊天区，返回聊天恢复原布局", () => {
  for (const page of ["chat", "plugins", "scheduled", "pulls", "settings"]) {
    const tree = render({ page, compactLayer: "chat", sidebarCollapsed: true });
    const chat = byType(tree, "ChatSurface")[0];
    const container = chat.parents.at(-1);
    assert.equal(container.props.hidden, page !== "chat");
    assert.equal(container.props.style?.display, page === "chat" ? "contents" : undefined);
  }
});

test("主程序窄容器统一把模式、权限和模型控件收缩为图标", () => {
  assert.match(responsiveSource, /@container composer-stack \(max-width: 450px\)/);
  for (const selector of [".composer-mode-chip-label", ".composer-permission > .mode-chip > .text-sm", ".composer-model-thinking-model", ".composer-model-thinking-level"]) {
    assert.match(responsiveSource, new RegExp(selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));
  }
  assert.match(responsiveSource, /\.composer-permission-icon/);
  assert.match(responsiveSource, /width: 28px !important/);
});
