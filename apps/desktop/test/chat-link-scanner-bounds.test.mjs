import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatLinkScanBudget,
  scanChatLinkCandidates,
} from "../src/lib/chat-link-scanner.ts";
import { linkifyMdastTree, splitChatText } from "../src/lib/chat-links.ts";

const ROOT = "/Users/dev/project";
const targets = (segments) => segments.filter((segment) => segment.kind === "target");

test("file candidates stop at 512 UTF-16 units without linking a suffix", () => {
  const max = `${"a".repeat(509)}.ts`;
  const over = `${"b".repeat(510)}.ts`;
  assert.equal(max.length, 512);
  assert.equal(over.length, 513);

  const accepted = splitChatText(`${max} ${over} safe.ts`, ROOT);
  assert.deepEqual(targets(accepted).map((segment) => segment.text), [max, "safe.ts"]);
  assert.equal(accepted.map((segment) => segment.text).join(""), `${max} ${over} safe.ts`);
});

test("long URLs remain eligible under the independent URL limit", () => {
  const url = `https://example.com/${"x".repeat(700)}.md`;
  const source = `See ${url} now`;
  const linked = targets(splitChatText(source, ROOT));
  assert.equal(linked.length, 1);
  assert.equal(linked[0].text, url);
});

test("the file candidate and link caps are independent and reconstruct source", () => {
  const source = Array.from({ length: 600 }, (_, index) => `file${index}.ts`).join(" ");
  const budget = createChatLinkScanBudget();
  const scan = scanChatLinkCandidates(source, budget, () => null, () => "accept");
  assert.equal(scan.stats.fileCandidateCount, 512);
  assert.equal(scan.stats.linkCount, 0);

  const linked = splitChatText(Array.from({ length: 400 }, (_, i) => `f${i}.ts`).join(" "), ROOT);
  assert.equal(targets(linked).length, 256);
  assert.equal(linked.map((segment) => segment.text).join(""), Array.from({ length: 400 }, (_, i) => `f${i}.ts`).join(" "));
});

test("Markdown text nodes in one tree share scan work while later trees get fresh budgets", () => {
  const source = "x".repeat(131_000);
  const firstTree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [
        { type: "text", value: source },
        { type: "text", value: " safe.ts" },
      ],
    }],
  };
  linkifyMdastTree(firstTree, ROOT);
  assert.equal(firstTree.children[0].children[1].type, "text");

  const nextTree = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value: "safe.ts" }] }],
  };
  linkifyMdastTree(nextTree, ROOT);
  assert.equal(nextTree.children[0].children[0].type, "link");
});

test("CRLF and Unicode source survive bounded linkification unchanged", () => {
  const source = "查看 报告.pdf\r\n😀 and docs/规范/架构.md";
  const linked = splitChatText(source, ROOT);
  assert.deepEqual(targets(linked).map((segment) => segment.text), ["报告.pdf", "docs/规范/架构.md"]);
  assert.equal(linked.map((segment) => segment.text).join(""), source);
});
