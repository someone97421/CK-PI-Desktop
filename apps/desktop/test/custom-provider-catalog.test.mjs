import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { genericModelConfig } from "@pi-desktop/agent-runtime";
import { ModelsDevCatalog, catalogModelConfigFor } from "../electron/main/models-dev-catalog.ts";

const catalogPath = fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url));
async function catalogFor() {
  const catalog = new ModelsDevCatalog({
    catalogPath,
    fetchImpl: async () => new Response(await readFile(catalogPath, "utf8")),
  });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

test("explicit custom accounts never infer metadata from names, official URLs or aliases", async () => {
  const catalog = await catalogFor();
  for (const baseUrl of ["https://relay.example/v1", "https://api.openai.com/v1", "https://api.anthropic.com/v1"]) {
    for (const modelId of ["gpt-6.1-sol", "route/gpt-6.1-sol", "claude-opus-4-6", "gpt-6.1-sol-1m"]) {
      const input = { providerId: "custom-row", vendorKey: "custom", baseUrl, modelId, apiStyle: "anthropic_messages" };
      assert.equal(catalog.providerKeyForRow(input), undefined);
      assert.equal(catalog.findModel(input), undefined);
      assert.equal(catalog.publishedModelFor(input), undefined);
      assert.equal(catalog.findModelOfType("image", input), undefined);
      assert.equal(catalog.settingsMetadataFor(input), undefined);
      assert.deepEqual(catalog.modelsForProvider({ ...input, includeNonChat: true }), []);
      assert.deepEqual(catalog.modelConfigFor(input), genericModelConfig(modelId, baseUrl));
    }
  }
  assert.equal(catalog.findModel({ vendorKey: "openai", modelId: "gpt-6.1-sol" }).limit.context, 1_050_000);
});

test("saved custom identity blocks omitted-vendor lookups; an explicit named preview still works", async () => {
  const catalog = await catalogFor();
  catalog.configureAccount({ id: "custom-row", vendorKey: "custom", baseUrl: "https://api.openai.com/v1" });
  const input = { providerId: "custom-row", baseUrl: "https://api.openai.com/v1", modelId: "gpt-6.1-sol" };
  assert.equal(catalog.findModel(input), undefined);
  assert.equal(catalog.providerKeyForRow(input), undefined);
  assert.equal(catalog.settingsMetadataFor(input), undefined);
  assert.deepEqual(catalog.modelsForProvider({ ...input, includeNonChat: true }), []);
  assert.equal(catalog.modelConfigFor(input).source, "generic");
  assert.equal(catalog.findModel({ ...input, vendorKey: "openai" }).limit.context, 1_050_000);
});

for (const source of [undefined, "user", "catalog"]) {
  test(`custom 500000-token binding survives stale metadata and refresh (${source ?? "legacy"})`, async () => {
    const catalog = await catalogFor();
    const saved = {
      id: "gpt-6.1-sol", contextWindow: 500_000, contextWindowSource: source,
      maxTokens: 32_100, maxTokensSource: source, thinkingLevels: ["off", "max"],
      thinkingProtocol: "adaptive", supportsImages: true, supportsDocuments: true,
      supportsAudio: true, supportsVideo: true, nativeWebSearch: true,
    };
    const row = { id: "relay", vendorKey: "custom", baseUrl: "https://api.openai.com/v1", models: [saved] };
    const original = structuredClone(row);
    catalog.configureAccount(row);
    const input = { providerId: row.id, baseUrl: row.baseUrl, modelId: saved.id };
    const stale = catalog.modelConfigFor({ vendorKey: "openai", modelId: saved.id });
    const config = catalog.modelConfigFor(input, stale);
    assert.equal(config.source, "generic");
    assert.equal(config.contextWindow, 500_000);
    assert.equal(config.maxTokens, 32_100);
    assert.equal(config.catalogContextWindow, undefined);
    assert.deepEqual(config.supportedThinkingLevels, ["off", "max"]);
    assert.equal(config.thinkingProtocol, "adaptive");
    assert.deepEqual(config.modalities.input, ["text", "image", "pdf"]);
    assert.equal(config.supportsAudio, true);
    assert.equal(config.supportsVideo, true);
    assert.equal(config.webSearch, true);
    assert.deepEqual(config.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(await catalog.refresh(), true);
    catalog.configureAccount(row);
    assert.deepEqual(catalog.modelConfigFor(input, stale), config);
    assert.deepEqual(row, original, "reads must not migrate or erase stored settings");
  });
}

test("legacy name-only adapters cannot enrich a custom provider", () => {
  const input = { vendorKey: "custom", modelId: "claude-opus-4-6", baseUrl: "https://api.anthropic.com/v1", apiStyle: "anthropic_messages" };
  const catalog = {
    findModel() { throw new Error("must not match a custom model"); },
    anthropicThinkingFor() { throw new Error("must not infer custom thinking"); },
  };
  assert.deepEqual(catalogModelConfigFor(catalog, input), genericModelConfig(input.modelId, input.baseUrl));
});

test("desktop packaging includes the exact offline catalog resource required at startup", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.build.extraResources.some(entry => entry.from === "resources/models.dev" && entry.to === "models.dev"));
  const snapshot = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.ok(Object.keys(snapshot).length > 0);
});
