/**
 * Session references in the transcript (issue #1324): the chip a user message
 * shows for `pi-desktop://session/<id>`, and the two prompt paths that must not
 * hand a referenced conversation to the file-attachment resolver.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { catalogs } from "@pi-desktop/i18n";
import { formatSessionLink, isRenderableAttachment } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The shipped catalogs answer `t`, so the assertions read real wording. */
let locale = "en";
const t = (key, values) => {
  const raw = key
    .split(".")
    .reduce(
      (node, part) => (node && typeof node === "object" ? node[part] : undefined),
      catalogs[locale],
    );
  if (typeof raw !== "string") return key;
  return values
    ? raw.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values[name] ?? ""))
    : raw;
};

/** The chip reads the live conversation title from the store, like the app. */
const store = { selectSession: async () => {}, sessions: [] };
const useAppStore = (selector) => selector(store);

const Icon = () => React.createElement("svg", { "aria-hidden": true });

/**
 * The modules below render through the repository's own transpile-and-stub
 * pattern: the real component source, with its surroundings replaced.
 */
function load(file, imports) {
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unmocked dependency ${id} of ${file.pathname}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

const shared = load(new URL("../src/features/chat/transcript/shared.tsx", import.meta.url), {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-i18next": { useTranslation: () => ({ t, i18n: { language: locale } }) },
  "@pi-desktop/shared": await import("@pi-desktop/shared"),
  "./disclosure": {},
  "../../../hooks/use-preview-target": {
    useOpenChatFileRef: () => () => {},
    useOpenPreviewTarget: () => undefined,
  },
  "../../../hooks/use-chat-file-menu": { useChatFileMenu: () => ({}) },
  "../../../hooks/use-verified-chat-text": {
    useVerifiedChatText: (text) => [{ kind: "text", text: String(text ?? "") }],
  },
  "../../../components/ContextMenu": { ContextMenu: () => null },
  "../../../components/Markdown": {
    Markdown: ({ source }) => source,
    useCopy: () => ({ copied: false, copy: () => {} }),
  },
  "../../../components/icons": new Proxy({}, { get: () => Icon }),
  "../../../components/ui": {
    TooltipButton: ({ ariaLabel, tooltip, ...props }) =>
      React.createElement("button", { ...props, "aria-label": ariaLabel ?? tooltip }),
  },
  "../../../lib/disclosure-anchor-context": { useDisclosureAnchorNotifier: () => {} },
  "../../../lib/turn-process": { isThinkingActive: () => false, resolveThinkingDisplayMode: () => "none" },
  "../../../lib/transcript-search-context": { TranscriptSearchContext: React.createContext(null) },
  "../../../lib/assistant-turns": { messageThinking: () => "" },
  "../../../lib/use-referenced-image-data-url": { useReferencedImageDataUrl: () => undefined },
  "../../../lib/chat-links": { isHtmlFilePath: () => false },
  "../../../lib/context-usage": { calculateTokenRate: () => 0 },
  "../../../stores/app-store": { useAppStore },
});

const { MessageRow } = load(new URL("../src/features/chat/transcript/MessageRow.tsx", import.meta.url), {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-i18next": { useTranslation: () => ({ t, i18n: { language: locale } }) },
  "@pi-desktop/shared": await import("@pi-desktop/shared"),
  "../../../hooks/use-preview-target": { useOpenChatFileRef: () => () => {} },
  "../../../lib/chat-links": { splitChatText: () => [] },
  "../../../components/Markdown": { Markdown: ({ source }) => source },
  "../../../components/icons": new Proxy({}, { get: () => Icon }),
  "../../../components/ui": {
    TooltipButton: ({ ariaLabel, tooltip, ...props }) =>
      React.createElement("button", { ...props, "aria-label": ariaLabel ?? tooltip }),
  },
  "../../../stores/app-store": { useAppStore },
  "../../../plugins/renderer-slots/slot-message": { slotMessage: () => undefined },
  "./menu-items": { userMessageMenuItems: () => [] },
  "./ActionBarSlots": { ActionSlotSide: () => null },
  "./SessionMessageOrigin": { SessionMessageOrigin: () => null },
  "./TranscriptMenu": {
    useTranscriptMenu: () => () => {},
    useChatTextActions: () => ({ copyText: () => {}, selectText: () => {} }),
  },
  "./shared": shared,
});

const referenced = {
  kind: "session",
  name: "Nightly review",
  ref: "session-a",
  text: 'Referenced conversation "Nightly review" (session-a).\n\nuser: ship it',
};

const userMessage = {
  id: "user-row",
  role: "user",
  content: `continue from ${formatSessionLink("session-a")}`,
  status: "complete",
  createdAt: "2026-09-26T10:00:00.000Z",
  attachments: [referenced],
};

const renderChip = () =>
  renderToStaticMarkup(React.createElement(shared.SessionRefChip, { attachment: referenced }));
const renderRow = (message) =>
  renderToStaticMarkup(React.createElement(MessageRow, { message, isRunning: false }));

test("a referenced conversation renders as a chip naming its own target", () => {
  locale = "en";
  store.sessions = [];
  const html = renderChip();
  assert.match(html, /data-action="open-session-reference"/);
  assert.match(html, /data-session-id="session-a"/);
  assert.match(
    read("../src/features/chat/transcript/shared.tsx"),
    /onClick=\{\(\) => void selectSession\(attachment\.ref\)\.catch\(\(\) => undefined\)\}/,
    "activating the chip opens the referenced conversation",
  );
  assert.ok(
    html.includes(`${catalogs.en.chat.sessionReference} · Nightly review`),
    "the chip names the reference from the catalog",
  );
  assert.ok(
    html.includes(`title="${catalogs.en.chat.sessionReferenceOpen.replace("{{title}}", "Nightly review")}"`),
    "the tooltip says what opening it does",
  );
  assert.doesNotMatch(html, /pi-desktop:\/\/session\//, "the raw link is the message's, not the chip's");
});

test("the chip speaks the reader's language", () => {
  locale = "zh-CN";
  store.sessions = [];
  const html = renderChip();
  assert.match(html, /会话引用 · Nightly review/);
  assert.match(html, /title="打开会话 Nightly review"/);
  assert.match(html, /aria-label="会话引用 · Nightly review"/);
});

test("a renamed conversation follows through to every message that references it", () => {
  locale = "zh-CN";
  store.sessions = [{ id: "session-a", title: "依赖清理顺序（改名后）" }];
  const renamed = renderChip();
  assert.match(renamed, /会话引用 · 依赖清理顺序（改名后）/);
  assert.match(renamed, /title="打开会话 依赖清理顺序（改名后）"/);
  assert.doesNotMatch(renamed, /Nightly review/, "the pasted name does not survive a rename");

  store.sessions = [{ id: "session-b", title: "另一段对话" }];
  assert.match(
    renderChip(),
    /会话引用 · Nightly review/,
    "an unlisted conversation keeps the name recorded on the message",
  );
  assert.doesNotMatch(renderChip(), /另一段对话/, "another conversation's title is not borrowed");

  store.sessions = [{ id: "session-a", title: "  " }];
  assert.match(
    renderChip(),
    /会话引用 · Nightly review/,
    "an empty title falls back to the recorded name",
  );
  store.sessions = [];
});

test("a user message shows the reference next to its own words", () => {
  locale = "en";
  const html = renderRow(userMessage);
  assert.match(html, /class="message-attachments"/);
  assert.match(html, /data-action="open-session-reference"/);
  assert.match(html, /data-session-id="session-a"/);
  assert.ok(
    html.includes(formatSessionLink("session-a")),
    "the link text stays in the message: it is what main re-resolves",
  );
});

test("a referenced conversation is not rendered as a file chip", () => {
  locale = "en";
  const withFile = {
    ...userMessage,
    attachments: [referenced, { kind: "file", name: "notes.md", ref: "/p/notes.md" }],
  };
  const html = renderRow(withFile);
  assert.match(html, /data-action="open-session-reference"/, "the reference keeps its own chip");
  assert.match(html, /aria-label="notes\.md — \/p\/notes\.md"/, "an ordinary file attachment is untouched");
  assert.equal(html.match(/chat-file-chip/g).length, 2, "two attachments, two chips");
});

test("a referenced conversation never reaches the file-attachment resolver", async () => {
  const { promptAttachmentsFromMessage } = await import(
    "../src/stores/helpers/store-helpers.ts"
  );
  const prompt = promptAttachmentsFromMessage(userMessage.attachments);
  assert.deepEqual(prompt, [], "a session reference is not a prompt attachment");

  const mixed = promptAttachmentsFromMessage([
    { kind: "image", name: "shot.png", ref: "/p/shot.png", mimeType: "image/png" },
    referenced,
    { kind: "file", name: "notes.md", ref: "/p/notes.md", size: 12 },
  ]);
  assert.deepEqual(mixed, [
    { path: "/p/shot.png", name: "shot.png", kind: "image", mimeType: "image/png" },
    { path: "/p/notes.md", name: "notes.md", kind: "file", size: 12 },
  ]);
  assert.equal(isRenderableAttachment(referenced), false);
  assert.match(
    read("../src/stores/slices/transcript-slice.ts"),
    /\.filter\(isRenderableAttachment\)/,
    "the optimistic edit path uses the same narrowing as the prompt path",
  );
});

test("the conversation overflow menu copies the link for every reader", () => {
  const sidebar = read("../src/components/Sidebar.tsx");
  assert.match(sidebar, /data-action="copy-session-link"/);
  assert.match(sidebar, /t\("nav\.copySessionLink"\)/);
  assert.match(sidebar, /navigator\.clipboard\.writeText\(formatSessionLink\(session\.id\)\)/);
  assert.doesNotMatch(sidebar, /pi-desktop:\/\/session\//, "the scheme stays in shared");

  const link = sidebar.indexOf('data-action="copy-session-link"');
  const fork = sidebar.indexOf('data-action="fork-session"');
  const developer = sidebar.indexOf('data-action="copy-conversation-id"');
  assert.ok(
    link > 0 && link > fork && link < developer,
    "an ordinary reader sees it; the developer-only actions stay behind their gate",
  );
});

test("the reference keys exist in every shipped locale", () => {
  const locales = Object.keys(catalogs);
  assert.equal(locales.length, 9, "nine locales ship");
  for (const code of locales) {
    const catalog = catalogs[code];
    for (const [group, key] of [
      ["nav", "copySessionLink"],
      ["chat", "sessionReference"],
      ["chat", "sessionReferenceOpen"],
    ]) {
      const value = catalog[group]?.[key];
      assert.equal(typeof value, "string", `${code} is missing ${group}.${key}`);
      assert.ok(value.trim().length > 0, `${code} has an empty ${group}.${key}`);
    }
    assert.match(
      catalog.chat.sessionReferenceOpen,
      /\{\{title\}\}/,
      `${code} names the conversation it opens`,
    );
  }
  assert.equal(catalogs["zh-CN"].nav.copySessionLink, "复制会话链接");
  assert.equal(catalogs["zh-CN"].chat.sessionReference, "会话引用");
});
