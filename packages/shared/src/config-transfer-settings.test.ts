import { describe, expect, it } from "vitest";
import type { AppSettings } from "./types/settings.js";
import {
  exportPortableSettings,
  parsePortableSettings,
  portableSettingLabel,
  PORTABLE_SETTING_KEYS,
  PORTABLE_SETTING_SCOPES,
} from "./config-transfer-settings.js";

const settings: AppSettings = {
  defaultMode: "agent",
  theme: "dark",
  enterToSend: true,
  onboardingDismissed: false,
};

const image = { providerId: "source-provider", modelId: "image-model" };
const speech = {
  providerId: "source-provider",
  modelId: "speech-model",
  protocol: "openai_audio",
};

describe("可迁移应用设置", () => {
  it("旧文件缺少字段时不补默认，也不引入其他范围或未知字段", () => {
    for (const scope of PORTABLE_SETTING_SCOPES) {
      expect(parsePortableSettings({}, scope)).toEqual({});
    }
    expect(parsePortableSettings({
      enterToSend: false,
      infiniteProviderRetry: true,
      theme: "light",
      liveVoice: {},
      onboardingDismissed: true,
      lastNotifiedUpdateVersion: "old-version",
      jevApiKey: "example-only",
      unknown: "ignored",
    }, "general")).toEqual({ enterToSend: false });
    expect(parsePortableSettings(Object.create({ enterToSend: false }), "general")).toEqual({});
  });

  it("导出已确认的有效默认值并保留平台相关字段缺失", () => {
    expect(exportPortableSettings(settings, "general")).toEqual({
      defaultMode: "agent",
      defaultPermissionMode: "auto",
      enterToSend: true,
      largePasteThreshold: 600,
      keepAwakeWhileRunning: true,
      preventScreenSleep: false,
      scheduledTasksEnabled: true,
    });
    expect(exportPortableSettings(settings, "ai")).toEqual({
      infiniteProviderRetry: false,
      runStatusReminderMinutes: 0,
      jevEnabled: false,
    });
    expect(exportPortableSettings(settings, "network")).toEqual({
      networkProxy: { mode: "system" },
      networkPolicy: { mode: "relaxed" },
      pluginMarketSource: "official",
      pluginMarketCustomUrl: "",
    });
  });

  it("空媒体配置能清除目标配置，生图旧绑定能展开为候选列表", () => {
    expect(exportPortableSettings(settings, "media")).toEqual({
      imageGeneration: null,
      imageGenerationModels: [],
      fileHosting: { litterbox: { enabled: false, expiration: "24h" } },
      speech: {},
    });
    expect(exportPortableSettings({ ...settings, imageGeneration: image }, "media"))
      .toMatchObject({ imageGeneration: image, imageGenerationModels: [image] });
    expect(parsePortableSettings({ imageGeneration: null, imageGenerationModels: null }, "media"))
      .toEqual({ imageGeneration: null, imageGenerationModels: null });
  });

  it("保留有效宿主结构、提供商引用和语音附加参数，忽略嵌套未知字段", () => {
    const source = {
      imageGeneration: { ...image, secret: "example-only" },
      fileHosting: {
        litterbox: { enabled: true, expiration: "12h", token: "example-only" },
        publicUrl: "https://example.invalid",
      },
      speech: {
        transcribe: {
          ...speech,
          secret: "example-only",
          path: "/audio?api_key=example-only&region=cn",
          extra: {
            language: "zh",
            max_tokens: "100",
            apiKey: "example-only",
            sessionToken: "example-only",
            Authorization: "Bearer example-only",
            header: "Bearer example-only",
          },
        },
        unknown: { token: "example-only" },
      },
    };
    expect(parsePortableSettings(source, "media")).toEqual({
      imageGeneration: image,
      fileHosting: { litterbox: { enabled: true, expiration: "12h" } },
      speech: {
        transcribe: {
          ...speech,
          path: "/audio?api_key=example-only&region=cn",
          extra: { language: "zh", max_tokens: "100", apiKey: "example-only", sessionToken: "example-only",
            Authorization: "Bearer example-only", header: "Bearer example-only" },
        },
      },
    });
    expect(source.speech.transcribe.extra.apiKey).toBe("example-only");
  });

  it("旧嵌套字段缺失时不补默认，网络通知回执保持本机", () => {
    expect(parsePortableSettings({ fileHosting: { litterbox: { enabled: true } } }, "media"))
      .toEqual({ fileHosting: { litterbox: { enabled: true } } });
    expect(parsePortableSettings({
      networkPolicy: { mode: "strict", insecureNoticeAcknowledged: true, unknown: false },
      networkProxy: { mode: "direct", allowFakeIp: true },
    }, "network")).toEqual({
      networkPolicy: { mode: "strict" },
      networkProxy: { mode: "direct" },
    });
  });

  it("迁移代理认证和自定义地址参数，保持原配置可用", () => {
    expect(parsePortableSettings({
      networkProxy: { mode: "custom", url: "http://name:example-only@localhost:7890" },
      pluginMarketCustomUrl: "https://name:example-only@example.invalid/catalog?token=example-only&channel=beta",
    }, "network")).toEqual({
      networkProxy: { mode: "custom", url: "http://name:example-only@localhost:7890" },
      pluginMarketCustomUrl: "https://name:example-only@example.invalid/catalog?token=example-only&channel=beta",
    });
  });

  it.each([
    ["general", { defaultMode: "unknown" }],
    ["general", { defaultPermissionMode: "inherit" }],
    ["general", { enterToSend: "true" }],
    ["general", { largePasteThreshold: 0 }],
    ["general", { largePasteThreshold: 1.5 }],
    ["general", { defaultCommandShell: "unknown" }],
    ["general", { updatePreference: null }],
    ["ai", { runStatusReminderMinutes: 1441 }],
    ["ai", { runStatusReminderMinutes: Infinity }],
    ["ai", { jevEnabled: null }],
    ["media", { imageGeneration: {} }],
    ["media", { imageGenerationModels: [null] }],
    ["media", { imageGenerationModels: Array(129).fill(image) }],
    ["media", { fileHosting: null }],
    ["media", { fileHosting: { litterbox: { expiration: "forever" } } }],
    ["media", { speech: [] }],
    ["media", { speech: { transcribe: { ...speech, protocol: "Invalid Protocol" } } }],
    ["network", { networkProxy: { mode: "unknown" } }],
    ["network", { networkProxy: { mode: "custom" } }],
    ["network", { networkPolicy: { mode: "unknown" } }],
    ["network", { pluginMarketSource: "unknown" }],
    ["network", { pluginMarketCustomUrl: "file:///catalog.json" }],
  ] as const)("%s 范围拒绝非法值并返回中文错误", (scope, input) => {
    expect(() => parsePortableSettings(input, scope)).toThrow(/迁移设置「.+」/);
  });

  it("所有可迁移字段都有中文冲突项名称", () => {
    for (const scope of PORTABLE_SETTING_SCOPES) {
      for (const key of PORTABLE_SETTING_KEYS[scope]) {
        expect(portableSettingLabel(key)).toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });
});
