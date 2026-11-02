import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { planOwnedProviderImport, saveImportedProvider, removeImportedProviders, restoreImportedProviderOrder } =
  await import("../electron/main/provider-import.ts");

const kept = { id: "kept", name: "Kept", vendorKey: "kept" };
const extra = { id: "extra", name: "Extra", vendorKey: "extra" };
const plugin = { id: "plugin", name: "Plugin", ownerPluginId: "example.plugin" };

test("完整覆盖只移除未备份的手动条目，同名条目保留原 ID", () => {
  const plan = planOwnedProviderImport([kept, extra, plugin], [{ name: "Kept" }, { name: "New" }]);
  assert.deepEqual(plan.steps.map(({ action, id }) => ({ action, id })), [
    { action: "update", id: "kept" }, { action: "create", id: undefined },
  ]);
  assert.deepEqual(plan.removals, [extra]);
  assert.deepEqual(planOwnedProviderImport([kept, plugin], []).removals, [kept]);
  assert.throws(() => planOwnedProviderImport([kept], [{ name: "Kept" }, { name: "kept" }]), /重复/);
});

test("两个入口共用的保存逻辑保留显式空值，旧文件缺失字段保持省略", async () => {
  const calls = [];
  const host = { call: async (method, params) => {
    calls.push({ method, params });
    return { provider: kept };
  } };
  await saveImportedProvider(host, { action: "update", id: kept.id, key: "kept", entry: {
    name: kept.name, models: [], headers: {}, baseUrl: "", supportedThinkingLevels: [], enabled: false,
  } });
  assert.deepEqual(calls[0], { method: "providers.update", params: {
    id: kept.id, name: kept.name, models: [], headers: {}, baseUrl: "", supportedThinkingLevels: [], enabled: false,
  } });
  calls.length = 0;
  await saveImportedProvider(host, { action: "update", id: kept.id, key: "kept", entry: { name: kept.name } });
  assert.deepEqual(calls[0].params, { id: kept.id, name: kept.name });
});

test("新建禁用提供商后恢复禁用状态，状态保存失败如实返回失败", async () => {
  const calls = [];
  const host = { call: async (method, params) => {
    calls.push({ method, params });
    return { provider: { ...kept, enabled: method !== "providers.update" } };
  } };
  const step = { action: "create", key: "kept", entry: { name: kept.name, enabled: false } };
  assert.equal((await saveImportedProvider(host, step)).enabled, false);
  assert.equal("enabled" in calls[0].params, false);
  assert.deepEqual(calls[1], { method: "providers.update", params: { id: kept.id, enabled: false } });
  await assert.rejects(saveImportedProvider({ call: async (method) => ({ provider: method === "providers.create" ? kept : null }) }, step), /状态保存失败/);
});

test("先解除可编辑模型引用再移除提供商，保留其他绑定及插件", async () => {
  const calls = [];
  const settings = {
    defaultProviderId: extra.id, defaultModelId: "old", compactionProviderId: kept.id, compactionModelId: "keep",
    imageGeneration: { providerId: extra.id, modelId: "old-image" },
    imageGenerationModels: [{ providerId: extra.id, modelId: "old-image" }, { providerId: kept.id, modelId: "keep-image" }],
    speech: { transcribe: { providerId: extra.id, modelId: "old", protocol: "openai_audio" } },
  };
  const agents = [{ id: "helper", model: "extra/old", fallbackModels: ["Extra/old", "kept/keep"],
    fallbackThinkingLevels: { "Extra/old": "high", "kept/keep": "low" } }];
  const host = { call: async (method, params) => {
    calls.push({ method, params });
    if (method === "settings.get") return settings;
    if (method === "settings.set") { Object.assign(settings, params); return { ok: true }; }
    if (method === "agents.list") return { subagents: agents };
    if (method === "agents.update") return { subagent: { ...agents[0], ...params.subagent } };
    if (method === "providers.delete") return { ok: true };
    throw new Error(`Unexpected ${method}`);
  } };
  await removeImportedProviders(host, [extra], [kept, extra, plugin]);
  assert.equal(settings.defaultProviderId, "");
  assert.equal(settings.compactionProviderId, kept.id);
  assert.equal(settings.imageGeneration, null);
  assert.deepEqual(settings.imageGenerationModels, [{ providerId: kept.id, modelId: "keep-image" }]);
  assert.deepEqual(settings.speech, {});
  const update = calls.find(({ method }) => method === "agents.update");
  assert.deepEqual(update.params.subagent, { model: "", fallbackModels: ["kept/keep"], fallbackThinkingLevels: { "kept/keep": "low" } });
  assert.deepEqual(calls.at(-1), { method: "providers.delete", params: { id: extra.id } });
});

test("解除引用失败时不删除提供商", async () => {
  const calls = [];
  const host = { call: async (method) => {
    calls.push(method);
    if (method === "settings.get") return { defaultProviderId: extra.id };
    if (method === "settings.set") throw new Error("fixture write failure");
    throw new Error(`Unexpected ${method}`);
  } };
  await assert.rejects(removeImportedProviders(host, [extra], [extra]), /fixture write failure/);
  assert.equal(calls.includes("providers.delete"), false);
});

test("按备份顺序恢复提供商排列", async () => {
  const calls = [];
  const host = { call: async (method, params) => { calls.push({ method, params }); return { ok: true }; } };
  await restoreImportedProviderOrder(host, [{ name: "Kept" }, { name: "Extra" }], [extra, plugin, kept]);
  assert.deepEqual(calls, [{ method: "providers.reorder", params: { id: kept.id, targetId: extra.id, placement: "before" } }]);
});

test("备份显式空密钥会清除 API key，省略密钥保留本机授权", async () => {
  const calls = [];
  const host = { call: async (method, params) => { calls.push({ method, params }); return { provider: kept }; } };
  const step = { action: "update", id: kept.id, key: "kept", entry: { name: kept.name, apiKey: "" } };
  await saveImportedProvider(host, step);
  assert.deepEqual(calls.at(-1), { method: "providers.setSecret", params: { id: kept.id, secretValue: "" } });
  calls.length = 0;
  await saveImportedProvider(host, { ...step, entry: { name: kept.name } });
  assert.deepEqual(calls.map(({ method }) => method), ["providers.update"]);
});
