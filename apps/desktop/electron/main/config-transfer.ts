import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dialog } from "electron";
import { globalInstructionPath } from "@pi-desktop/agent-runtime";
import { resolveLocale } from "@pi-desktop/i18n";
import {
  APPEARANCE_KEYS, CONFIG_SCOPES, KEYBOARD_SHORTCUTS, SUBAGENT_THINKING_LEVELS,
  isAllowedKeybinding, isReservedKeybinding, isAppearanceSettings,
  buildProviderExportFile, parseProviderExportFile, planProviderImport, providerImportPayload,
  type AppSettings, type ConfigExportFile, type ConfigScope, type ConfigTransferResult,
  type UserSubagentRecord, type ShortcutPlatform,
} from "@pi-desktop/shared";
import { collectProviderConfig, type ProviderRow } from "./provider-config-transfer";
import type { HostProcess } from "./host-process";

type Dependencies = {
  host: HostProcess;
  saveSettings: (patch: Partial<AppSettings>) => Promise<unknown>;
};
const labels: Record<ConfigScope, string> = {
  appearance: "外观", shortcuts: "快捷键", instructions: "指令", models: "模型", subagents: "子智能体",
};
const filters = [{ name: "JSON 配置文件", extensions: ["json"] }];
const appearanceLabels = { theme: "主题", language: "语言", fontFamily: "字体", fontScale: "字号", appearance: "分区字体与配色" };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function invalid(message: string): never { throw new Error(`配置文件无效：${message}`); }
const appearanceOf = (s: AppSettings): NonNullable<ConfigExportFile["appearance"]> => ({
  theme: s.theme,
  language: !s.language || s.language === "auto" ? "auto" : resolveLocale(s.language),
  fontFamily: s.fontFamily ?? "",
  fontScale: s.fontScale ?? 1, appearance: s.appearance ?? {},
});
async function readInstructions() {
  try { return await fs.readFile(globalInstructionPath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
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
  if (!record(value) || value.kind !== "this-is-a-agent.config" || value.version !== 1) invalid("不支持的文件类型或版本");
  const file = value as unknown as ConfigExportFile;
  if (!CONFIG_SCOPES.some((scope) => file[scope] !== undefined)) invalid("没有可导入的范围");
  if (file.appearance !== undefined) {
    const a = file.appearance;
    if (!record(a) || Object.keys(a).some((k) => !(APPEARANCE_KEYS as readonly string[]).includes(k))) invalid("外观字段不正确");
    if (a.theme !== undefined && (typeof a.theme !== "string" || !["system", "light", "dark"].includes(a.theme) && !a.theme.startsWith("plugin:"))) invalid("主题不正确");
    if (a.language !== undefined) {
      if (typeof a.language !== "string") invalid("语言不正确");
      a.language = a.language === "auto" ? "auto" : resolveLocale(a.language);
    }
    if (a.fontFamily !== undefined && typeof a.fontFamily !== "string") invalid("字体不正确");
    if (a.fontScale !== undefined && (typeof a.fontScale !== "number" || a.fontScale < 0.8 || a.fontScale > 1.5)) invalid("字号比例不正确");
    if (a.appearance !== undefined && !isAppearanceSettings(a.appearance)) invalid("外观配色不正确");
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
    // 共用的旧模型入口不接受空提供商列表；完整备份允许只含默认选项。
    const source = file.models.providers;
    const emptyProviders = record(source) && source.kind === "pi-desktop.providers" && source.version === 1 && Array.isArray(source.providers) && source.providers.length === 0;
    const parsed = emptyProviders ? { ok: true as const, file: buildProviderExportFile([]), warnings: [] as string[] } : parseProviderExportFile(source);
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
    const keys = ["id", "name", "description", "body", "tools", "model", "fallbackModels", "thinkingLevel", "maxTokens", "enabled"];
    for (const agent of s.owned) {
      if (!record(agent) || typeof agent.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id) || agent.id.length > 40 || seen.has(agent.id) ||
        Object.keys(agent).some((k) => !keys.includes(k)) || agent.name !== agent.id ||
        typeof agent.body !== "string" || typeof agent.description !== "string" || !agent.description.trim() ||
        !Array.isArray(agent.tools) || !agent.tools.length || agent.tools.some((t) => typeof t !== "string") ||
        typeof agent.enabled !== "boolean" || typeof agent.model !== "string" ||
        !Array.isArray(agent.fallbackModels) || agent.fallbackModels.some((m) => typeof m !== "string") ||
        typeof agent.thinkingLevel !== "string" || !["", ...SUBAGENT_THINKING_LEVELS].includes(agent.thinkingLevel) ||
        typeof agent.maxTokens !== "number" || !Number.isInteger(agent.maxTokens) || agent.maxTokens < 0) invalid("子智能体字段无效或名称重复");
      seen.add(agent.id);
    }
  }
  return file;
}

export async function exportConfig({ host }: Dependencies, scopes: ConfigScope[]): Promise<ConfigTransferResult> {
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !CONFIG_SCOPES.includes(s))) throw new Error("请选择导出范围");
  const picked = await dialog.showSaveDialog({ title: "导出配置", defaultPath: `this-is-a-agent-config-${new Date().toISOString().slice(0, 10)}.json`, filters });
  const result: ConfigTransferResult = { applied: 0, skipped: 0, failed: 0, warnings: [] };
  if (picked.canceled || !picked.filePath) return { ...result, canceled: true };
  const settings = await host.call<AppSettings>("settings.get");
  const file: ConfigExportFile = { kind: "this-is-a-agent.config", version: 1, exportedAt: new Date().toISOString() };
  if (scopes.includes("appearance")) file.appearance = appearanceOf(settings);
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
        thinkingLevel: agent.thinkingLevel ?? "", maxTokens: agent.maxTokens ?? 0, enabled: agent.enabled });
    }
  }
  await fs.writeFile(picked.filePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { ...result, applied: new Set(scopes).size };
}

export async function importConfig({ host, saveSettings }: Dependencies): Promise<ConfigTransferResult> {
  const result: ConfigTransferResult = { applied: 0, skipped: 0, failed: 0, warnings: [] };
  const picked = await dialog.showOpenDialog({ title: "导入配置", properties: ["openFile"], filters });
  if (picked.canceled || !picked.filePaths[0]) return { ...result, canceled: true };
  if ((await fs.stat(picked.filePaths[0])).size > 20 * 1024 * 1024) throw new Error("配置文件不能超过 20 MB");
  const file = parseFile(await fs.readFile(picked.filePaths[0], "utf8"));
  const settings = await host.call<AppSettings>("settings.get");
  type Operation = { label: string; conflict: boolean; apply: () => Promise<unknown> };
  const operations: Operation[] = [];
  const add = (label: string, conflict: boolean, apply: Operation["apply"]) => operations.push({ label, conflict, apply });
  if (file.appearance) {
    const current = appearanceOf(settings);
    for (const key of APPEARANCE_KEYS) {
      const value = file.appearance[key];
      if (value !== undefined && !isDeepStrictEqual(current[key], value)) add(`外观 · ${appearanceLabels[key]}`, true, () => saveSettings({ [key]: value }));
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
  if (file.models || file.subagents) ({ providers } = await host.call<{ providers: ProviderRow[] }>("providers.list", { includeDisabled: true }));
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
    const owned = providers.filter((p) => !p.ownerPluginId);
    for (const entry of file.models.providers.providers) {
      if (owned.filter((p) => p.name.trim().toLowerCase() === entry.name.trim().toLowerCase()).length > 1) {
        throw new Error("本机存在同名提供商，无法确定覆盖目标。请先在模型设置中区分名称。");
      }
    }
    const plan = planProviderImport(owned, file.models.providers.providers);
    for (const step of plan.steps) add(`模型 · ${step.entry.name}`, step.action === "update", async () => {
      const payload = { ...providerImportPayload(step.entry), enabled: step.entry.enabled !== false,
        headers: step.entry.headers ?? {}, models: step.entry.models ?? [],
        supportsReasoning: step.entry.supportsReasoning ?? false,
        contextWindow: step.entry.contextWindow ?? 0, maxOutputTokens: step.entry.maxOutputTokens ?? 0,
        temperature: step.entry.temperature ?? -1,
        ...(step.entry.apiKey?.trim() ? { secretValue: step.entry.apiKey.trim() } : {}) };
      const { provider } = await host.call<{ provider: ProviderRow }>(`providers.${step.action}`, { ...payload, ...(step.id ? { id: step.id } : {}) });
      if (!provider) throw new Error("提供商保存失败");
      providers = [...providers.filter((p) => p.id !== provider.id), provider];
      // create 接口不接收 enabled；新建后单独恢复禁用状态。
      if (step.action === "create" && step.entry.enabled === false) await host.call("providers.update", { id: provider.id, enabled: false });
    });
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
      const subagent = { ...input, model: pin(input.model ?? ""), fallbackModels: (input.fallbackModels ?? []).map(pin) };
      const saved = await host.call<{ subagent: UserSubagentRecord | null }>(existing.has(id) ? "agents.update" : "agents.create", { id, subagent });
      if (!saved.subagent) throw new Error("子智能体保存失败");
    });
    const { disabled } = await host.call<{ disabled: string[] }>("agents.disabledBuiltins");
    const next = new Set(file.subagents.disabledBuiltins);
    for (const id of new Set([...disabled, ...next])) {
      if (disabled.includes(id) !== next.has(id)) add(`内置子智能体开关 · ${id}`, true, () => host.call("agents.setBuiltinEnabled", { id, enabled: !next.has(id) }));
    }
  }
  const conflicts = operations.filter((op) => op.conflict);
  const scopes = CONFIG_SCOPES.filter((s) => file[s] !== undefined).map((s) => labels[s]);
  const confirmation = await dialog.showMessageBox({ type: conflicts.length ? "warning" : "question", title: "导入配置",
    message: conflicts.length ? `发现 ${conflicts.length} 项配置冲突，是否覆盖？` : "确认导入配置？",
    detail: `范围：${scopes.join("、")}\n待处理 ${operations.length} 项。${conflicts.length ? `\n\n冲突项目：\n${conflicts.map((op) => op.label).join("\n")}\n\n覆盖只替换这些配置；跳过则保留本机冲突项。` : ""}`,
    buttons: conflicts.length ? ["覆盖冲突并导入", "跳过冲突并导入", "取消"] : ["导入", "取消"],
    defaultId: conflicts.length ? 2 : 0, cancelId: conflicts.length ? 2 : 1, noLink: true });
  if (confirmation.response === (conflicts.length ? 2 : 1)) return { ...result, canceled: true };
  for (const op of operations) {
    if (op.conflict && confirmation.response === 1) { result.skipped++; continue; }
    try { await op.apply(); result.applied++; }
    catch { result.failed++; result.warnings.push(`${op.label}：写入失败，请检查配置内容和依赖的模型提供商后重试。`); }
  }
  return result;
}
