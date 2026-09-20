"use strict";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit"]);
function invalid(message) { throw Object.assign(new Error(message), { code: "INVALID_PARAMS" }); }

/** 模型目录和配置共用同一个身份契约，不向浏览器暴露提供商配置或凭据。 */
function createModelSettings({ listModels, getSession, configureSession, serializeSession }) {
  async function catalog() {
    const models = await listModels();
    if (!Array.isArray(models)) throw new Error("宿主模型目录格式无效");
    const items = new Map();
    for (const model of models) {
      if (!model || typeof model.providerId !== "string" || !model.providerId || typeof model.modelId !== "string" || !model.modelId) {
        throw new Error("宿主模型目录缺少提供商或模型标识");
      }
      const key = `${model.providerId}/${model.modelId}`;
      const levels = [...new Set((Array.isArray(model.thinkingLevels) ? model.thinkingLevels : []).filter(level => THINKING_LEVELS.has(level)))];
      items.set(key, {
        key, providerId: model.providerId, modelId: model.modelId,
        providerName: model.providerName || model.providerId,
        label: model.label || model.modelId,
        alias: model.alias || "",
        isDefault: model.isDefault === true,
        thinkingLevels: levels.length ? levels : ["off"],
      });
    }
    return [...items.values()];
  }

  async function list(sessionId) {
    const [items, current] = await Promise.all([catalog(), sessionId ? getSession(sessionId) : null]);
    return { items, ...(current ? { session: serializeSession(current) } : {}) };
  }

  async function configure(sessionId, input) {
    const current = await getSession(sessionId);
    // 宿主的配置接口要求 mode；未编辑的值取当前会话，不取打开面板时的快照。
    const config = { mode: current.mode || "agent" };
    if (input.mode !== undefined) {
      if (!["agent", "plan", "goal"].includes(input.mode)) invalid("工作模式无效");
      config.mode = input.mode;
    }
    if (input.permissionMode !== undefined) {
      if (!["inherit", "ask", "accept-edits", "auto"].includes(input.permissionMode)) invalid("权限模式无效");
      config.permissionMode = input.permissionMode;
    }
    const changingModel = input.modelKey !== undefined || input.providerId !== undefined || input.modelId !== undefined;
    if (changingModel || input.thinkingLevel !== undefined) {
      const items = await catalog();
      const key = changingModel ? input.modelKey : `${current.providerId}/${current.modelId}`;
      const model = items.find(item => item.key === key);
      if (!model) invalid("所选模型已不可用，请刷新模型列表后重新选择");
      if (changingModel) {
        if ((input.providerId !== undefined && input.providerId !== model.providerId) || (input.modelId !== undefined && input.modelId !== model.modelId)) invalid("模型与提供商不匹配，请刷新后重新选择");
        config.providerId = model.providerId;
        config.modelId = model.modelId;
      }
      if (input.thinkingLevel !== undefined) {
        if (!model.thinkingLevels.includes(input.thinkingLevel)) invalid("所选模型不支持此思考强度，请重新选择");
        config.thinkingLevel = input.thinkingLevel;
      } else if (changingModel) {
        config.thinkingLevel = model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0];
      }
    }
    const result = await configureSession(sessionId, config);
    if (!result?.session || result.session.id !== sessionId) throw new Error("宿主未返回更新后的会话，请刷新后确认设置");
    const updated = result.session;
    for (const key of Object.keys(config)) {
      if (updated[key] !== config[key]) throw new Error("宿主返回的设置与请求不一致，请刷新后确认实际配置");
    }
    return { session: serializeSession(updated) };
  }
  return { list, configure };
}

module.exports = { createModelSettings };
