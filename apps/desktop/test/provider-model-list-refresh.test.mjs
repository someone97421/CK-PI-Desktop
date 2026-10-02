import assert from "node:assert/strict";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { bindingForCustomModel, IPC } = await import("@pi-desktop/shared");

// Run the real IPC discovery and settings picker; mock only HTTP and host persistence.
test("refresh removes revoked service rows and preserves configured chat bindings", async (t) => {
  const row = {
    id: "relay", name: "Relay", vendorKey: "custom", enabled: true,
    authKind: "none", hasSecret: false, apiStyle: "chat_completions",
    baseUrl: "https://relay.example/v1",
    models: ["gpt-6-sol", "claude-sonnet-4-5"].map(bindingForCustomModel),
  };
  row.models[1] = { ...row.models[1], alias: "Saved alias", contextWindow: 190_000, contextWindowSource: "user" };
  let served = ["claude-sonnet-4-5", "gpt-6-sol"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: served.map((id) => ({ id })),
  }), { headers: { "content-type": "application/json" } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const catalog = new ModelsDevCatalog({
    catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)),
  });
  assert.equal(await catalog.ensureLoaded(), true);
  const handlers = new Map();
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ call: async (method) => {
      if (method === "providers.list") return { providers: [row] };
      if (method === "providers.get") return { provider: row };
      return {};
    } }),
    modelsDevCatalog: catalog, vendorOAuth: {}, logger: { app() {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [row], enrichProviderList: (result) => result,
    bindingForModel: () => undefined,
  });
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    logLevel: "silent", server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { ModelSelectionPanes, useModelSelection } = await server.ssrLoadModule(
    "/src/components/settings/ModelSelectionPanes.tsx",
  );
  const { composerModelsForProvider } = await server.ssrLoadModule("/src/lib/composer-models.ts");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } });
  let discovery;
  let persisted;
  function Picker() {
    const selection = useModelSelection(discovery, row.models, () => {});
    persisted = selection.bindingsToPersist;
    return createElement(ModelSelectionPanes, { discovery, selection, listTitle: "Service models" });
  }
  const render = () => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Picker)));
  const ids = (html, className) => [...html.matchAll(new RegExp(`<span class="${className}[^"]*">([^<]*)</span>`, "g"))].map((match) => match[1]);
  const refresh = async () => {
    const result = await handlers.get(IPC.invoke.providersListModels)({ providerId: row.id, source: "refresh" });
    discovery = { status: "ready", ...result };
    return render();
  };
  assert.deepEqual(ids(await refresh(), "provider-models-row-id"), served);
  served = ["gpt-6-sol", "new-model"];
  const html = await refresh();
  assert.deepEqual(ids(html, "provider-models-row-id"), served);
  assert.deepEqual(persisted, row.models);
  assert.deepEqual(ids(html, "provider-chosen-row-id"), ["gpt-6-sol", "claude-sonnet-4-5"]);
  assert.deepEqual(composerModelsForProvider(row, discovery.models).map((model) => model.modelId), ["gpt-6-sol", "claude-sonnet-4-5"]);
  // Offline/manual fallbacks must still expose configured entries for editing.
  discovery = { ...discovery, source: "fallback", models: [] };
  assert.deepEqual(ids(render(), "provider-models-row-id"), ["gpt-6-sol", "claude-sonnet-4-5"]);
});
