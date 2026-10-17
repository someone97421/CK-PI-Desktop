import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("切换思考可见性不改变工具和搜索结果的展开状态", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  let state;
  let originalSettings;
  try {
    const { ActivityGroup } = await server.ssrLoadModule("/src/features/chat/transcript/ActivityGroup.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    state = useAppStore.getInitialState();
    originalSettings = state.settings;
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    const createdAt = "2026-10-17T00:00:00Z";
    const fixtures = [
      {
        kind: "tool",
        message: { id: "tool", role: "tool", toolName: "Read", toolCallId: "call", toolArgs: { path: "sample.txt" }, content: "sample result", toolStatus: "success", createdAt },
      },
      {
        kind: "hostedSearch",
        message: { id: "search", role: "assistant", content: "", status: "complete", createdAt },
        round: { id: "round", kind: "search", status: "completed", query: "example", sources: [] },
      },
    ];
    for (const item of fixtures) {
      for (const isLast of [true, false]) {
        for (const showThinking of [true, false]) {
          state.settings = { ...originalSettings, showThinking };
          const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n },
            createElement(ActivityGroup, { items: [item], isActive: false, isLast })));
          const expanded = html.match(/class="tool-row-header"[^>]*aria-expanded="(true|false)"/)?.[1];
          assert.equal(expanded, String(isLast), `${item.kind}: isLast=${isLast}, showThinking=${showThinking}`);
        }
      }
    }
  } finally {
    if (state) state.settings = originalSettings;
    await server.close();
  }
});
