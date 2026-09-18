import { readAppSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const globalStyles = await loadStyles();

test("the sidebar keeps a fixed width and only exposes collapse/open chrome", () => {
  assert.match(sidebarSource, /className=\{cx\("sidebar-resize-handle no-drag"/);
  assert.match(sidebarSource, /role="separator"/);
  assert.match(sidebarSource, /aria-orientation="vertical"/);
  assert.match(appSource, /loadSidebarWidth\(\)/);
  assert.doesNotMatch(appSource, /saveSidebarWidth\(nextWidth\)/);
  assert.match(
    globalStyles,
    /\.sidebar-resize-handle\s*\{[\s\S]*?display:\s*none;/,
  );
});

test("sidebar width is shell-owned and the hidden edge has no resize affordance", () => {
  assert.match(appSource, /"--ds-sidebar-width": `\$\{sidebarWidth\}px`/);
  assert.match(globalStyles, /\.sidebar\s*\{[\s\S]*?position:\s*relative/);
  assert.match(
    globalStyles,
    /\.sidebar-resize-handle\s*\{[\s\S]*?display:\s*none;/,
  );
});

test("sidebar hover does not paint a full-height resize rail", () => {
  const marker = globalStyles.match(
    /\.sidebar-resize-handle::after\s*\{[^}]+\}/s,
  )?.[0] ?? "";

  assert.match(marker, /top:\s*50%/);
  assert.match(marker, /height:\s*32px/);
  assert.match(marker, /border-radius:\s*var\(--radius-full\)/);
  assert.match(globalStyles, /\.sidebar-resize-handle:hover::after,/);
  assert.doesNotMatch(globalStyles, /\.sidebar:hover\s+\.sidebar-resize-handle::after/);
  assert.match(
    globalStyles,
    /\.sidebar-resize-handle:focus-visible\s*\{[^}]*outline:\s*none/s,
  );
});

test("the chat reserves one row for shrinking composer controls", () => {
  assert.match(
    globalStyles,
    /\.main-pane\s*\{[\s\S]*?min-width:\s*var\(--ds-main-pane-min-width, 450px\);/,
  );
  assert.match(
    globalStyles,
    /\.composer-toolbar\s*\{[\s\S]*?flex-wrap:\s*nowrap;/,
  );
  assert.match(
    globalStyles,
    /\.composer-left,\s*\.composer-right\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?flex:\s*0 1 auto;/,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.composer-left,\s*\.composer-right\s*\{[^}]*flex:\s*0 0 auto;/,
  );
  assert.match(
    globalStyles,
    /\.mode-chip\s*\{[\s\S]*?white-space:\s*nowrap;/,
  );
  assert.match(
    globalStyles,
    /\.mode-chip > span\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/,
  );
});
