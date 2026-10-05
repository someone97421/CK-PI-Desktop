import type { SessionModelRef } from "./session-model";

export type RecentModel = { providerId: string; modelId: string };
const KEY = "pi.desktop.recentModels";
const LIMIT = 20;

export function sameRecentModel(left: RecentModel, right: RecentModel): boolean {
  return left.providerId === right.providerId && left.modelId.toLowerCase() === right.modelId.toLowerCase();
}

export function rememberModelInList(list: readonly RecentModel[], model: SessionModelRef): RecentModel[] {
  if (!model.providerId?.trim() || !model.modelId?.trim()) return [...list];
  const selected = { providerId: model.providerId, modelId: model.modelId };
  return [selected, ...list.filter(entry => !sameRecentModel(entry, selected))].slice(0, LIMIT);
}

export function loadRecentModels(): RecentModel[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentModel =>
      entry !== null && typeof entry === "object" &&
      typeof entry.providerId === "string" && !!entry.providerId.trim() &&
      typeof entry.modelId === "string" && !!entry.modelId.trim(),
    ).reduceRight<RecentModel[]>((list, entry) => rememberModelInList(list, entry), []);
  } catch {
    return [];
  }
}

export function saveRecentModels(models: readonly RecentModel[]): void {
  localStorage.setItem(KEY, JSON.stringify(models));
}
