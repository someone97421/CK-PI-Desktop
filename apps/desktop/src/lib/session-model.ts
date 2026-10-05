/** Resolve the provider/model a session should keep after first selection. */
import type { RecentModel } from "./recent-models";

export type SessionModelRef = {
  providerId?: string;
  modelId?: string;
};

export type SessionModelProvider = {
  id: string;
  defaultModelId?: string;
  models?: Array<{ id: string }>;
  enabled?: boolean;
  hasSecret?: boolean;
  authKind?: string;
};

export type SessionModelSettings = {
  defaultProviderId?: string;
  defaultModelId?: string;
  imageGeneration?: SessionModelRef | null;
  imageGenerationModels?: SessionModelRef[] | null;
};

/** Only configured, runnable chat bindings can be inherited by a new chat. */
export function availableRecentModels(
  recentModels: readonly RecentModel[],
  providers: readonly SessionModelProvider[],
  settings?: SessionModelSettings | null,
): RecentModel[] {
  const images = [
    ...(settings?.imageGenerationModels ?? []),
    ...(settings?.imageGeneration ? [settings.imageGeneration] : []),
  ];
  return recentModels.filter(entry => {
    const provider = providers.find(item => item.id === entry.providerId);
    const ids = provider?.models?.length ? provider.models.map(model => model.id) : [provider?.defaultModelId];
    return provider && provider.enabled !== false &&
      (provider.authKind === undefined || provider.authKind === "none" || provider.hasSecret) &&
      ids.some(id => id?.toLowerCase() === entry.modelId.toLowerCase()) &&
      !images.some(image => image.providerId === entry.providerId && image.modelId?.toLowerCase() === entry.modelId.toLowerCase());
  });
}

/**
 * 创建会话时固定应用默认模型或明确选择的草稿模型。
 * 近期模型仅用于菜单，不影响新会话继承。
 */
export function inheritedSessionModelBinding({
  draft,
  settings,
  providers,
}: {
  draft?: SessionModelRef | null;
  settings?: SessionModelSettings | null;
  providers: readonly SessionModelProvider[];
  recentModels?: readonly RecentModel[];
}): SessionModelRef {
  const providerId = draft?.providerId ?? settings?.defaultProviderId;
  const provider = providers.find((item) => item.id === providerId);
  const modelId =
    draft?.modelId ??
    settings?.defaultModelId ??
    provider?.defaultModelId ??
    provider?.models?.[0]?.id;
  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/** Newest transcript turn that already recorded a provider/model. */
export function lastUsedSessionModel(
  messages: readonly SessionModelRef[],
): SessionModelRef {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.modelId || message.providerId) {
      return {
        ...(message.providerId ? { providerId: message.providerId } : {}),
        ...(message.modelId ? { modelId: message.modelId } : {}),
      };
    }
  }
  return {};
}

export function sessionNeedsModelPin(
  session: SessionModelRef & { source?: string },
): boolean {
  if (session.source === "pi-native" || session.source === "remote") return false;
  return !session.providerId || !session.modelId;
}

/**
 * 未绑定会话使用最近一轮已有绑定，否则使用应用默认模型。
 * 固定后不随设置变化。
 */
export function pinnedSessionModelBinding({
  session,
  messages,
  settings,
  providers,
}: {
  session: SessionModelRef;
  messages?: readonly SessionModelRef[];
  settings?: SessionModelSettings | null;
  providers: readonly SessionModelProvider[];
  recentModels?: readonly RecentModel[];
}): SessionModelRef {
  const used = lastUsedSessionModel(messages ?? []);
  return inheritedSessionModelBinding({
    draft: {
      providerId: session.providerId ?? used.providerId,
      modelId: session.modelId ?? used.modelId,
    },
    settings,
    providers,
  });
}
