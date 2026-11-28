import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// RTL 块使用逻辑对齐，并将列表缩进放在对应起始侧。
test("Arabic Markdown blocks get dir=rtl and text-align:start", async () => {
  const styles = await readFile(
    new URL("../src/styles/prose.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.prose-chat p,\s*\.prose-chat li,[\s\S]*?text-align:\s*start/);
  assert.match(styles, /\.prose-chat ul,\s*\.prose-chat ol\s*\{[^}]*padding-inline-start/);

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  try {
    globalThis.document = { documentElement: { dataset: {} } };
    const { Markdown } = await server.ssrLoadModule(
      "/src/components/Markdown.tsx",
    );
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en } },
    });
    const render = (source) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Markdown, { source }),
        ),
      );

    const start = (html) =>
      /style="[^"]*text-align:start/.test(html) ||
      /style="[^"]*text-align: start/.test(html);
    const hasDir = (html, tag, dir) =>
      new RegExp(`<${tag}[^>]*dir="${dir}"`).test(html);
    const noNodeAttr = (html) => !/\snode="/.test(html);

    const arabic = render("مرحبا، هذه فقرة عربية بالكامل.");
    assert.ok(hasDir(arabic, "p", "rtl"), `Arabic paragraph dir missing: ${arabic}`);
    assert.ok(start(arabic), `Arabic paragraph text-align missing: ${arabic}`);
    assert.ok(noNodeAttr(arabic), `hast node leaked to the DOM: ${arabic}`);

    const annotated = render("نعم :codex-annotation{index=\"1\"}\n\nEnglish text.");
    assert.match(annotated, /<p\b[^>]*dir="rtl"[^>]*>نعم\s+<button\b[^>]*data-annotation-index="1"/);
    assert.match(annotated, /<p\b[^>]*dir="ltr"[^>]*>English text\.<\/p>/);

    const mixed = render("hello English paragraph 123!\n\nمرحبا هذه فقرة عربية");
    assert.ok(hasDir(mixed, "p", "ltr") && hasDir(mixed, "p", "rtl"), mixed);
    assert.equal([...mixed.matchAll(/<p\b/g)].length, 2);
    assert.ok(start(mixed), mixed);

    const emphasis = render("**مرحبا** هذه فقرة");
    assert.ok(hasDir(emphasis, "p", "rtl") && start(emphasis), emphasis);

    const heading = render("# عنوان عربي\n\nفقرة عربية");
    assert.ok(hasDir(heading, "h1", "rtl") && hasDir(heading, "p", "rtl"), heading);
    assert.ok(start(heading), heading);
    assert.ok(noNodeAttr(heading), heading);

    const quote = render("> اقتباس عربي");
    assert.ok(hasDir(quote, "blockquote", "rtl") && start(quote), quote);

    const list = render("- عنصر قائمة عربي\n- عنصر ثان");
    assert.ok(hasDir(list, "ul", "rtl") && hasDir(list, "li", "rtl") && start(list), list);
    const ordered = render("3. أول عنصر\n4. ثاني عنصر");
    assert.ok(hasDir(ordered, "ol", "rtl") && hasDir(ordered, "li", "rtl"), ordered);
    assert.match(ordered, /<ol\b[^>]*start="3"/);

    const englishList = render("- First item\n- Second item");
    assert.ok(hasDir(englishList, "ul", "ltr") && hasDir(englishList, "li", "ltr"), englishList);

    const englishOrdered = render("1. First item\n2. Second item");
    assert.ok(hasDir(englishOrdered, "ol", "ltr") && hasDir(englishOrdered, "li", "ltr"), englishOrdered);

    const english = render("Just an English paragraph.");
    assert.ok(hasDir(english, "p", "ltr") && start(english), english);
  } finally {
    globalThis.document = originalDocument;
    await server.close();
  }
});
