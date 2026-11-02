"use strict";

const TITLE_PROMPT_TEMPLATE = `Create a short, descriptive title for this conversation. Return only the title, without quotes.

User prompt:
{{userPrompt}}

Assistant response (if available):
{{assistantReply}}`;
const MAX_PROMPT_TEMPLATE_LENGTH = 20_000;

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function normalizeSettings(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const promptTemplate = typeof source.promptTemplate === "string" ? source.promptTemplate : "";
  return {
    enabled: source.enabled !== false,
    modelKey: typeof source.modelKey === "string" ? source.modelKey.trim().slice(0, 256) : "",
    thinkingLevel: THINKING_LEVELS.has(source.thinkingLevel) ? source.thinkingLevel : "off",
    promptTemplate: isValidPromptTemplate(promptTemplate) ? promptTemplate : TITLE_PROMPT_TEMPLATE,
  };
}

function isValidPromptTemplate(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= MAX_PROMPT_TEMPLATE_LENGTH &&
    value.includes("{{userPrompt}}")
  );
}

function selectModel(models, preferredKey, sessionKey) {
  const available = Array.isArray(models)
    ? models.filter((model) => model && typeof model.key === "string" && model.key.includes("/"))
    : [];
  return (
    available.find((model) => model.key === preferredKey) ??
    available.find((model) => model.key === sessionKey) ??
    available.find((model) => model.isDefault === true) ??
    available[0] ??
    null
  );
}

function resolveThinkingLevel(requested, model) {
  const available = Array.isArray(model?.thinkingLevels) ? model.thinkingLevels : [];
  if (requested === "off" || available.includes(requested)) return requested;
  return "off";
}

function renderPrompt(template, context) {
  return String(template ?? TITLE_PROMPT_TEMPLATE).replace(
    /\{\{(userPrompt|assistantReply)\}\}/g,
    (_match, key) => (key === "userPrompt" ? context.userPrompt : context.assistantReply ?? ""),
  );
}

function normalizeGeneratedTitle(value) {
  if (typeof value !== "string") return "";
  let title = value
    .trim()
    .replace(/^(?:session\s+)?title\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’`「」『』]+|["'“”‘’`「」『』]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？:：]+$/u, "")
    .trim();
  return Array.from(title).slice(0, 80).join("");
}

module.exports = {
  TITLE_PROMPT_TEMPLATE,
  normalizeGeneratedTitle,
  normalizeSettings,
  isValidPromptTemplate,
  MAX_PROMPT_TEMPLATE_LENGTH,
  renderPrompt,
  resolveThinkingLevel,
  selectModel,
};
