import assert from "node:assert/strict";
import test from "node:test";
import { createModels, InMemoryModelsStore, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { bindingForCustomModelInfo } from "@pi-desktop/shared";
import { genericModelConfig, modelConfigWithBinding } from "@pi-desktop/agent-runtime";
import { ModelsDevCatalog, catalogModelConfigFor, modelInfoFromModelsDev } from "../electron/main/models-dev-catalog.ts";
import { fixtureProvider } from "./pi-catalog-fixtures.mjs";

function account(provider) {
  const models = createModels({ modelsStore: new InMemoryModelsStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(provider);
  return models;
}
const target = { providerId: "account", vendorKey: "example", modelId: "chat" };
const binding = (values = {}) => ({ id: "chat", contextWindow: 128_000, maxTokens: 8_192, thinkingLevels: ["low", "high"], ...values });

// Parser/URL/heuristic-ranking implementation tests retired with the independent
// models.dev parser. These exercise the replacement Pi public factory boundary.
test("offline startup uses Pi's shipped catalog and does not consult ambient auth", async () => {
  const catalog = new ModelsDevCatalog();
  assert.equal(await catalog.ensureLoaded(), true);
  for (const vendorKey of ["openai", "openai-codex", "azure-openai-responses"]) {
    const model = catalog.findModel({ vendorKey, modelId: "gpt-6.1-sol" });
    assert.ok(model, vendorKey);
    assert.equal(model.type ?? "chat", "chat");
    assert.deepEqual(modelInfoFromModelsDev(model, "row").supportedThinkingLevels, getSupportedThinkingLevels(model));
    assert.ok(!getSupportedThinkingLevels(model).includes("off"));
  }
  assert.equal(catalog.getStatus().source, "bundled");
});

test("concurrent cache hydration shares one Pi refresh", async () => {
  let restores = 0;
  const base = fixtureProvider("example", [{ id: "chat" }]);
  const catalog = new ModelsDevCatalog({ providers: [{ ...base, refreshModels: async () => { restores++; } }] });
  await Promise.all(Array.from({ length: 40 }, () => catalog.ensureLoaded()));
  assert.equal(restores, 1);
});

test("explicit refresh updates Pi model objects and failed refresh preserves last success", async () => {
  let count = 0;
  let fail = false;
  const provider = fixtureProvider("example", [{ id: "chat", contextWindow: 10_000 }], {
    fetchModels: async () => {
      count++;
      if (fail) throw new Error("sensitive-endpoint-token");
      return [{ ...provider.getModels()[0], contextWindow: 20_000 }];
    },
  });
  const catalog = new ModelsDevCatalog({ providers: [provider], now: () => 1000 });
  await catalog.ensureLoaded();
  assert.equal(count, 0);
  assert.equal(await catalog.refresh(), true);
  assert.equal(catalog.findModel(target).contextWindow, 20_000);
  const previous = catalog.findModel(target);
  fail = true;
  assert.equal(await catalog.refresh(), false);
  assert.deepEqual(catalog.findModel(target), previous);
  assert.equal(count, 2);
  assert.equal(catalog.getStatus().fetchedAt, new Date(1000).toISOString());
  assert.ok(!catalog.getStatus().lastError.includes("sensitive"));
});

test("provider and endpoint identity never borrow unrelated capabilities", async () => {
  const catalog = new ModelsDevCatalog({ providers: [
    fixtureProvider("example", [{ id: "chat", contextWindow: 10_000 }]),
    fixtureProvider("other", [{ id: "chat", contextWindow: 20_000 }, { id: "other-only" }]),
  ] });
  await catalog.ensureLoaded();
  assert.equal(catalog.findModel(target).contextWindow, 10_000);
  assert.equal(catalog.findModel({ ...target, modelId: "other-only" }), undefined);
  assert.equal(catalog.findModel({ modelId: "chat", baseUrl: "https://unknown.example/v1" }), undefined);
  assert.equal(catalog.findModel({ modelId: "chat", baseUrl: "https://other.example/v1" }).contextWindow, 20_000);
  for (const modelId of ["proxy/chat", "chat-latest", "chat-20260930", "chat-thinking"]) {
    assert.equal(catalog.findModel({ ...target, modelId }), undefined);
  }
  assert.equal(catalog.findModel({ ...target, modelId: " CHAT " }).id, "chat");
});

test("ambiguous shared endpoint has no first-provider winner", async () => {
  const options = { baseUrl: "https://shared.example/v1" };
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("one", [{ id: "chat" }], options), fixtureProvider("two", [{ id: "chat" }], options)] });
  await catalog.ensureLoaded();
  assert.equal(catalog.findModel({ baseUrl: options.baseUrl, modelId: "chat" }), undefined);
  assert.equal(catalog.findModel({ vendorKey: "two", baseUrl: options.baseUrl, modelId: "chat" }).provider, "two");
});

test("same-vendor accounts have distinct effective objects and deleted accounts stay unavailable", async () => {
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("example", [{ id: "chat" }])] });
  for (const [id, contextWindow] of [["account", 10_000], ["other-account", 20_000]]) {
    catalog.setAccountModels(id, account(fixtureProvider("example", [{ id: "chat", contextWindow }])));
  }
  assert.equal(catalog.findModel(target).contextWindow, 10_000);
  assert.equal(catalog.findModel({ ...target, providerId: "other-account" }).contextWindow, 20_000);
  catalog.deleteAccount("account");
  catalog.configureAccount({ id: "account", vendorKey: "example" });
  assert.equal(catalog.findModel(target), undefined);
  assert.deepEqual(catalog.modelsForProvider({ providerId: "account", vendorKey: "example" }), []);
  assert.equal(catalog.findModel({ ...target, providerId: "other-account" }).contextWindow, 20_000);
});

test("an attached account missing a model never falls back to the vendor catalog", () => {
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("example", [{ id: "chat" }])] });
  catalog.setAccountModels("account", account(fixtureProvider("example", [])));
  assert.equal(catalog.findModel(target), undefined);
});

test("typed lookups retain chat/image/classifier with one ID and the legacy list stays chat-only", () => {
  const provider = fixtureProvider("example", [
    { id: "shared" },
    { id: "shared", type: "image", api: "openrouter-images", output: ["image"] },
    { id: "shared", type: "classifier", api: "fixture-classifier" },
  ]);
  const catalog = new ModelsDevCatalog({ providers: [provider] });
  const input = { ...target, modelId: "shared" };
  assert.equal(catalog.findModel(input).type ?? "chat", "chat");
  assert.equal(catalog.findModelOfType("image", input).type, "image");
  assert.equal(catalog.findModelOfType("classifier", input).type, "classifier");
  catalog.configureAccount({ id: "account", vendorKey: "example", models: [binding({ id: "shared", contextWindow: 64_000 })] });
  assert.equal(catalog.findModelOfType("image", input).type, "image");
  assert.equal(catalog.findModelOfType("classifier", input).type, "classifier");
  assert.deepEqual(catalog.modelsForProvider({ providerId: "account", vendorKey: "example", includeNonChat: true }).map((model) => model.modelId), ["shared"]);
});

test("projection and execution read the same effective Pi object and preserve native cost", () => {
  const native = fixtureProvider("example", [{ id: "chat", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 64_000 }]);
  const models = account(native);
  const catalog = new ModelsDevCatalog({ providers: [native] });
  catalog.setAccountModels("account", models);
  const row = { id: "account", vendorKey: "example", models: [binding({ contextWindow: 32_000, maxTokens: 4_000, supportsImages: false })] };
  catalog.configureAccount(row);
  const effective = catalog.findModel(target);
  assert.equal(models.getModel("example", "chat"), effective);
  const info = modelInfoFromModelsDev(effective, "account");
  const config = catalogModelConfigFor(catalog, target);
  assert.equal(info.contextWindow, config.contextWindow);
  assert.equal(info.maxTokens, config.maxTokens);
  assert.deepEqual(info.modalities.input, config.input);
  assert.deepEqual(info.supportedThinkingLevels, getSupportedThinkingLevels(effective));
  assert.equal(effective.cost, native.getModels()[0].cost);
  assert.equal(native.getModels()[0].contextWindow, 1_000_000);
  assert.equal(catalog.findModel(target), effective, "stable reads share the effective object");
  row.models = [];
  catalog.configureAccount(row);
  assert.equal(catalog.findModel(target).contextWindow, 1_000_000);
});

test("catalog limit provenance follows refresh while legacy explicit limits stay pinned", async () => {
  let contextWindow = 100_000;
  const provider = fixtureProvider("example", [{ id: "chat", contextWindow }], {
    fetchModels: async () => [{ ...provider.getModels()[0], contextWindow }],
  });
  const catalog = new ModelsDevCatalog({ providers: [provider] });
  catalog.configureAccount({ id: "account", vendorKey: "example", models: [binding({ contextWindow: 90_000, contextWindowSource: "catalog" })] });
  catalog.configureAccount({ id: "legacy", vendorKey: "example", models: [binding({ contextWindow: 128_000 })] });
  contextWindow = 200_000;
  assert.equal(await catalog.refresh(), true);
  assert.equal(catalogModelConfigFor(catalog, target).contextWindow, 200_000);
  assert.equal(catalogModelConfigFor(catalog, { ...target, providerId: "legacy" }).contextWindow, 128_000);
});

test("custom unpublished bindings keep explicit limits without false published prices", () => {
  const catalog = new ModelsDevCatalog({ providers: [] });
  catalog.configureAccount({ id: "account", vendorKey: "custom", models: [binding({ contextWindow: 32_000, maxTokens: 2_000, supportsImages: true })] });
  const config = catalogModelConfigFor(catalog, { ...target, vendorKey: "custom" });
  assert.equal(config.source, "generic");
  assert.equal(config.contextWindow, 32_000);
  assert.equal(config.maxTokens, 2_000);
  assert.deepEqual(config.input, ["text", "image"]);
});

test("hand-typed IDs retain their wire spelling when a named provider seeds a binding", () => {
  const provider = fixtureProvider("example", [{ id: "chat" }]);
  const info = modelInfoFromModelsDev(provider.getModels()[0], "account");
  const saved = bindingForCustomModelInfo("CHAT", info);
  assert.equal(saved.id, "CHAT");
  assert.equal(saved.contextWindowSource, "catalog");
  assert.equal(saved.maxTokensSource, "catalog");
  assert.equal(info.catalogSource, "pi");
});

test("custom providers never infer a catalog from a host, model name or deployment suffix", () => {
  const catalog = new ModelsDevCatalog({ providers: [
    fixtureProvider("anthropic", [{ id: "claude-fixture", contextWindow: 1_000_000 }]),
    fixtureProvider("xiaomi", [{ id: "mimo-v2.6-pro", contextWindow: 1_048_576 }]),
  ] });
  for (const baseUrl of ["https://relay.example/v1", "https://anthropic.example/v1", "https://api.anthropic.com/v1"]) {
    for (const modelId of ["claude-fixture", "route/claude-fixture", "mimo-v2.6-pro", "mimo-v2.6-pro-1m-test"]) {
      const input = { providerId: "custom-row", vendorKey: "custom", baseUrl, modelId };
      assert.equal(catalog.providerKeyForRow(input), undefined);
      assert.equal(catalog.findModel(input), undefined);
      assert.equal(catalog.publishedModelFor(input), undefined);
      assert.equal(catalog.findModelOfType("image", input), undefined);
      assert.deepEqual(catalog.modelsForProvider({ ...input, includeNonChat: true }), []);
      const config = catalog.modelConfigFor(input);
      assert.deepEqual(config, modelConfigWithBinding(genericModelConfig(modelId, baseUrl)));
    }
  }
  assert.equal(catalog.findModel({ vendorKey: "anthropic", modelId: "claude-fixture" }).contextWindow, 1_000_000);
});

test("custom providers do not acquire operation metadata from a known model name", () => {
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("xiaomi-token-plan-cn", [])] });
  const input = { providerId: "custom-row", vendorKey: "custom", baseUrl: "https://api.xiaomimimo.com/v1", modelId: "mimo-v2.5-tts" };
  assert.equal(catalog.settingsMetadataFor(input), undefined);
  assert.ok(catalog.settingsMetadataFor({ ...input, vendorKey: "xiaomi-token-plan-cn" }));
});

test("saved custom identity still blocks matching when a caller omits the vendor key", () => {
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("anthropic", [{ id: "claude-fixture" }])] });
  catalog.configureAccount({ id: "custom-row", vendorKey: "custom", baseUrl: "https://anthropic.example/v1" });
  const input = { providerId: "custom-row", baseUrl: "https://anthropic.example/v1", modelId: "claude-fixture" };
  assert.equal(catalog.findModel(input), undefined);
  assert.equal(catalog.publishedModelFor(input), undefined);
  assert.equal(catalog.settingsMetadataFor({ ...input, modelId: "mimo-v2.5-tts" }), undefined);
  assert.deepEqual(catalog.modelsForProvider({ ...input, includeNonChat: true }), []);
  assert.equal(catalog.modelConfigFor(input).source, "generic");
});

test("custom runtime uses saved manual settings and ignores previously matched metadata", () => {
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("xiaomi", [{ id: "mimo-v2.6-pro", contextWindow: 1_048_576, maxTokens: 131_072 }])] });
  for (const source of [undefined, "user", "catalog"]) {
    const storedBinding = binding({
      id: "mimo-v2.6-pro", contextWindow: 2_000_000, contextWindowSource: source,
      maxTokens: 32_100, maxTokensSource: source, thinkingLevels: ["off", "max"],
      thinkingProtocol: "adaptive", supportsImages: true, supportsDocuments: true,
      supportsAudio: true, supportsVideo: true, nativeWebSearch: true,
    });
    const row = { id: "relay", vendorKey: "custom", baseUrl: "https://xiaomi.example/v1", models: [storedBinding] };
    const original = structuredClone(row);
    catalog.configureAccount(row);
    const input = { providerId: row.id, vendorKey: row.vendorKey, baseUrl: row.baseUrl, modelId: storedBinding.id };
    const matched = catalog.modelConfigFor({ vendorKey: "xiaomi", modelId: storedBinding.id });
    const config = catalog.modelConfigFor(input, matched);
    assert.equal(config.source, "generic");
    assert.equal(config.contextWindow, 2_000_000);
    assert.equal(config.maxTokens, 32_100);
    assert.deepEqual(config.supportedThinkingLevels, ["off", "max"]);
    assert.equal(config.thinkingProtocol, "adaptive");
    assert.deepEqual(config.modalities.input, ["text", "image", "pdf"]);
    assert.equal(config.supportsAudio, true);
    assert.equal(config.supportsVideo, true);
    assert.equal(config.webSearch, true);
    assert.deepEqual(config.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(config.catalogContextWindow, undefined);
    assert.deepEqual(row, original, "reading custom config must not migrate or erase stored settings");
  }
});

test("custom generic fallback cannot call a legacy name-only catalog adapter", () => {
  const input = { vendorKey: "custom", modelId: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" };
  const catalog = { findModel: () => { throw new Error("custom provider must not be matched"); } };
  assert.deepEqual(catalogModelConfigFor(catalog, input), genericModelConfig(input.modelId, input.baseUrl));
});

test("a stored extended level cannot invent native Pi support", () => {
  const catalog = new ModelsDevCatalog({ providers: [fixtureProvider("example", [{ id: "chat", reasoning: true, thinkingLevelMap: { off: null, low: "low", high: "high" } }])] });
  const row = { id: "account", vendorKey: "example", models: [binding({ thinkingLevels: ["low", "max"] })] };
  catalog.configureAccount(row);
  assert.deepEqual(getSupportedThinkingLevels(catalog.findModel(target)), ["low"]);
  assert.deepEqual(row.models[0].thinkingLevels, ["low", "max"]);
});
