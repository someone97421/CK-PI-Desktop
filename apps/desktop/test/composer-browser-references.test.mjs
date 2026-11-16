import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  browserInsertionReferences,
  browserReferenceForChip,
  browserReferenceTooltip,
  checkedBrowserReferenceMark,
  clampBrowserInsertionRange,
  filterBrowserReferenceTabs,
} = await import("../src/features/chat/composer/browser-references.ts");
const { placePluginMark } = await import("../src/features/chat/composer/plugins/plugin-marks.ts");
const { serializeInlineComposerFileReferences } = await import("@pi-desktop/shared");
const { attachImageTokens } = await import("../src/features/chat/composer/image-attachments.ts");
const { createFileReference, nextChipToken } = await import("../src/features/chat/composer/editor.ts");

const page = { kind: "page", tabId: 7, title: "文档页面", url: "https://example.test/docs" };
const element = {
  tag: "button", role: "button", name: "保存", locator: "#save", text: "保存更改",
  attributes: ['id="save"', 'type="submit"'], context: "设置表单", html: '<button id="save">保存更改</button>',
  pageTitle: "设置页面", pageUrl: "https://example.test/settings", size: "80 × 32",
};

test("页面、选文和 DOM 引用沿现有 mark 发送并保留完整内容", () => {
  for (const reference of [
    page,
    { ...page, kind: "selection", selection: "首行\n完整的第二行 🦖" },
    { ...page, kind: "element", element },
  ]) {
    const mark = checkedBrowserReferenceMark(reference);
    const placed = placePluginMark([], "", mark, "session");
    const chip = placed.references[0];
    assert.equal(chip.plugin.kind, "mark");
    assert.deepEqual(browserReferenceForChip(chip), reference);
    const sent = serializeInlineComposerFileReferences(placed.token, placed.references);
    assert.ok(sent.includes(mark.send));
    assert.ok(Array.from(mark.label).length <= 64);
  }
});

test("长标签使用现有字符限制，发送正文保留换行、emoji 与私有字符", () => {
  const reference = { ...page, kind: "selection", selection: `\ue001\ufffc${"🦖".repeat(100)}\n尾部文字` };
  const mark = checkedBrowserReferenceMark(reference);
  assert.ok(Array.from(mark.label).length <= 64);
  const placed = placePluginMark([], "", mark, "session");
  assert.deepEqual(browserReferenceForChip(placed.references[0]), reference);
});

test("无效或超限引用明确失败，调用方尚未替换选区", () => {
  assert.throws(() => checkedBrowserReferenceMark({ ...page, kind: "selection", selection: "" }), /无效/);
  assert.throws(() => checkedBrowserReferenceMark({ ...page, kind: "selection", selection: "中".repeat(12000) }), /32 KiB/);
  assert.throws(() => checkedBrowserReferenceMark({ ...page, kind: "element" }), /无效/);
});

test("tooltip 完整展示选文、DOM 属性、上下文与子框架地址", () => {
  const selection = { ...page, kind: "selection", selection: "第一行\n第二行", frameUrl: "https://example.test/frame" };
  assert.ok(browserReferenceTooltip(selection).includes("第一行\n第二行"));
  assert.ok(browserReferenceTooltip(selection).includes(selection.frameUrl));
  const tooltip = browserReferenceTooltip({ ...page, kind: "element", element });
  for (const value of [page.url, element.locator, element.text, element.html, element.context, ...element.attributes, element.size, element.pageUrl]) {
    assert.ok(tooltip.includes(value), value);
  }
});

test("普通插件 mark 不会被误判成浏览器引用", () => {
  const chip = placePluginMark([], "", { pluginId: "other.plugin", label: "标签", send: checkedBrowserReferenceMark(page).send }, "session").references[0];
  assert.equal(browserReferenceForChip(chip), null);
});

test("标签页按真实标题或 URL 检索并保留不同来源的相同 tabId", () => {
  const tabs = [
    { ...page, sourceId: "browser-a" },
    { ...page, title: "API Reference", url: "https://api.test/reference", sourceId: "browser-b" },
  ];
  assert.deepEqual(filterBrowserReferenceTabs(tabs, ""), tabs);
  assert.deepEqual(filterBrowserReferenceTabs(tabs, "API reference"), [tabs[1]]);
  assert.deepEqual(filterBrowserReferenceTabs(tabs, "文档"), [tabs[0]]);
  assert.deepEqual(filterBrowserReferenceTabs(tabs, "missing"), []);
});

test("缓存选区保留替换范围，过期位置收敛，首次插入默认末尾", () => {
  assert.deepEqual(clampBrowserInsertionRange({ start: 2, end: 6 }, 10), { start: 2, end: 6 });
  assert.deepEqual(clampBrowserInsertionRange({ start: 20, end: 30 }, 10), { start: 10, end: 10 });
  assert.deepEqual(clampBrowserInsertionRange({ start: -2, end: 6 }, 4), { start: 0, end: 4 });
  assert.deepEqual(clampBrowserInsertionRange(null, 10), { start: 10, end: 10 });
});

test("被浏览器引用替换的图片 chip 不会被附件恢复重新插回", () => {
  const removed = createFileReference("/removed.png", "removed.png", "session", { kind: "image", token: "\ue010" });
  const kept = createFileReference("/kept.png", "kept.png", "session", { kind: "image", token: "\ue011" });
  const other = createFileReference("/other.png", "other.png", "other", { kind: "image", token: "\ue012" });
  const retained = browserInsertionReferences([removed, kept, other], "前文\ue011后文", "session");
  assert.deepEqual(retained, [kept, other]);
  const restored = attachImageTokens("前文\ue011后文", retained.filter(reference => reference.sessionId === "session"), nextChipToken);
  assert.equal(restored.text, "前文\ue011后文");
  assert.deepEqual(restored.references, [kept]);
});
