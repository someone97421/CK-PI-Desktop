/**
 * Contract test for hand-typed models on named providers.
 *
 * The settings picker reads the local models.dev catalog through one dedicated channel;
 * an explicit custom provider bypasses it and retains its manual configuration.
 * This pins the handler contract: it loads the snapshot, resolves the id,
 * echoes the provider back on the record and answers a miss with `null`.
 * Explicit vendor identity needs neither host nor network; legacy account-only
 * requests resolve the saved identity before looking up any model.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC } from "@pi-desktop/shared";
import * as modelsDev from "../electron/main/models-dev-catalog.ts";

/** Minimal CJS loader for the main-process module under test. */
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

async function fixtureCatalog() {
  const catalog = new modelsDev.ModelsDevCatalog({
    catalogPath: new URL("../resources/models.dev/api.json", import.meta.url).pathname,
  });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

/**
 * Register the real handler with a fake catalog and a fake registrar, then
 * expose only the lookup channel.
 */
function harness(realCatalog, savedProviders) {
  const handlers = new Map();
  const catalogCalls = [];
  const hostCalls = [];
  const modelsDevCatalog = {
    ensureLoaded: async () => {
      catalogCalls.push("ensureLoaded");
      return realCatalog.ensureLoaded();
    },
    findModel: (input) => {
      catalogCalls.push(["findModel", input]);
      return realCatalog.findModel(input);
    },
    configureAccount: (provider) => {
      catalogCalls.push(["configureAccount", provider]);
      realCatalog.configureAccount(provider);
    },
  };
  const { registerProviderIpc } = load("../electron/main/ipc/provider-ipc.ts", {
    "@pi-desktop/shared": {
      IPC,
      ErrorCodes,
      inferEndpointProfile: () => undefined,
      normalizeApiStyle: (value) => value ?? "chat_completions",
      resolveBindingLimits: () => ({}),
    },
    "../oauth": { OAUTH_AUTH_KIND: "oauth" },
    "../provider-config-transfer": {},
    "../model-discovery": {
      probeProviderEndpoint: async () => {
        throw new Error("the lookup must not probe the network");
      },
    },
    "../provider-endpoint-probe": {
      // The lookup handler is a snapshot read: any sweep it started would take
      // the network path this test exists to rule out.
      probeDiscoveryCandidates: async () => {
        throw new Error("the lookup must not probe the network");
      },
    },
    "@pi-desktop/agent-runtime": {},
    "../models-dev-catalog": modelsDev,
    "../host-process": {},
    "../logger": { app: () => {} },
    "./types": {},
  });
  registerProviderIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method) => {
        hostCalls.push(method);
        if (method === "providers.list" && savedProviders) return { providers: savedProviders };
        throw new Error("the lookup must not call the host");
      },
    }),
    modelsDevCatalog,
    vendorOAuth: {},
    logger: { app: () => {} },
    enrichProvider: (provider) => provider,
    listRuntimeProviders: async () => [],
    enrichProviderList: async (result) => result,
    bindingForModel: () => undefined,
  });
  const handler = handlers.get(IPC.invoke.providersLookupModel);
  assert.equal(typeof handler, "function", "lookup handler is not registered");
  return { call: (input) => handler(input), catalogCalls, hostCalls };
}

test("a published id returns the snapshot record for the typed id", async (t) => {
  const h = harness(await fixtureCatalog(t));
  const result = await h.call({
    modelId: "Claude-Opus-4-6",
    providerId: "provider-1",
    vendorKey: "anthropic",
  });
  assert.ok(result.info, "a published id must return its record");
  assert.equal(result.info.modelId, "claude-opus-4-6");
  assert.equal(result.info.providerId, "provider-1");
  assert.equal(result.info.contextWindow, 1_000_000);
  assert.equal(result.info.maxTokens, 128_000);
  for (const level of ["low", "medium", "high"]) {
    assert.ok(result.info.supportedThinkingLevels.includes(level));
  }
  // Snapshot read: load then resolve, in that order, and nothing else.
  assert.deepEqual(h.catalogCalls[0], "ensureLoaded");
  assert.equal(h.catalogCalls[1][0], "findModel");
  assert.deepEqual(h.catalogCalls[1][1], {
    providerId: "provider-1",
    vendorKey: "anthropic",
    baseUrl: undefined,
    modelId: "Claude-Opus-4-6",
  });
  assert.deepEqual(h.hostCalls, []);
});

test("an id the library does not publish answers null", async (t) => {
  const h = harness(await fixtureCatalog(t));
  const result = await h.call({ modelId: "not-in-the-library" });
  assert.deepEqual(result, { info: null });
  assert.equal(h.catalogCalls[0], "ensureLoaded");
  assert.deepEqual(h.hostCalls, []);
});

test("a blank id answers null without loading or resolving", async (t) => {
  const h = harness(await fixtureCatalog(t));
  assert.deepEqual(await h.call({ modelId: "   " }), { info: null });
  assert.deepEqual(h.catalogCalls, []);
  assert.deepEqual(h.hostCalls, []);
});

test("the catalog lookup never probes the provider or the host", async (t) => {
  // The fake discovery throws and the fake host records, so any network or
  // host path taken by the handler fails this test instead of passing silently.
  const h = harness(await fixtureCatalog(t));
  await h.call({ modelId: "claude-opus-4-6" });
  await h.call({ modelId: "missing" });
  assert.deepEqual(h.hostCalls, []);
});


test("an explicitly custom provider never loads or matches catalog metadata", async () => {
  const h = harness(await fixtureCatalog());
  for (const baseUrl of ["https://api.anthropic.com/v1", "https://relay.example/v1"]) {
    const result = await h.call({ modelId: "claude-opus-4-6", vendorKey: "custom", baseUrl });
    assert.deepEqual(result, { info: null });
  }
  assert.deepEqual(h.catalogCalls, []);
  assert.deepEqual(h.hostCalls, []);
});

test("a cold saved custom account is resolved before an older caller can infer its official endpoint", async () => {
  const row = { id: "cold-custom", name: "Custom", vendorKey: "custom", baseUrl: "https://api.anthropic.com/v1" };
  const h = harness(await fixtureCatalog(), [row]);
  const result = await h.call({ providerId: row.id, baseUrl: row.baseUrl, modelId: "claude-opus-4-6" });
  assert.deepEqual(result, { info: null });
  assert.deepEqual(h.hostCalls, ["providers.list"]);
  assert.deepEqual(h.catalogCalls, [["configureAccount", row]]);
});

test("a cold saved named account still returns its catalog model for an older caller", async () => {
  const row = { id: "cold-named", name: "Anthropic", vendorKey: "anthropic", baseUrl: "https://api.anthropic.com/v1" };
  const h = harness(await fixtureCatalog(), [row]);
  const result = await h.call({ providerId: row.id, baseUrl: row.baseUrl, modelId: "claude-opus-4-6" });
  assert.equal(result.info.providerId, row.id);
  assert.equal(result.info.contextWindow, 1_000_000);
  assert.equal(result.info.catalogSource, "models.dev");
  assert.deepEqual(h.hostCalls, ["providers.list"]);
  assert.deepEqual(h.catalogCalls.slice(0, 2), [["configureAccount", row], "ensureLoaded"]);
});

test("an unresolved account cannot fall back to model-name or endpoint matching", async () => {
  for (const providers of [undefined, [], [{ id: "unknown-key", name: "Old row" }]]) {
    const h = harness(await fixtureCatalog(), providers);
    const result = await h.call({ providerId: "unknown-key", baseUrl: "https://api.anthropic.com/v1", modelId: "claude-opus-4-6" });
    assert.deepEqual(result, { info: null });
    assert.deepEqual(h.hostCalls, ["providers.list"]);
    assert.ok(!h.catalogCalls.some(call => call === "ensureLoaded" || call[0] === "findModel"));
  }
});
