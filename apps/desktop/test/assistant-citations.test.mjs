import { register } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { remarkAssistantCitations } = await import("../src/lib/assistant-citations.ts");
const { advanceMarkdownBlocks, emptyMarkdownBlockCache, markdownRemarkPlugins } = await import("../src/lib/markdown-blocks.ts");

const marker = "\uE200cite\uE202turn815440view1\uE201";
function render(source, citations = [], sourceOffset = 0, assistant = true) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [...markdownRemarkPlugins, ...(assistant ? [[remarkAssistantCitations, { source, sourceOffset, citations }]] : [])],
    rehypePlugins: [rehypeSanitize],
    children: source,
  }));
}

test("provider positions render numbered citations without exposing internal IDs", () => {
  const source = `😀正文。${marker} 后续`;
  const startIndex = source.indexOf(marker);
  const citations = [
    { url: "https://example.test/one", title: "资料一", startIndex, endIndex: startIndex + marker.length },
    { url: "https://example.test/two", title: "资料二", startIndex, endIndex: startIndex + marker.length },
  ];
  const html = render(source, [...citations, citations[0]]);
  assert.match(html, /href="https:\/\/example.test\/one" title="资料一">\[1\]<\/a>/);
  assert.match(html, /href="https:\/\/example.test\/two" title="资料二">\[2\]<\/a>/);
  assert.equal((html.match(/href=/g) ?? []).length, 2);
  assert.doesNotMatch(html, /turn815440|\uE200|\uE201/);
});

test("legacy and incomplete streaming citations disappear without guessed links", () => {
  const source = `结论。${marker}`;
  for (let i = 1; i <= marker.length; i++) {
    const html = render(`结论。${marker.slice(0, i)}`);
    assert.match(html, /结论。/);
    assert.doesNotMatch(html, /turn815440|\uE200|\uE201|href=/);
  }
  assert.doesNotMatch(render(source, [{ url: "https://example.test/source" }]), /href=/);
  assert.doesNotMatch(render(source, [{ url: "javascript:alert(1)", startIndex: 3, endIndex: source.length }]), /href=/);
  assert.match(render(source, [], 0, false), /turn815440/);
});

test("code examples, user content and existing links stay intact", () => {
  for (const source of [`\`${marker}\``, `\`\`\`text\n${marker}\n\`\`\``, `[${marker}](https://example.test/existing)`]) {
    assert.match(render(source), /turn815440/);
  }
  assert.match(render(`正文${marker}正常结尾`), /正文正常结尾/);
});

test("citations keep their global positions across Markdown blocks", () => {
  const source = `第一段。\n\n第二段${marker}\n\n第三段。`;
  const startIndex = source.indexOf(marker);
  const citations = [{ url: "https://example.test/source", startIndex, endIndex: startIndex + marker.length }];
  const cache = advanceMarkdownBlocks(emptyMarkdownBlockCache, source);
  let offset = 0;
  const html = cache.blocks.map((block) => {
    const rendered = render(block, citations, offset);
    offset += block.length;
    return rendered;
  }).join("");
  assert.equal(html, render(source, citations));
  assert.match(html, /href="https:\/\/example.test\/source"/);
});

test("ordinary annotated text is linked without dropping or renaming it", () => {
  const source = "正文[1] 后续";
  const html = render(source, [{ url: "https://example.test/source", startIndex: 2, endIndex: 5 }]);
  assert.match(html, /href="https:\/\/example.test\/source"[^>]*>\[1\]<\/a>/);
  assert.match(html, /后续/);
});

test("unclosed markers preserve following prose and soft line breaks", () => {
  for (const suffix of [" 后续正文", "后续正文", "\n后续正文"]) {
    const html = render(`结论。${marker.slice(0, -1)}${suffix}`);
    assert.match(html, /后续正文/);
    assert.doesNotMatch(html, /turn815440|\uE200/);
  }
});

test("raw source offsets survive escapes, entities and repeated markers", () => {
  const source = `\\* &amp; ${marker} 再次 ${marker}`;
  const citations = [source.indexOf(marker), source.lastIndexOf(marker)].map((startIndex, index) => ({
    url: `https://example.test/${index}`, startIndex, endIndex: startIndex + marker.length,
  }));
  const html = render(source, citations);
  assert.match(html, /href="https:\/\/example.test\/0"/);
  assert.match(html, /href="https:\/\/example.test\/1"/);
  assert.doesNotMatch(html, /turn815440/);
});

test("ordinary prose is never linked from an unverified character range", () => {
  const html = render("普通句子", [{ url: "https://example.test/source", startIndex: 0, endIndex: 2 }]);
  assert.match(html, /普通句子/);
  assert.doesNotMatch(html, /href=/);
});
