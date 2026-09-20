import assert from "node:assert/strict";
import { test } from "vitest";
import {
  catalogs,
  en,
  flattenCatalog,
  listedLocales,
  resolveLocale,
  supportedLocales,
  zhCN,
} from "../src/index.ts";

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}|{([A-Za-z_][A-Za-z0-9_]*)}/g)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

const english = flattenCatalog(en);

test("every shipped catalog matches English keys and interpolation variables", () => {
  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    assert.deepEqual(Object.keys(flat).sort(), Object.keys(english).sort(), id);
    for (const key of Object.keys(english)) {
      assert.deepEqual(placeholders(flat[key]), placeholders(english[key]), `${id} ${key}`);
    }
  }
});

test("canonical thinking levels are not translated catalog entries", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const effortKeys = [
    "chat.effortOff",
    "chat.effortMinimal",
    "chat.effortLow",
    "chat.effortMid",
    "chat.effortHigh",
    "chat.effortXhigh",
    "chat.effortMax",
  ];

  for (const [id, catalog] of Object.entries(catalogs)) {
    const flat = flattenCatalog(catalog);
    for (const level of levels) {
      assert.equal(flat[`thinkingLevel.${level}`], undefined, `${id} ${level}`);
    }
    for (const key of effortKeys) {
      assert.equal(flat[key], undefined, `${id} ${key}`);
    }
  }
});

test("settings subagent empty-state copy uses a non-conflicting key", () => {
  const chinese = flattenCatalog(zhCN);

  assert.equal(english["settings.subagentsEmpty"], "No subagents of your own yet");
  assert.equal(chinese["settings.subagentsEmpty"], "还没有你自己的子智能体");
  assert.equal(typeof english["settings.subagents"], "string");
  assert.equal(typeof english["extensions.subagents.empty"], "string");
});

test("creation-phase delegation copy is catalog-backed", () => {
  assert.equal(english["chat.subagentCreating"], "Starting subagent…");
  assert.equal(
    flattenCatalog(zhCN)["chat.subagentCreating"],
    "正在创建子智能体…",
  );
  for (const [id, catalog] of Object.entries(catalogs)) {
    assert.equal(
      typeof flattenCatalog(catalog)["chat.subagentCreating"],
      "string",
      id,
    );
  }
});

test("settings rail labels stay concise and parallel across locales", () => {
  const chinese = flattenCatalog(zhCN);
  const keys = [
    "general",
    "ai",
    "shortcuts",
    "instructions",
    "models",
    "skills",
    "mcp",
    "subagents",
    "import",
    "projects",
    "info",
  ].map((key) => `settings.nav.${key}`);

  assert.deepEqual(
    keys.map((key) => english[key]),
    [
      "General",
      "AI",
      "Shortcuts",
      "Instructions",
      "Models",
      "Skills",
      "MCP",
      "Subagents",
      "Import",
      "Projects",
      "Info",
    ],
  );
  assert.deepEqual(
    keys.map((key) => chinese[key]),
    [
      "常规",
      "AI",
      "快捷键",
      "指令",
      "模型",
      "技能",
      "MCP",
      "子智能体",
      "导入",
      "项目",
      "信息",
    ],
  );
  assert.equal(english["settings.groupPreferences"], "Preferences");
  assert.equal(chinese["settings.groupPreferences"], "偏好");
  assert.equal(english["settings.groupSystem"], "System");
  assert.equal(chinese["settings.groupSystem"], "系统");
});

test("import, project, and temporary-session copy is catalog-backed", () => {
  for (const key of [
    "nav.temporarySessions",
    "nav.newTemporarySession",
    "settings.importGroupByPath",
    "settings.importNoProject",
    "settings.importSourceClaudeCode",
    "project.selectProject",
    "project.openActions",
    "project.sessions",
  ]) {
    assert.equal(typeof english[key], "string", key);
    assert.notEqual(english[key], "");
  }
});

test("locale resolution maps variants onto shipped catalogs and falls back to English", () => {
  assert.equal(resolveLocale("zh-CN"), "zh-CN");
  assert.equal(resolveLocale("zh-TW"), "zh-CN");
  assert.equal(resolveLocale("zh-Hant"), "zh-CN");
  assert.equal(resolveLocale("zh_Hant_TW"), "zh-CN");
  assert.equal(resolveLocale("zh-HK"), "zh-CN");
  assert.equal(resolveLocale("zh"), "zh-CN");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("tr"), "en");
  assert.equal(resolveLocale("tr-TR"), "en");
  assert.equal(resolveLocale("tr_TR"), "en");
  assert.equal(resolveLocale("es-MX"), "en");
  assert.equal(resolveLocale("fr-CA"), "en");
  assert.equal(resolveLocale("de-DE"), "en");
  assert.equal(resolveLocale("ko"), "en");
  assert.equal(resolveLocale("ko-KR"), "en");
  assert.equal(resolveLocale("ko_KR"), "en");
  assert.equal(resolveLocale(), "en");
});

test("the locale registry contains only English and Simplified Chinese", () => {
  assert.deepEqual(supportedLocales.map((locale) => locale.id), ["en", "zh-CN"]);
  assert.deepEqual(listedLocales().map((locale) => locale.id), ["en", "zh-CN"]);
  assert.equal(supportedLocales[0].nativeName, "English");
  assert.equal(supportedLocales[1].nativeName, "简体中文");
  assert.equal(english["settings.languageSearchPlaceholder"], "Search languages…");
  assert.equal(english["settings.themeSearchPlaceholder"], "Search themes…");
  assert.equal(english["settings.languageAutoDesc"], "Currently {{state}}");
});

test("inline review cards expose localized accessible labels", () => {
  const chinese = flattenCatalog(zhCN);

  assert.equal(
    english["chat.reviewChangeShow"],
    "Show {{status}} changes for {{path}} ({{additions}} additions, {{deletions}} deletions)",
  );
  assert.equal(
    english["chat.reviewChangeHide"],
    "Hide {{status}} changes for {{path}} ({{additions}} additions, {{deletions}} deletions)",
  );
  assert.equal(
    chinese["chat.reviewChangeShow"],
    "显示 {{path}} 的{{status}}改动（新增 {{additions}} 行，删除 {{deletions}} 行）",
  );
  assert.equal(
    chinese["chat.reviewChangeHide"],
    "隐藏 {{path}} 的{{status}}改动（新增 {{additions}} 行，删除 {{deletions}} 行）",
  );
  assert.equal(
    english["chat.reviewChangeCounts"],
    "{{additions}} additions, {{deletions}} deletions",
  );
  assert.equal(
    chinese["chat.reviewChangeCounts"],
    "新增 {{additions}} 行，删除 {{deletions}} 行",
  );
  assert.equal(english["panel.review.filesChanged_one"], "1 file changed");
  assert.equal(
    english["panel.review.filesChanged_other"],
    "{{count}} files changed",
  );
  assert.equal(english["panel.review.changes_one"], "1 recorded change");
  assert.equal(
    chinese["panel.review.rollbackConflict"],
    "该文件在此消息之后又发生了变化，已跳过回退。",
  );
});
