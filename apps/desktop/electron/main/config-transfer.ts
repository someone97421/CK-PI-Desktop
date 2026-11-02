import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { app, dialog } from "electron";
import { globalInstructionPath } from "@pi-desktop/agent-runtime";
import {
  APPEARANCE_KEYS, CONFIG_SCOPES, CONFIG_SCOPE_LABELS, KEYBOARD_SHORTCUTS, SUBAGENT_THINKING_LEVELS,
  PORTABLE_SETTING_SCOPES, exportPortableSettings, parsePortableSettings, portableSettingLabel,
  defaultCommandShellForPlatform, isAllowedKeybinding, isReservedKeybinding, isReportIntervalSteps,
  parseProviderExportFile, planProviderImport,
  type AppSettings, type ConfigExportFile, type ConfigScope, type ConfigTransferResult,
  type UserSubagentRecord, type ShortcutPlatform, type PortableSettings, type CommandShellCatalog,
} from "@pi-desktop/shared";
import { collectProviderConfig, type ProviderRow } from "./provider-config-transfer";
import type { HostProcess } from "./host-process";
import type { AppearanceMediaStore } from "./appearance-media";
import { chooseConfigImportMode } from "./config-import-mode";
import { appearanceOf, appearanceLabels, parseAppearance } from "./config-transfer-appearance";
import { planOwnedProviderImport, removeImportedProviders, restoreImportedProviderOrder, saveImportedProvider } from "./provider-import";
import { resolveDefaultUpdatePreference } from "./update-policy";

type Dependencies = {
  host: HostProcess;
  saveSettings: (patch: Partial<AppSettings>) => Promise<unknown>;
  appearanceMedia: AppearanceMediaStore;
  validateSettings?: (settings: Partial<AppSettings>) => unknown;
};
const filters = [{ name: "JSON 配置文件", extensions: ["json"] }];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function invalid(message: string): never { throw new Error(`配置文件无效：${message}`); }
async function readInstructions() {
  try { return await fs.readFile(globalInstructionPath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

function remapMediaProviders(values: PortableSettings, resolveProvider: (id: string) => string): PortableSettings {
  const mapped = { ...values };
  const binding = <T extends { providerId: string }>(entry: T): T => ({ ...entry, providerId: resolveProvider(entry.providerId) });
  if (mapped.imageGeneration) mapped.imageGeneration = binding(mapped.imageGeneration);
  if (mapped.imageGenerationModels) mapped.imageGenerationModels = mapped.imageGenerationModels.map(binding);
  if (mapped.speech) mapped.speech = Object.fromEntries(Object.entries(mapped.speech)
    .map(([role, entry]) => [role, entry ? binding(entry) : entry]));
  return mapped;
}

/** 在任何写入之前检查所有范围；未知字段不能进入设置或子智能体写入接口。 */
function parseFile(raw: string): ConfigExportFile {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { invalid("JSON 格式不正确"); }
  if (record(value) && value.kind === "pi-desktop.providers") {
    const parsed = parseProviderExportFile(value);
    if (!parsed.ok) invalid("模型文件格式或版本不正确");
    if (parsed.warnings.length || planProviderImport([], parsed.file.providers).duplicates.length) invalid("提供商条目无效或名称重复");
    return { kind: "this-is-a-agent.config", version: 1, exportedAt: parsed.file.exportedAt,
      models: { providers: parsed.file, defaults: {} } };
  }
  if (!record(value) || value.kind !== "this-is-a-agent.config" || ![1, 2].includes(value.version as number)) invalid("不支持的文件类型或版本");
  const file = value as unknown as ConfigExportFile;
  if (!CONFIG_SCOPES.some((scope) => file[scope] !== undefined)) invalid("没有可导入的范围");
  if (file.appearance !== undefined) file.appearance = parseAppearance(file.appearance);
  for (const scope of PORTABLE_SETTING_SCOPES) {
    if (file[scope] !== undefined) file[scope] = parsePortableSettings(file[scope], scope);
  }
  if (file.shortcuts !== undefined) {
    if (!record(file.shortcuts)) invalid("快捷键不正确");
    for (const [id, binding] of Object.entries(file.shortcuts)) {
      if (!KEYBOARD_SHORTCUTS.some((s) => s.id === id) || binding !== null &&
        (typeof binding !== "string" || !isAllowedKeybinding(binding) || isReservedKeybinding(binding, process.platform as ShortcutPlatform))) invalid(`快捷键 ${id} 不可用`);
    }
  }
  if (file.instructions !== undefined && typeof file.instructions !== "string") invalid("指令必须是文本");
  if (file.providerRefs !== undefined && (!Array.isArray(file.providerRefs) || file.providerRefs.some((r) =>
    !record(r) || typeof r.id !== "string" || typeof r.name !== "string" || r.ownerPluginId != null && typeof r.ownerPluginId !== "string"))) invalid("提供商映射不正确");
  if (file.models !== undefined) {
    if (!record(file.models) || !record(file.models.defaults)) invalid("模型配置不正确");
    const parsed = parseProviderExportFile(file.models.providers);
    if (!parsed.ok) invalid("模型文件格式或版本不正确");
    if (parsed.warnings.length) invalid(parsed.warnings.join("；"));
    file.models.providers = parsed.file;
    if (planProviderImport([], parsed.file.providers).duplicates.length) invalid("模型配置存在重复提供商名称");
    const keys = ["defaultProviderId", "defaultModelId", "compactionProviderId", "compactionModelId"];
    if (Object.entries(file.models.defaults).some(([k, v]) => !keys.includes(k) || typeof v !== "string")) invalid("默认模型不正确");
  }
  if (file.subagents !== undefined) {
    const s = file.subagents;
    if (!record(s) || !Array.isArray(s.owned) || !Array.isArray(s.disabledBuiltins) || s.disabledBuiltins.some((id) => typeof id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 40)) invalid("子智能体配置不正确");
    const seen = new Set<string>();
    const keys = ["id", "name", "description", "body", "tools", "model", "fallbackModels", "fallbackThinkingLevels", "thinkingLevel", "maxTokens", "reportIntervalSteps", "enabled"];
    for (const agent of s.owned) {
      if (!record(agent) || typeof agent.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id) || agent.id.length > 40 || seen.has(agent.id) ||
        Object.keys(agent).some((k) => !keys.includes(k)) || agent.name !== agent.id ||
        typeof agent.body !== "string" || typeof agent.description !== "string" || !agent.description.trim() ||
        !Array.isArray(agent.tools) || !agent.tools.length || agent.tools.some((t) => typeof t !== "string") ||
        typeof agent.enabled !== "boolean" || typeof agent.model !== "string" ||
        !Array.isArray(agent.fallbackModels) || agent.fallbackModels.some((m) => typeof m !== "string") ||
        typeof agent.thinkingLevel !== "string" || !["", ...SUBAGENT_THINKING_LEVELS].includes(agent.thinkingLevel) ||
        typeof agent.maxTokens !== "number" || !Number.isInteger(agent.maxTokens) || agent.maxTokens < 0) invalid("子智能体字段无效或名称重复");
      const fallbackPins = agent.fallbackModels;
      if (agent.fallbackThinkingLevels !== undefined && (!record(agent.fallbackThinkingLevels) ||
        Object.entries(agent.fallbackThinkingLevels).some(([pin, level]) =>
          !fallbackPins.includes(pin) || typeof level !== "string" ||
          !(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(level)))) invalid("备用模型思考强度配置不正确");
      seen.add(agent.id);
      if (agent.reportIntervalSteps !== undefined && agent.reportIntervalSteps !== null && !isReportIntervalSteps(agent.reportIntervalSteps)) invalid("子智能体汇报间隔必须为正安全整数");
    }
  }
  return file;
}

export async function exportConfig({ host, appearanceMedia }: Dependencies, scopes: ConfigScope[]): Promise<ConfigTransferResult> {
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !CONFIG_SCOPES.includes(s))) throw new Error("请选择导出范围");
  const picked = await dialog.showSaveDialog({ title: "导出配置", defaultPath: `this-is-a-agent-config-${new Date().toISOString().slice(0, 10)}.json`, filters });
  const result: ConfigTransferResult = { applied: 0, skipped: 0, failed: 0, warnings: [] };
  if (picked.canceled || !picked.filePath) return { ...result, canceled: true };
  const settings = await host.call<AppSettings>("settings.get");
  const file: ConfigExportFile = { kind: "this-is-a-agent.config", version: 2, exportedAt: new Date().toISOString() };
  const portableSettings = { ...settings,
    defaultCommandShell: settings.defaultCommandShell ?? defaultCommandShellForPlatform(process.platform),
    temporaryWorkspaceContextMenu: settings.temporaryWorkspaceContextMenu ?? true,
    updatePreference: settings.updatePreference ?? resolveDefaultUpdatePreference(process.platform, app.isPackaged),
  };
  for (const scope of PORTABLE_SETTING_SCOPES) {
    if (scopes.includes(scope)) file[scope] = exportPortableSettings(portableSettings, scope);
  }
  if (scopes.includes("appearance")) file.appearance = {
    ...appearanceOf(settings),
    media: await appearanceMedia.exportMedia(),
  };
  if (scopes.includes("shortcuts")) file.shortcuts = settings.keybindings ?? {};
  if (scopes.includes("instructions")) file.instructions = await readInstructions();
  if (scopes.includes("models")) {
    const collected = await collectProviderConfig(host);
    file.models = { providers: collected.file, defaults: {
      defaultProviderId: settings.defaultProviderId ?? "", defaultModelId: settings.defaultModelId ?? "",
      compactionProviderId: settings.compactionProviderId ?? "", compactionModelId: settings.compactionModelId ?? "",
    } };
    file.providerRefs = collected.providers.map(({ id, name, ownerPluginId }) => ({ id, name, ownerPluginId }));
  }
  if (scopes.includes("media") && !file.providerRefs) {
    const { providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", { includeDisabled: true });
    file.providerRefs = providers.map(({ id, name, ownerPluginId }) => ({ id, name, ownerPluginId }));
  }
  if (scopes.includes("subagents")) {
    if (!file.providerRefs) {
      const { providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", { includeDisabled: true });
      file.providerRefs = providers.map(({ id, name, ownerPluginId }) => ({ id, name, ownerPluginId }));
    }
    const { subagents } = await host.call<{ subagents: UserSubagentRecord[] }>("agents.list");
    const { disabled } = await host.call<{ disabled: string[] }>("agents.disabledBuiltins");
    file.subagents = { owned: [], disabledBuiltins: disabled };
    for (const agent of subagents) {
      const { body } = await host.call<{ body: string }>("agents.read", { id: agent.id });
      file.subagents.owned.push({ id: agent.id, name: agent.id, description: agent.description, body,
        tools: agent.tools, model: agent.model ?? "", fallbackModels: agent.fallbackModels ?? [],
        fallbackThinkingLevels: agent.fallbackThinkingLevels ?? {},
        thinkingLevel: agent.thinkingLevel ?? "", maxTokens: agent.maxTokens ?? 0,
        reportIntervalSteps: agent.reportIntervalSteps ?? null, enabled: agent.enabled });
    }
  }
  await fs.writeFile(picked.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...result, applied: new Set(scopes).size };
}

export async function importConfig({ host, saveSettings, appearanceMedia, validateSettings }: Dependencies): Promise<ConfigTransferResult> {
  const result: ConfigTransferResult = { applied: 0, skipped: 0, failed: 0, warnings: [] };
  const picked = await dialog.showOpenDialog({ title: "导入配置", properties: ["openFile"], filters });
  if (picked.canceled || !picked.filePaths[0]) return { ...result, canceled: true };
  const raw = await fs.readFile(picked.filePaths[0], "utf8");
  const file = parseFile(raw);
  // 外观导出内嵌原始媒体，不对它施加文件大小上限；其他范围沿用原限制。
  if (file.appearance === undefined && Buffer.byteLength(raw) > 20 * 1024 * 1024) throw new Error("配置文件不能超过 20 MB");
  const settings = await host.call<AppSettings>("settings.get");
  const importedShell = file.general?.defaultCommandShell;
  if (importedShell !== undefined) {
    let available = false;
    try {
      const catalog = await host.call<CommandShellCatalog>("commandShells.list");
      available = catalog.choices.some((choice) => choice.id === importedShell && choice.available);
    } catch { }
    if (!available) {
      delete file.general!.defaultCommandShell;
      result.skipped++;
      result.warnings.push(`默认 Shell ${importedShell} 在目标机器不可用或无法确认，已保留本机设置。`);
    }
  }
  type Operation = { label: string; conflict: boolean; apply: () => Promise<unknown> };
  const operations: Operation[] = [];
  const removals: { label: string; apply: () => Promise<unknown> }[] = [];
  if (validateSettings) {
    const { media: _media, ...appearance } = file.appearance ?? {};
    validateSettings(appearance);
    for (const scope of PORTABLE_SETTING_SCOPES) if (file[scope]) validateSettings(file[scope]!);
  }
  const add = (label: string, conflict: boolean, apply: Operation["apply"]) => operations.push({ label, conflict, apply });
  if (file.appearance) {
    const current = appearanceOf(settings);
    for (const key of APPEARANCE_KEYS) {
      const value = file.appearance[key];
      if (value !== undefined && !isDeepStrictEqual(current[key], value)) add(`外观 · ${appearanceLabels[key]}`, true, () => saveSettings({ [key]: value }));
    }
    if (record(file.appearance.media)) {
      const currentMedia = await appearanceMedia.exportMedia();
      for (const kind of ["icon", "home"] as const) {
        if (!Object.prototype.hasOwnProperty.call(file.appearance.media, kind)) continue;
        const asset = appearanceMedia.parseExportAsset(kind, file.appearance.media[kind]);
        // 格式不匹配的媒体直接忽略，不影响其他外观项导入。
        if (asset === undefined || isDeepStrictEqual(currentMedia[kind], asset)) continue;
        add(`外观 · ${kind === "icon" ? "应用图标" : "主页媒体"}`, currentMedia[kind] != null, async () => {
          await appearanceMedia.importAsset(kind, asset);
        });
      }
    }
  }
  if (file.shortcuts !== undefined && !isDeepStrictEqual(settings.keybindings ?? {}, file.shortcuts)) {
    add("快捷键", Object.keys(settings.keybindings ?? {}).length > 0, () => saveSettings({ keybindings: file.shortcuts }));
  }
  if (file.instructions !== undefined) {
    const current = await readInstructions();
    if (current !== file.instructions) add("全局指令", !!current.trim(), async () => {
      const path = globalInstructionPath();
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, file.instructions!, "utf8");
    });
  }
  let providers: ProviderRow[] = [];
  if (file.models || file.subagents || file.media) ({ providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", { includeDisabled: true }));
  const refs = new Map((file.providerRefs ?? []).map((ref) => [ref.id, ref]));
  const resolveProvider = (id: string): string => {
    if (!id) return "";
    const ref = refs.get(id);
    const matches = providers.filter((p) => ref
      ? p.name.trim().toLowerCase() === ref.name.trim().toLowerCase() && (p.ownerPluginId ?? null) === (ref.ownerPluginId ?? null)
      : p.id === id);
    if (matches.length !== 1) throw new Error("依赖的模型提供商不存在或名称不唯一，请先导入或配置对应提供商");
    return matches[0].id;
  };
  if (file.models) {
    const plan = planOwnedProviderImport(providers, file.models.providers.providers);
    for (const step of plan.steps) add(`模型 · ${step.entry.name}`, step.action === "update", async () => {
      const provider = await saveImportedProvider(host, step);
      providers = [...providers.filter((row) => row.id !== provider.id), provider];
    });
    for (const provider of plan.removals) removals.push({ label: `提供商 · ${provider.name}`, apply: async () => {
      await removeImportedProviders(host, [provider], providers, saveSettings);
      providers = providers.filter((row) => row.id !== provider.id);
    } });
    for (const [pk, mk] of [["defaultProviderId", "defaultModelId"], ["compactionProviderId", "compactionModelId"]] as const) {
      const defaults = file.models.defaults;
      if (defaults[pk] === undefined || defaults[mk] === undefined) continue;
      let unchanged = false;
      try { unchanged = resolveProvider(defaults[pk]!) === (settings[pk] ?? "") && defaults[mk] === (settings[mk] ?? ""); } catch { /* 新提供商将在前面的操作中建立。 */ }
      if (!unchanged) add(pk === "defaultProviderId" ? "默认模型" : "压缩模型", !!settings[pk] || !!settings[mk], () => saveSettings({ [pk]: resolveProvider(defaults[pk]!), [mk]: defaults[mk] }));
    }
  }
  if (file.subagents) {
    const { subagents } = await host.call<{ subagents: UserSubagentRecord[] }>("agents.list");
    const existing = new Set(subagents.map((a) => a.id));
    const addedCount = file.subagents.owned.filter((agent) => !existing.has(agent.id)).length;
    if (existing.size + addedCount > 64) {
      throw new Error(`当前有 ${existing.size} 个自定义子智能体，导入需新增 ${addedCount} 个，保存阶段会超过宿主的 64 个上限。请先移除不再需要的子智能体后重试；本次尚未写入配置。`);
    }
    const incoming = new Set(file.subagents.owned.map((agent) => agent.id));
    for (const agent of subagents.filter((row) => !incoming.has(row.id))) removals.push({
      label: `子智能体 · ${agent.id}`, apply: async () => {
        const removed = await host.call<{ ok: boolean }>("agents.remove", { id: agent.id });
        if (!removed.ok) throw new Error("子智能体移除失败");
      },
    });
    const pin = (value: string) => {
      if (!value) return "";
      const slash = value.indexOf("/");
      if (slash < 1) throw new Error("子智能体模型绑定格式不正确");
      const providerPart = value.slice(0, slash);
      // 常规绑定使用 vendorKey / 名称，本身可移植；只有消歧用的 UUID 需要映射。
      return refs.has(providerPart) ? `${resolveProvider(providerPart)}/${value.slice(slash + 1)}` : value;
    };
    for (const agent of file.subagents.owned) add(`子智能体 · ${agent.id}`, existing.has(agent.id), async () => {
      const { id, ...input } = agent;
      const subagent = {
        ...input,
        model: pin(input.model ?? ""),
        fallbackModels: (input.fallbackModels ?? []).map(pin),
        fallbackThinkingLevels: Object.fromEntries(
          Object.entries(input.fallbackThinkingLevels ?? {}).map(([model, level]) => [pin(model), level]),
        ),
      };
      const saved = await host.call<{ subagent: UserSubagentRecord | null }>(existing.has(id) ? "agents.update" : "agents.create", { id, subagent });
      if (!saved.subagent) throw new Error("子智能体保存失败");
    });
    const { disabled } = await host.call<{ disabled: string[] }>("agents.disabledBuiltins");
    const next = new Set(file.subagents.disabledBuiltins);
    for (const id of new Set([...disabled, ...next])) {
      if (disabled.includes(id) !== next.has(id)) add(`内置子智能体开关 · ${id}`, true, () => host.call("agents.setBuiltinEnabled", { id, enabled: !next.has(id) }));
    }
  }
  for (const scope of PORTABLE_SETTING_SCOPES) {
    const values = file[scope];
    if (!values) continue;
    for (const key of Object.keys(values) as (keyof AppSettings)[]) {
      const value = values[key];
      if (isDeepStrictEqual(settings[key], value)) continue;
      add(`${CONFIG_SCOPE_LABELS[scope]} · ${portableSettingLabel(key)}`, settings[key] !== undefined, () => {
        const patch = remapMediaProviders({ [key]: value }, resolveProvider);
        return saveSettings(patch);
      });
    }
  }
  const mode = await chooseConfigImportMode({
    scopes: CONFIG_SCOPES.filter((scope) => file[scope] !== undefined).map((scope) => CONFIG_SCOPE_LABELS[scope]),
    conflicts: operations.filter((op) => op.conflict).map((op) => op.label),
    removals: removals.map((op) => op.label), count: operations.length,
  });
  if (!mode) return { ...result, canceled: true };
  for (const op of operations) {
    if (op.conflict && mode === "skip") { result.skipped++; continue; }
    try { await op.apply(); result.applied++; }
    catch { result.failed++; result.warnings.push(`${op.label}：写入失败，请检查配置内容和依赖的模型提供商后重试。`); }
  }
  if (mode === "replace" && result.failed === 0) {
    if (file.models) {
      try { await restoreImportedProviderOrder(host, file.models.providers.providers, providers); }
      catch { result.failed++; result.warnings.push("提供商顺序恢复失败，未执行后续移除。"); }
    }
    for (const op of removals) {
      if (result.failed) { result.skipped++; continue; }
      try { await op.apply(); result.applied++; }
      catch { result.failed++; result.warnings.push(`${op.label}：移除未完成，其余条目已保留。`); }
    }
  } else if (mode === "replace" && removals.length) {
    result.skipped += removals.length;
    result.warnings.push("部分配置保存失败，未移除本机其他提供商或子智能体。");
  }
  return result;
}
