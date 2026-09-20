import { el, button, inlineSpinner } from "./dom.js";
import { describeError } from "./protocol.js";

const THINKING_LABELS = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", omit: "跟随提供商" };
const MODES = { agent: "执行", plan: "计划", goal: "目标" };
const PERMISSIONS = { inherit: "跟随全局", ask: "询问", "accept-edits": "自动接受编辑", auto: "自动" };

/** 每次打开独立加载、独立草稿；只有宿主回执才能更新会话。 */
export function openModelSettings({ sessionId, read, save, openSheet, isCurrent, onCatalog, onSaved }) {
  let controller, generation = 0, catalog = [], baseline, draft, saving = false;
  const sheet = openSheet({
    title: "模型与会话设置",
    subtitle: "选择模型和思考强度，应用到当前会话。",
    onClose: () => { generation++; controller?.abort(); },
  });
  sheet.panel.classList.add("model-settings");
  const status = el("p", { className: "sheet-hint", attrs: { role: "status", "aria-live": "polite" } });
  const search = el("input", { type: "search", placeholder: "搜索模型或提供商", attrs: { "aria-label": "搜索模型或提供商" } });
  const list = el("div", { className: "model-catalog", attrs: { "aria-label": "可用模型" } });
  const fields = el("div", { className: "model-settings-fields" });
  const selected = el("p", { className: "model-selection", attrs: { "aria-live": "polite" } });
  const reload = button("刷新列表", { preserveLabel: true, onClick: () => void load() });
  const apply = button("应用设置", { variant: "primary", preserveLabel: true, disabled: true, onClick: () => void commit() });
  const active = () => sheet.isOpen() && isCurrent();
  const changed = () => baseline && ["modelKey", "thinkingLevel", "mode", "permissionMode"].some(key => draft[key] !== baseline[key]);
  const selectedModel = () => catalog.find(model => model.key === draft?.modelKey);
  const syncApply = () => { apply.disabled = saving || !changed(); };
  sheet.body.append(status, el("div", { className: "model-search" }, search, reload), list, selected, fields);
  sheet.panel.append(el("div", { className: "sheet-foot" }, button("取消", { variant: "secondary", onClick: () => sheet.close() }), apply));

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = catalog.filter(m => `${m.label} ${m.alias || ""} ${m.modelId} ${m.providerName} ${m.providerId}`.toLocaleLowerCase().includes(query));
    const groups = new Map();
    for (const model of visible) {
      if (!groups.has(model.providerId)) groups.set(model.providerId, []);
      groups.get(model.providerId).push(model);
    }
    list.replaceChildren();
    for (const models of groups.values()) {
      const group = el("section", { className: "model-provider" }, el("h3", { text: models[0].providerName }));
      for (const model of models) {
        const checked = model.key === draft.modelKey;
        const row = el("button", {
          type: "button", className: `model-option${checked ? " is-selected" : ""}`,
          attrs: { "aria-pressed": String(checked) },
          on: { click: () => choose(model) },
        }, el("span", { className: "model-option-copy" },
          el("strong", { text: model.alias || model.modelId }),
          el("small", { text: model.alias ? model.modelId : model.providerName })),
          el("span", { className: "model-option-badge", text: checked ? "已选择" : model.isDefault ? "默认" : "" }));
        group.append(row);
      }
      list.append(group);
    }
    if (!visible.length) list.append(el("p", { className: "sheet-hint", text: catalog.length ? "没有匹配的模型" : "暂无可用模型，请在电脑端配置并启用提供商后刷新。" }));
  }

  function choice(label, values, value, onChange) {
    const select = el("select", { attrs: { "aria-label": label } });
    for (const [key, name] of Object.entries(values)) select.append(el("option", { value: key, text: name }));
    if (value && !Object.hasOwn(values, value)) select.append(el("option", { value, text: `${value}（当前值）` }));
    select.value = value;
    select.addEventListener("change", () => { onChange(select.value); syncApply(); });
    return el("label", { className: "sheet-field" }, label, select);
  }

  function renderFields() {
    const model = selectedModel();
    selected.textContent = model
      ? `已选择：${model.alias || model.modelId} · ${model.providerName}`
      : draft.modelKey ? `当前模型：${draft.modelKey}（不在可用列表中，保留当前设置）` : "当前会话使用默认模型；请选择要使用的模型。";
    fields.replaceChildren();
    if (model) {
      const levels = Object.fromEntries(model.thinkingLevels.map(level => [level, THINKING_LABELS[level] || level]));
      fields.append(choice("思考强度", levels, draft.thinkingLevel, value => { draft.thinkingLevel = value; }));
    }
    fields.append(
      choice("工作模式", MODES, draft.mode, value => { draft.mode = value; }),
      choice("权限模式", PERMISSIONS, draft.permissionMode, value => { draft.permissionMode = value; }),
    );
    syncApply();
  }

  function choose(model) {
    if (saving) return;
    draft.modelKey = model.key;
    if (!model.thinkingLevels.includes(draft.thinkingLevel)) draft.thinkingLevel = model.thinkingLevels[0];
    for (const row of list.querySelectorAll(".model-option")) row.blur();
    renderList();
    renderFields();
  }

  async function load() {
    const version = ++generation;
    controller?.abort();
    controller = new AbortController();
    baseline = null;
    catalog = [];
    apply.disabled = true;
    reload.disabled = true;
    search.disabled = true;
    list.replaceChildren(inlineSpinner("正在读取模型和会话设置…"));
    fields.replaceChildren();
    selected.textContent = "";
    status.textContent = "";
    try {
      const result = await read("models.list", { sessionId }, { signal: controller.signal });
      if (!active() || version !== generation) return;
      if (!Array.isArray(result?.items) || !result.session || result.session.id !== sessionId) throw new Error("模型目录响应不完整，请更新电脑端远控插件后重试。");
      catalog = result.items;
      const session = result.session;
      baseline = { modelKey: session.modelKey || "", thinkingLevel: session.thinkingLevel || "off", mode: session.mode || "agent", permissionMode: session.permissionMode || "inherit" };
      draft = { ...baseline };
      onCatalog(catalog);
      status.textContent = `当前模型：${catalog.find(m => m.key === baseline.modelKey)?.label || baseline.modelKey || "跟随默认"} · ${catalog.length} 个可用模型`;
      search.disabled = false;
      renderList();
      renderFields();
    } catch (error) {
      if (!active() || version !== generation) return;
      status.textContent = `加载失败：${describeError(error)}`;
      list.replaceChildren(button("重新获取模型", { preserveLabel: true, onClick: () => void load() }));
    } finally {
      if (active() && version === generation) reload.disabled = false;
    }
  }

  async function commit() {
    if (!active() || saving || !changed()) return;
    const settings = { sessionId };
    const modelChanged = draft.modelKey !== baseline.modelKey;
    if (modelChanged) {
      const model = selectedModel();
      if (!model) { sheet.showError("请从列表选择可用模型。"); return; }
      Object.assign(settings, { modelKey: model.key, providerId: model.providerId, modelId: model.modelId });
    }
    for (const key of ["thinkingLevel", "mode", "permissionMode"]) {
      if (draft[key] !== baseline[key] || (key === "thinkingLevel" && modelChanged)) settings[key] = draft[key];
    }
    saving = true;
    sheet.setBusy(true);
    try {
      const result = await save("models.configure", settings);
      if (!result?.session || result.session.id !== sessionId) throw new Error("宿主未返回更新后的会话，请刷新后确认当前设置。");
      if (!active()) return;
      onSaved(result.session);
      sheet.setBusy(false);
      sheet.close();
    } catch (error) {
      if (active()) { sheet.setBusy(false); sheet.showError(describeError(error)); }
    } finally {
      saving = false;
      if (active()) syncApply();
    }
  }
  search.addEventListener("input", renderList);
  void load();
  return sheet;
}
