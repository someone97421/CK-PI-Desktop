import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { genericModelConfig, findSubagentProviderSource, subagentProviderLookupError } from "@pi-desktop/agent-runtime";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildProviderModel } = await import("../../../packages/agent-runtime/dist/provider-binding.js");
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const { ModelsDevCatalog, catalogModelConfigFor } = await import("../electron/main/models-dev-catalog.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-oauth-subagent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = id => ({ id, contextWindow: 500_000, contextWindowSource: "user", maxTokens: 32_000, maxTokensSource: "user", thinkingLevels: ["high"], availableForSubagents: true });
  const parent = { id: "parent", name: "Parent", vendorKey: "custom", enabled: true, authKind: "none", apiStyle: "chat_completions", baseUrl: "https://parent.example/v1", models: [binding("parent-model")] };
  parent.models[0].availableForSubagents = false;
  const account = { id: "copilot-row", name: "Copilot", vendorKey: "github-copilot", enabled: true, authKind: "oauth", apiStyle: "responses", baseUrl: "https://row.example/v1", models: [binding("claude-sonnet-4-6"), binding("gpt-6.1-sol")] };
  const providers = [parent, account];
  const routes = {
    "claude-sonnet-4-6": { apiStyle: "anthropic_messages", baseUrl: "https://copilot.example/anthropic", api: "anthropic-messages" },
    "gpt-6.1-sol": { apiStyle: "responses", baseUrl: "https://copilot.example/openai", api: "openai-responses" },
  };
  const vendorOAuth = { bindingFor: async (_id, modelId) => ({
    apiStyle: routes[modelId].apiStyle, baseUrl: routes[modelId].baseUrl,
    modelConfig: { ...genericModelConfig(modelId, routes[modelId].baseUrl), source: "models.dev", reasoning: true, supportedThinkingLevels: ["high"] },
  }) };
  const modelsDevCatalog = new ModelsDevCatalog({ catalogPath: fileURLToPath(new URL("../resources/models.dev/api.json", import.meta.url)) });
  await modelsDevCatalog.ensureLoaded();
  const modelRuntime = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog });
  const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
  const runtimeState = { host: { isAvailable: () => true, call: async method => {
    if (method === "commandShells.list") return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
    if (method === "providers.list") return { providers };
    if (method === "providers.getSecret") return {};
    if (method === "agents.active") return { subagents: [] };
    if (method === "agents.disabledBuiltins") return { disabled: [] };
    if (method === "skills.active") return { skills: [] };
    if (method === "mcp.active") return { servers: [] };
    if (method === "project.memory.get") return {};
    throw new Error(`Unexpected host call ${method}`);
  } } };
  return { root, parent, account, providers, routes, runtimeState, vendorOAuth, modelsDevCatalog, modelRuntime };
}

function checkRoute(provider, modelId, routes) {
  assert.equal(provider.apiStyle, routes[modelId].apiStyle);
  assert.equal(provider.baseUrl, routes[modelId].baseUrl);
  assert.equal(provider.modelConfig.baseUrl, routes[modelId].baseUrl);
  assert.equal(buildProviderModel(provider).api, routes[modelId].api);
  assert.equal(provider.modelConfig.contextWindow, 500_000);
}

test("launch keeps each OAuth delegate's protocol and endpoint instead of the account default", async t => {
  const f = await fixture(t);
  const runtime = createSessionLaunchRuntime({
    runtimeState: f.runtimeState, logger: { app() {} },
    userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: f.root, vendorOAuth: f.vendorOAuth, modelsDevCatalog: f.modelsDevCatalog,
    getWorkspacePath: () => f.root, pluginActiveInProject: () => true,
    bindingForModel: f.modelRuntime.bindingForModel, effectiveSubagentModelConfig: f.modelRuntime.effectiveSubagentModelConfig,
    normalizeThinkingLevel: () => "high",
  });
  const launch = await runtime.resolveAgentRuntimeLaunch("session", { providerId: f.parent.id, modelId: "parent-model", projectPath: f.root }, {});
  for (const modelId of Object.keys(f.routes)) {
    checkRoute(launch.sidecarParams.subagentProviders[`github-copilot/${modelId}`], modelId, f.routes);
  }
});

test("on-demand Task.model uses the same OAuth protocol/endpoint selection", async t => {
  const f = await fixture(t);
  // Run the actual registered callback without starting an Electron sidecar.
  const source = await readFile(new URL("../electron/main/runtime/sidecar.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("sidecar.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callbacks = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setSubagentModelResolver") callbacks.push(node.arguments[0].getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(callbacks.length, 1);
  const callback = ts.transpileModule(`(${callbacks[0]})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const env = {
    listRuntimeProviders: async () => f.providers, findSubagentProviderSource, subagentProviderLookupError,
    runtimeState: f.runtimeState, modelsDevCatalog: f.modelsDevCatalog, vendorOAuth: f.vendorOAuth,
    OAUTH_AUTH_KIND: "oauth", catalogModelConfigFor, effectiveSubagentModelConfig: f.modelRuntime.effectiveSubagentModelConfig,
  };
  const resolve = new Function(...Object.keys(env), `return ${callback}`)(...Object.values(env));
  for (const modelId of Object.keys(f.routes)) checkRoute(await resolve(`github-copilot/${modelId}`), modelId, f.routes);
  await assert.rejects(resolve("github-copilot/not-enabled"), /not enabled for delegation/);
});
