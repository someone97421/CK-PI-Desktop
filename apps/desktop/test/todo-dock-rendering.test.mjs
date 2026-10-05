import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("TodoDock renders bounded session progress and cancelled state", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TodoDock } = await server.ssrLoadModule("/src/components/TodoDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const render = () =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(TodoDock, { sessionId: "session-todo-test" }),
        ),
      );

    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-todo-test": {
          sessionId: "session-todo-test",
          revision: 3,
          updatedAt: 100,
          todos: [
            { content: "first", status: "completed", priority: "medium" },
            { content: "second", status: "in_progress", priority: "high" },
            ...Array.from({ length: 10 }, (_, index) => ({
              content: `extra-${index}`,
              status: "pending",
              priority: "low",
            })),
          ],
        },
      },
    });
    const html = render();
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /class="todo-dock-content" aria-hidden="true"/);
    assert.match(html, /class="todo-dock-content" aria-hidden="true"><div class="todo-dock-clip">/);
    assert.match(html, /extra-0/);
    // The expanded dock lists every row (#1319): the whole list is mounted, and
    // the dock scrolls inside instead of printing a static overflow line.
    assert.equal((html.match(/role="listitem"/g) ?? []).length, 12, "every ordered row renders");
    assert.doesNotMatch(html, /more items/);
    assert.match(html, /class="todo-dock-list" role="list" tabindex="-1"/);
    assert.match(html, /lucide-check/);

    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-todo-test": {
          sessionId: "session-todo-test",
          revision: 4,
          updatedAt: 101,
          todos: [
            { content: "cancelled work", status: "cancelled", priority: "low" },
          ],
        },
      },
    });
    assert.match(render(), /Cancelled/);
    assert.doesNotMatch(render(), /0\/0 completed/);
  } finally {
    await server.close();
  }
});

test("TodoDock uses a quiet disclosure animation and state surfaces", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8");
  assert.match(css, /\.todo-dock-header:active:not\(:disabled\)\s*\{[\s\S]*?transform:\s*none;/);
  assert.match(css, /\.todo-dock-content\s*\{[\s\S]*?grid-template-rows:\s*0fr;[\s\S]*?opacity:\s*0;/);
  assert.match(css, /\.todo-dock\.is-expanded \.todo-dock-content\s*\{[\s\S]*?grid-template-rows:\s*1fr;/);
  assert.match(css, /\.todo-dock-row-completed\s*\{[\s\S]*?var\(--ds-success\)/);
  // The expanded list is the scrollport (#1319): bounded height, internal
  // scroll, no chaining into the transcript, and reachable from the keyboard.
  assert.match(
    css,
    /\.todo-dock\.is-expanded \.todo-dock-list\s*\{[\s\S]*?max-height:[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/,
  );
  assert.match(css, /\.todo-dock-list:focus-visible\s*\{[\s\S]*?outline:/);
  assert.doesNotMatch(css, /\.todo-dock-more\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.todo-dock-content/);
});
