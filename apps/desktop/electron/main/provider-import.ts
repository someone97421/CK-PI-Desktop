import {
  planProviderImport, providerImportKey, providerImportPayload,
  type AppSettings, type ProviderExportEntry, type ProviderImportStep, type UserSubagentRecord,
} from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";
import type { ProviderRow } from "./provider-config-transfer";

export function planOwnedProviderImport(providers: ProviderRow[], entries: ProviderExportEntry[]) {
  const owned = providers.filter((provider) => !provider.ownerPluginId);
  for (const entry of entries) {
    if (owned.filter((provider) => providerImportKey(provider) === providerImportKey(entry)).length > 1) {
      throw new Error("本机存在同名提供商，请先在模型设置中区分名称。");
    }
  }
  const plan = planProviderImport(owned, entries);
  if (plan.duplicates.length) throw new Error("导入文件存在重复提供商名称，请先区分名称。");
  const names = new Set(entries.map(providerImportKey));
  return { steps: plan.steps, removals: owned.filter((provider) => !names.has(providerImportKey(provider))) };
}

export async function saveImportedProvider(host: HostProcess, step: ProviderImportStep): Promise<ProviderRow> {
  const { enabled, ...fields } = providerImportPayload(step.entry);
  const payload = { ...fields,
    ...(step.entry.apiKey?.trim() ? { secretValue: step.entry.apiKey.trim() } : {}),
  };
  const { provider } = await host.call<{ provider: ProviderRow }>(`providers.${step.action}`, {
    ...payload,
    ...(step.id ? { id: step.id } : {}),
    ...(step.action === "update" && enabled !== undefined ? { enabled } : {}),
  });
  if (!provider) throw new Error("提供商保存失败");
  if (step.action === "update" && step.entry.apiKey !== undefined && !step.entry.apiKey.trim()) {
    const saved = await host.call<{ provider: ProviderRow }>("providers.setSecret", { id: provider.id, secretValue: "" });
    if (!saved.provider) throw new Error("提供商密钥清空失败");
    return saved.provider;
  }
  if (step.action === "create" && enabled === false) {
    const saved = await host.call<{ provider: ProviderRow }>("providers.update", { id: provider.id, enabled: false });
    if (!saved.provider) throw new Error("提供商启用状态保存失败");
    return saved.provider;
  }
  return provider;
}

export async function restoreImportedProviderOrder(host: HostProcess, entries: ProviderExportEntry[], providers: ProviderRow[]) {
  const ids = entries.map((entry) => providers.find((provider) =>
    !provider.ownerPluginId && providerImportKey(provider) === providerImportKey(entry))?.id);
  for (let index = ids.length - 2; index >= 0; index--) {
    const id = ids[index], targetId = ids[index + 1];
    if (id && targetId) await host.call("providers.reorder", { id, targetId, placement: "before" });
  }
}

/** 移除配置前解除可编辑绑定，历史会话及插件托管配置保持原记录。 */
export async function removeImportedProviders(
  host: HostProcess,
  removals: ProviderRow[],
  providers: ProviderRow[],
  saveSettings: (patch: Partial<AppSettings>) => Promise<unknown> = (patch) => host.call("settings.set", patch),
) {
  if (!removals.length) return;
  const ids = new Set(removals.map((provider) => provider.id));
  const settings = await host.call<AppSettings>("settings.get");
  const patch: Partial<AppSettings> = {};
  if (settings.defaultProviderId && ids.has(settings.defaultProviderId)) {
    patch.defaultProviderId = ""; patch.defaultModelId = "";
  }
  if (settings.compactionProviderId && ids.has(settings.compactionProviderId)) {
    patch.compactionProviderId = ""; patch.compactionModelId = "";
  }
  if (settings.imageGeneration && ids.has(settings.imageGeneration.providerId)) patch.imageGeneration = null;
  if (settings.imageGenerationModels?.some((binding) => ids.has(binding.providerId))) {
    patch.imageGenerationModels = settings.imageGenerationModels.filter((binding) => !ids.has(binding.providerId));
  }
  if (settings.speech && Object.values(settings.speech).some((binding) => binding && ids.has(binding.providerId))) {
    patch.speech = Object.fromEntries(Object.entries(settings.speech).filter(([, binding]) => !binding || !ids.has(binding.providerId)));
  }
  if (Object.keys(patch).length) await saveSettings(patch);
  const usesRemovedProvider = (pin: string) => {
    const slash = pin.indexOf("/");
    if (slash < 1) return false;
    const key = pin.slice(0, slash).trim().toLowerCase();
    const matches = providers.filter((provider) => [provider.id, provider.name, provider.vendorKey]
      .some((value) => value?.trim().toLowerCase() === key));
    return matches.length === 1 && ids.has(matches[0]!.id);
  };
  const { subagents } = await host.call<{ subagents: UserSubagentRecord[] }>("agents.list");
  for (const agent of subagents) {
    const modelRemoved = !!agent.model && usesRemovedProvider(agent.model);
    const fallbackModels = (agent.fallbackModels ?? []).filter((pin) => !usesRemovedProvider(pin));
    if (!modelRemoved && fallbackModels.length === (agent.fallbackModels ?? []).length) continue;
    const { subagent } = await host.call<{ subagent: UserSubagentRecord | null }>("agents.update", {
      id: agent.id, subagent: {
        ...(modelRemoved ? { model: "" } : {}), fallbackModels,
        fallbackThinkingLevels: Object.fromEntries(Object.entries(agent.fallbackThinkingLevels ?? {})
          .filter(([pin]) => fallbackModels.includes(pin))),
      },
    });
    if (!subagent) throw new Error("移除提供商前解除子智能体绑定失败");
  }
  for (const provider of removals) {
    const result = await host.call<{ ok: boolean }>("providers.delete", { id: provider.id });
    if (!result.ok) throw new Error(`提供商 ${provider.name} 移除失败`);
  }
}
