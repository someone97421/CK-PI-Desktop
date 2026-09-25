import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SessionCompactionModel = { providerId: string; modelId: string };

const cached = new Map<string, Record<string, SessionCompactionModel>>();

function filePath(dataDir: string): string {
  return join(dataDir, "session-compaction-models.json");
}

function records(dataDir: string): Record<string, SessionCompactionModel> {
  const existing = cached.get(dataDir);
  if (existing) return existing;
  let value: Record<string, SessionCompactionModel> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath(dataDir), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, model] of Object.entries(raw)) {
        if (!model || typeof model !== "object" || Array.isArray(model)) continue;
        const entry = model as Record<string, unknown>;
        if (typeof entry.providerId === "string" && typeof entry.modelId === "string" &&
            entry.providerId && entry.modelId) {
          value[id] = { providerId: entry.providerId, modelId: entry.modelId };
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  cached.set(dataDir, value);
  return value;
}

export function getSessionCompactionModel(dataDir: string, sessionId: string): SessionCompactionModel | null {
  return records(dataDir)[sessionId] ?? null;
}

export function setSessionCompactionModel(
  dataDir: string,
  sessionId: string,
  model: SessionCompactionModel | null,
): SessionCompactionModel | null {
  const current = records(dataDir);
  const next = { ...current };
  if (model) next[sessionId] = model;
  else delete next[sessionId];
  const target = filePath(dataDir);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), "utf8");
  renameSync(temporary, target);
  cached.set(dataDir, next);
  return model;
}
