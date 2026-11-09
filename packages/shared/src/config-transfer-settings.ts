import type { AppSettings } from "./types/settings.js";
import type { SpeechBinding, SpeechSettings } from "./types/speech.js";
import {
  MAX_ASK_TOOL_TIMEOUT_MINUTES,
  MAX_LARGE_PASTE_THRESHOLD,
  MAX_RUN_STATUS_REMINDER_MINUTES,
  MIN_LARGE_PASTE_THRESHOLD,
  normalizeAskToolTimeoutMinutes,
  normalizeLargePasteThreshold,
  normalizeRunStatusReminderMinutes,
} from "./composer-trigger.js";
import { isCommandShellId } from "./command-shells.js";
import {
  fileHostingWriteError,
  normalizeFileHostingSettings,
} from "./file-hosting.js";
import {
  imageGenerationBindings,
  parseImageGenerationBinding,
  parseImageGenerationBindings,
} from "./image-generation.js";
import { normalizeNetworkPolicy } from "./network-policy.js";
import { isNetworkProxyMode, parseProxyUrl } from "./network-proxy.js";
import { parseSpeechBinding, SPEECH_ROLES } from "./speech.js";
import { isGlobalPermissionMode } from "./types/permissions.js";

export const PORTABLE_SETTING_SCOPES = ["general", "ai", "media", "network"] as const;
export type PortableSettingScope = (typeof PORTABLE_SETTING_SCOPES)[number];
export type PortableSettings = Partial<AppSettings>;

export const PORTABLE_SETTING_KEYS: Record<
  PortableSettingScope,
  readonly (keyof AppSettings)[]
> = {
  general: [
    "defaultMode",
    "defaultPermissionMode",
    "enterToSend",
    "largePasteThreshold",
    "keepAwakeWhileRunning",
    "preventScreenSleep",
    "temporaryWorkspaceContextMenu",
    "defaultCommandShell",
    "scheduledTasksEnabled",
    "updatePreference",
  ],
  ai: ["infiniteProviderRetry", "runStatusReminderMinutes", "askToolTimeoutMinutes", "jevEnabled"],
  media: ["imageGeneration", "imageGenerationModels", "fileHosting", "speech"],
  network: [
    "networkProxy",
    "networkPolicy",
    "pluginMarketSource",
    "pluginMarketCustomUrl",
  ],
};

const LABELS: Partial<Record<keyof AppSettings, string>> = {
  defaultMode: "默认工作模式",
  defaultPermissionMode: "默认权限模式",
  enterToSend: "回车发送消息",
  largePasteThreshold: "大段文本粘贴阈值",
  keepAwakeWhileRunning: "运行期间阻止系统休眠",
  preventScreenSleep: "运行期间保持屏幕常亮",
  temporaryWorkspaceContextMenu: "系统菜单临时会话入口",
  defaultCommandShell: "默认命令行 Shell",
  scheduledTasksEnabled: "定时任务",
  updatePreference: "更新偏好",
  infiniteProviderRetry: "无限重试",
  runStatusReminderMinutes: "运行状态提醒间隔",
  askToolTimeoutMinutes: "超时自动选择时间",
  jevEnabled: "Jev 分类服务",
  imageGeneration: "默认生图模型",
  imageGenerationModels: "生图模型列表",
  fileHosting: "文件托管",
  speech: "语音服务绑定",
  networkProxy: "网络代理",
  networkPolicy: "网络策略",
  pluginMarketSource: "插件市场渠道",
  pluginMarketCustomUrl: "自定义插件市场地址",
  theme: "主题",
  appDisplayName: "应用显示名称",
  macosWindowTranslucency: "macOS 窗口半透明",
  language: "界面语言",
  fontFamily: "界面字体",
  appearance: "外观配色与分区字体",
  fontScale: "界面字号比例",
  homeMediaSize: "首页媒体尺寸",
  showThinking: "显示思考内容",
  transcriptDisplayMode: "过程展示方式",
  keybindings: "快捷键",
  linkOpenTarget: "链接打开方式",
  contextUsageDisplay: "上下文用量展示",
  chatContentMaxWidth: "聊天内容宽度",
  smoothStreaming: "流式文本平滑显示",
  inlineVisualizations: "内嵌可视化",
  sidebarRunningIndicators: "侧栏运行标记",
  sidebarRunningBadge: "项目运行数量徽标",
  sidebarRunningRail: "项目活动轨道",
  sidebarSessionTime: "会话最后回复时间",
  radialMenu: "环形菜单",
};

export function portableSettingLabel(key: keyof AppSettings): string {
  return LABELS[key] ?? `应用设置（${key}）`;
}

function invalid(field: string, detail = "值不合法"): never {
  throw Object.assign(new Error(`迁移设置「${field}」${detail}`), {
    errorCode: "INVALID_ARGUMENT",
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "必须是对象");
  }
  return value as Record<string, unknown>;
}

function has(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field, "必须是字符串");
  return value;
}


function parseSpeech(value: unknown): SpeechSettings {
  const source = record(value, "语音服务绑定");
  const result: SpeechSettings = {};
  for (const role of SPEECH_ROLES) {
    if (!has(source, role) || source[role] === null) continue;
    let binding: SpeechBinding;
    try {
      binding = parseSpeechBinding(source[role], role);
    } catch {
      invalid(`语音服务绑定.${role}`, "格式不合法，请检查供应商、模型、协议及附加参数");
    }
    result[role] = binding;
  }
  return result;
}

function parseSetting(key: keyof AppSettings, value: unknown): unknown {
  const label = portableSettingLabel(key);
  switch (key) {
    case "defaultMode":
      if (value !== "agent" && value !== "plan" && value !== "goal") invalid(label);
      return value;
    case "defaultPermissionMode":
      if (!isGlobalPermissionMode(value)) invalid(label);
      return value;
    case "defaultCommandShell":
      if (!isCommandShellId(value)) invalid(label, "必须是受支持的 Shell 标识");
      return value;
    case "updatePreference":
      if (value !== "automatic" && value !== "manual") invalid(label);
      return value;
    case "largePasteThreshold":
      if (typeof value !== "number" || !Number.isInteger(value) ||
          value < MIN_LARGE_PASTE_THRESHOLD || value > MAX_LARGE_PASTE_THRESHOLD) {
        invalid(label, `必须是 ${MIN_LARGE_PASTE_THRESHOLD}～${MAX_LARGE_PASTE_THRESHOLD} 的整数`);
      }
      return value;
    case "runStatusReminderMinutes":
      if (typeof value !== "number" || !Number.isInteger(value) ||
          value < 0 || value > MAX_RUN_STATUS_REMINDER_MINUTES) {
        invalid(label, `必须是 0～${MAX_RUN_STATUS_REMINDER_MINUTES} 的整数分钟`);
      }
      return value;
    case "askToolTimeoutMinutes":
      if (typeof value !== "number" || !Number.isInteger(value) ||
          value < 0 || value > MAX_ASK_TOOL_TIMEOUT_MINUTES) {
        invalid(label, `必须是 0～${MAX_ASK_TOOL_TIMEOUT_MINUTES} 的整数分钟`);
      }
      return value;
    case "imageGeneration":
    case "imageGenerationModels":
      if (value === undefined) invalid(label);
      try {
        return key === "imageGeneration"
          ? parseImageGenerationBinding(value)
          : parseImageGenerationBindings(value);
      } catch {
        invalid(label, "格式不合法，请检查供应商及模型标识和列表长度");
      }
    case "fileHosting": {
      const source = record(value, label);
      if (fileHostingWriteError(source)) invalid(label, "格式不合法，请检查 Litterbox 开关及有效期");
      if (!has(source, "litterbox")) return {};
      const litterbox = record(source.litterbox, `${label}.litterbox`);
      return {
        litterbox: {
          ...(has(litterbox, "enabled") ? { enabled: litterbox.enabled } : {}),
          ...(has(litterbox, "expiration") ? { expiration: litterbox.expiration } : {}),
        },
      };
    }
    case "speech":
      return parseSpeech(value);
    case "networkProxy": {
      const source = record(value, label);
      if (!isNetworkProxyMode(source.mode)) invalid(label, "模式必须是 system、direct 或 custom");
      const result: NonNullable<AppSettings["networkProxy"]> = { mode: source.mode };
      if (has(source, "url")) {
        const url = text(source.url, `${label}.url`);
        if (url.trim()) {
          const parsed = parseProxyUrl(url);
          if (!parsed.ok) invalid(label, "代理地址不合法");
          result.url = parsed.value.href;
        } else if (source.mode === "custom") {
          invalid(label, "自定义模式必须提供代理地址");
        }
      } else if (source.mode === "custom") {
        invalid(label, "自定义模式必须提供代理地址");
      }
      if (has(source, "bypass")) result.bypass = text(source.bypass, `${label}.bypass`).trim();
      return result;
    }
    case "networkPolicy": {
      const source = record(value, label);
      const result: NonNullable<AppSettings["networkPolicy"]> = {};
      if (has(source, "mode")) {
        if (source.mode !== "relaxed" && source.mode !== "strict") invalid(label);
        result.mode = source.mode;
      }
      return result;
    }
    case "pluginMarketSource":
      if (value !== "official" && value !== "github" && value !== "mirror" && value !== "custom") {
        invalid(label);
      }
      return value;
    case "pluginMarketCustomUrl": {
      const address = text(value, label).trim();
      if (address) {
        let url: URL;
        try {
          url = new URL(address);
        } catch {
          invalid(label, "必须是 HTTP 或 HTTPS 地址");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          invalid(label, "必须是 HTTP 或 HTTPS 地址");
        }
      }
      return address;
    }
    default:
      if (typeof value !== "boolean") invalid(label, "必须是布尔值");
      return value;
  }
}

/** 旧文件仅解析实际包含的字段；范围之外和嵌套未知字段不进入宿主。 */
export function parsePortableSettings(
  value: unknown,
  scope: PortableSettingScope,
): PortableSettings {
  const source = record(value, "应用设置");
  const result: PortableSettings = {};
  for (const key of PORTABLE_SETTING_KEYS[scope]) {
    if (!has(source, key)) continue;
    Object.assign(result, { [key]: parseSetting(key, source[key]) });
  }
  return result;
}

/** 平台相关的缺省项由调用方传入宿主有效值；共享层不推测安装方式和平台。 */
export function exportPortableSettings(
  settings: AppSettings,
  scope: PortableSettingScope,
): PortableSettings {
  let source: PortableSettings;
  switch (scope) {
    case "general":
      source = {
        defaultMode: settings.defaultMode ?? "agent",
        defaultPermissionMode: settings.defaultPermissionMode ?? "auto",
        enterToSend: settings.enterToSend ?? true,
        largePasteThreshold: normalizeLargePasteThreshold(settings.largePasteThreshold),
        keepAwakeWhileRunning: settings.keepAwakeWhileRunning !== false,
        preventScreenSleep: settings.preventScreenSleep === true,
        scheduledTasksEnabled: settings.scheduledTasksEnabled !== false,
        ...(settings.temporaryWorkspaceContextMenu === undefined ? {} : {
          temporaryWorkspaceContextMenu: settings.temporaryWorkspaceContextMenu,
        }),
        ...(settings.defaultCommandShell === undefined ? {} : {
          defaultCommandShell: settings.defaultCommandShell,
        }),
        ...(settings.updatePreference === undefined ? {} : {
          updatePreference: settings.updatePreference,
        }),
      };
      break;
    case "ai":
      source = {
        infiniteProviderRetry: settings.infiniteProviderRetry === true,
        runStatusReminderMinutes: normalizeRunStatusReminderMinutes(settings.runStatusReminderMinutes),
        askToolTimeoutMinutes: normalizeAskToolTimeoutMinutes(settings.askToolTimeoutMinutes),
        jevEnabled: settings.jevEnabled === true,
      };
      break;
    case "media":
      source = {
        imageGeneration: settings.imageGeneration ?? null,
        imageGenerationModels: settings.imageGenerationModels === null ? null :
          imageGenerationBindings(settings.imageGenerationModels, settings.imageGeneration),
        fileHosting: normalizeFileHostingSettings(settings.fileHosting),
        speech: settings.speech ?? {},
      };
      break;
    case "network":
      source = {
        networkProxy: settings.networkProxy ?? { mode: "system" },
        networkPolicy: { mode: normalizeNetworkPolicy(settings.networkPolicy).mode },
        pluginMarketSource: settings.pluginMarketSource ?? "official",
        pluginMarketCustomUrl: settings.pluginMarketCustomUrl ?? "",
      };
      break;
  }
  return parsePortableSettings(source, scope);
}
