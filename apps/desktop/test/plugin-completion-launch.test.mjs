import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { OAUTH_AUTH_KIND } = await import("../electron/main/oauth.ts");

function fixture({ authKind = "apiKey", vendorBinding } = {}) {
  const calls = [];
  const provider = {
    id: "fixture-provider", name: "Fixture", enabled: true, authKind,
    baseUrl: "http://127.0.0.1:1/v1", apiStyle: "openai-chat",
    headers: { "X-Fixture": "completion" }, models: [{ id: "title-model" }],
  };
  const sessionProjects = new Map();
  const unexpected = () => { throw new Error("Completion must not initialize session tools"); };
  const runtime = createSessionLaunchRuntime({
    runtimeState: { host: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "providers.list") return { providers: [provider] };
        if (method === "providers.getSecret") return { value: "fixture-secret" };
        throw new Error(`Unexpected host call ${method}`);
      },
    } },
    logger: { app: unexpected }, userMcp: { setRecords: unexpected, toolsForProject: unexpected },
    plugins: { listLoaded: unexpected, getSkills: unexpected, getTools: unexpected },
    sessionProjects, dataDir: process.env.PI_SCRATCH_DIR,
    vendorOAuth: {
      bindingFor: async (providerId, modelId) => {
        assert.equal(providerId, provider.id);
        assert.equal(modelId, "title-model");
        return vendorBinding;
      },
    },
    modelsDevCatalog: { ensureLoaded: async () => {}, configureAccount() {}, findModel: () => undefined },
    getWorkspacePath: unexpected, pluginActiveInProject: unexpected,
    bindingForModel: (row, id) => row.models.find((binding) => binding.id === id),
    effectiveSubagentModelConfig: unexpected,
    normalizeThinkingLevel: () => "off",
  });
  return { runtime, provider, calls, sessionProjects };
}

test("插件独立补全无需真实会话、工作目录或工具环境", async () => {
  const f = fixture();
  const result = await f.runtime.resolveAgentModel({}, {}, {
    providerId: f.provider.id, modelId: "title-model", thinkingLevel: "off",
  });
  assert.equal(result.providerId, f.provider.id);
  assert.equal(result.modelId, "title-model");
  assert.equal(result.thinkingLevel, "off");
  assert.equal(result.provider.apiKey, "fixture-secret");
  assert.equal(result.provider.baseUrl, f.provider.baseUrl);
  assert.equal(result.provider.apiStyle, "openai-chat");
  assert.deepEqual(result.provider.headers, f.provider.headers);
  assert.deepEqual(f.calls, [
    { method: "providers.list", params: { includeDisabled: false } },
    { method: "providers.getSecret", params: { id: f.provider.id } },
  ]);
  assert.equal(f.sessionProjects.size, 0);
});

test("插件补全保留 OAuth 模型端点且不读取 API 密钥", async () => {
  const binding = { baseUrl: "http://127.0.0.1:2/v1", apiStyle: "openai-responses" };
  const f = fixture({ authKind: OAUTH_AUTH_KIND, vendorBinding: binding });
  const result = await f.runtime.resolveAgentModel({
    worktree: { isolated: true }, remoteWorkspace: { hostKey: "offline", path: "/fixture" },
  }, {}, { providerId: f.provider.id, modelId: "title-model" });
  assert.equal(result.provider.authKind, OAUTH_AUTH_KIND);
  assert.equal(result.provider.baseUrl, binding.baseUrl);
  assert.equal(result.provider.apiStyle, binding.apiStyle);
  assert.equal(result.provider.apiKey, "");
  assert.deepEqual(f.calls.map((call) => call.method), ["providers.list"]);
  assert.equal(f.sessionProjects.size, 0);
});
