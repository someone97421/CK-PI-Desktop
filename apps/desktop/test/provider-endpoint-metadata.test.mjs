import "./helpers/provider-ipc-test-setup.mjs";
/** Custom providers discover IDs without automatic catalog matching. */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { registerProviderIpc } = await import("../electron/main/ipc/provider-ipc.ts");
const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");
const { IPC } = await import("@pi-desktop/shared");

const catalogPath = new URL("../resources/models.dev/api.json", import.meta.url).pathname;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Register the real handlers against one row and one served model list. */
async function handlersFor(t, row, body) {
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true, "the bundled snapshot must load");

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return String(url).endsWith("/models") ? jsonResponse(body) : new Response("", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const handlers = new Map();
  const hostCalls = [];
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method, input) => {
        hostCalls.push({ method, input });
        if (method === "providers.list") return { providers: [row] };
        if (method === "providers.getSecret") return { value: "sk-secret" };
        if (method === "providers.get") return { provider: row };
        if (method === "providers.listModels") return { models: body.data?.map(({ id }) => ({ modelId: id, displayName: id, source: "discovered" })) ?? [] };
        return {};
      },
    }),
    modelsDevCatalog: catalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [row],
    enrichProviderList: (result) => result,
    bindingForModel: () => undefined,
  });

  const listModels = handlers.get(IPC.invoke.providersListModels);
  assert.equal(typeof listModels, "function", "list-models handler is not registered");
  const lookupModel = handlers.get(IPC.invoke.providersLookupModel);
  assert.equal(typeof lookupModel, "function", "model-lookup handler is not registered");

  return {
    calls,
    hostCalls,
    row,
    result: await listModels({ providerId: row.id, source: "refresh" }),
    /** The hand-typed id channel a picker uses when a user types an id in. */
    lookup: (input) => lookupModel(input),
    list: (input) => listModels(input),
  };
}

function rowOf(overrides) {
  return {
    name: "Row",
    vendorKey: "custom",
    apiStyle: "chat_completions",
    models: [],
    authKind: "api_key_and_base_url",
    headers: {},
    ...overrides,
  };
}

test("a custom row on an official endpoint discovers IDs without publisher metadata", async (t) => {
  const row = rowOf({ id: "custom-official", baseUrl: "https://open.bigmodel.cn/api/v1", apiStyle: "responses" });
  const { result, calls, lookup } = await handlersFor(t, row, { models: [{ slug: "glm-5.3", display_name: "My served model" }] });
  assert.deepEqual(calls, ["https://open.bigmodel.cn/api/v1/models"]);
  assert.equal(result.effectiveBaseUrl, row.baseUrl);
  const [model] = result.models;
  assert.equal(model.modelId, "glm-5.3");
  assert.equal(model.displayName, "My served model");
  assert.equal(model.catalogSource, undefined);
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 8_192);
  assert.deepEqual(model.capabilities, ["text"]);
  assert.deepEqual(model.modalities, { input: ["text"], output: ["text"] });
  assert.equal((await lookup({ modelId: model.modelId, vendorKey: "custom", baseUrl: row.baseUrl })).info, null);
});

test("custom live and cached discovery do not enrich official, routed or operation IDs", async (t) => {
  const ids = ["claude-sonnet-4-5", "mimo-v2.5-pro", "mimo-v2.5-pro-1m", "route/mimo-v2.5-pro", "mimo-v2.5-tts", "some-private-model"];
  const row = rowOf({ id: "custom-relay", baseUrl: "https://relay.example/v1" });
  const { result, list, lookup, calls } = await handlersFor(t, row, { data: ids.map(id => ({ id })) });
  const cached = await list({ providerId: row.id, source: "cache" });
  for (const response of [result, cached]) {
    assert.deepEqual(response.models.map(model => model.modelId).sort(), [...ids].sort());
    for (const model of response.models) {
      assert.equal(model.catalogSource, undefined);
      assert.equal(model.contextWindow, 128_000, model.modelId);
      assert.equal(model.maxTokens, 8_192, model.modelId);
      assert.deepEqual(model.capabilities, ["text"], model.modelId);
    }
  }
  const networkCount = calls.length;
  for (const modelId of ids) {
    assert.equal((await lookup({ modelId, vendorKey: row.vendorKey, providerId: row.id, baseUrl: row.baseUrl })).info, null);
  }
  assert.equal(calls.length, networkCount, "typed lookup remains local");
});

test("new custom provider requests preserve explicit identity before the row is saved", async (t) => {
  const row = rowOf({ id: "existing", vendorKey: "zhipuai", baseUrl: "https://open.bigmodel.cn/api/v1", apiStyle: "responses" });
  const { list, hostCalls } = await handlersFor(t, row, { models: [{ slug: "glm-5.3" }] });
  const response = await list({ vendorKey: "custom", baseUrl: row.baseUrl, apiStyle: row.apiStyle });
  assert.equal(response.models[0].catalogSource, undefined);
  assert.equal(response.models[0].contextWindow, 128_000);
  assert.equal(response.models[0].maxTokens, 8_192);
  const cacheWrites = hostCalls.filter(call => call.method === "providers.cacheModels").length;
  const preview = await list({ providerId: row.id, vendorKey: "custom", baseUrl: row.baseUrl, apiStyle: row.apiStyle });
  assert.equal(preview.models[0].catalogSource, undefined);
  assert.equal(hostCalls.filter(call => call.method === "providers.cacheModels").length, cacheWrites,
    "an unsaved custom selection must not replace the named provider's cache");
});

test("custom list preserves stored limits and never fills the list from the catalog", async (t) => {
  const row = rowOf({
    id: "custom-manual", baseUrl: "https://api.openai.com/v1",
    models: [{ id: "gpt-6.1-sol", contextWindow: 2_000_000, contextWindowSource: "catalog", maxTokens: 24_000, maxTokensSource: "catalog", thinkingLevels: ["off"], supportsImages: true }],
  });
  const original = structuredClone(row);
  const { result } = await handlersFor(t, row, { data: [] });
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models.map(model => model.modelId), ["gpt-6.1-sol"]);
  assert.equal(result.models[0].catalogSource, undefined);
  assert.equal(result.models[0].contextWindow, 2_000_000);
  assert.equal(result.models[0].maxTokens, 24_000);
  assert.deepEqual(result.models[0].modalities.input, ["text", "image"]);
  assert.deepEqual(row, original);
});

test("named providers retain published metadata in discovery and typed lookup", async (t) => {
  const row = rowOf({ id: "named", vendorKey: "zhipuai", baseUrl: "https://open.bigmodel.cn/api/v1", apiStyle: "responses" });
  const { result, lookup } = await handlersFor(t, row, { models: [{ slug: "glm-5.3" }] });
  const [model] = result.models;
  assert.equal(model.catalogSource, "models.dev");
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 131_072);
  assert.ok(model.capabilities.includes("reasoning"));
  const typed = await lookup({ modelId: model.modelId, vendorKey: row.vendorKey, providerId: row.id, baseUrl: row.baseUrl });
  assert.equal(typed.info.catalogSource, "models.dev");
  assert.equal(typed.info.contextWindow, model.contextWindow);
});
