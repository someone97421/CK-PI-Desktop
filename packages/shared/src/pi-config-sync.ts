/**
 * Manual bidirectional sync between PI-Desktop providers and the system pi CLI
 * configuration (`~/.pi/agent/{models.json,auth.json,settings.json}`).
 *
 * This module is pure: every function takes already-parsed JSON and returns the
 * next document plus a preview of what changed. All file access, secret
 * resolution, and atomic writes live in Electron main (ADR 0257).
 *
 * Scope is fixed by ADR 0257:
 * - provider/model definitions, API keys, and the three model defaults only
 * - OAuth/subscription grants are never read or written in either direction
 * - export is upsert-and-preserve: unknown fields, unknown providers, and
 *   pi-only entries are never deleted
 * - `"!command"` and unresolved `$ENV` values are reported, never executed
 */

import type { ModelBinding, ThinkingLevel } from "./types.js";

export const PI_AGENT_DIR_NAME = ".pi";
export const PI_AGENT_SUBDIR = "agent";

/** Desktop `apiStyle` → pi `api`. */
export const PI_API_BY_STYLE: Record<string, string> = {
  chat_completions: "openai-completions",
  responses: "openai-responses",
  anthropic_messages: "anthropic-messages",
  google_generative_ai: "google-generative-ai",
};

export const PI_SYNC_DEFAULT_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
] as const;

export type PiSyncFileId = "models" | "auth" | "settings";

export type PiSyncFileState = {
  exists: boolean;
  /** sha256 of the last-read bytes; null when the file does not exist. */
  fingerprint: string | null;
  /** True when the file changed since the last recorded sync. */
  drifted: boolean;
};

export type PiSyncStatus = {
  agentDir: string;
  available: boolean;
  files: Record<PiSyncFileId, PiSyncFileState>;
  managedProviderKeys: string[];
  lastSyncedAt: string | null;
};

export type PiSyncActionKind = "provider" | "credential" | "model-default";

export type PiSyncAction = {
  kind: PiSyncActionKind;
  key: string;
  action: "create" | "update" | "unchanged" | "removed";
  name?: string;
  hasSecret?: boolean;
  reason?: string;
};

export type PiSyncPreview = {
  direction: "import" | "export";
  agentDir: string;
  /** True when any synced file changed since the last recorded sync. */
  drift: boolean;
  actions: PiSyncAction[];
  skipped: PiSyncAction[];
  blockers: string[];
};

export type PiSyncApplyResult = {
  ok: boolean;
  applied: number;
  skipped: number;
  failed: number;
  written: string[];
  error?: string;
};

/** One Desktop provider projected for export. Secrets are resolved by main. */
export type PiExportProvider = {
  /** Stable pi provider key; derive with `piProviderKeyFor`. */
  key: string;
  name: string;
  type?: string | null;
  vendorKey?: string | null;
  baseUrl?: string | null;
  apiStyle?: string | null;
  headers?: Record<string, string> | null;
  models: ModelBinding[];
  /** Resolved API key literal, or undefined when the provider has none. */
  apiKey?: string | null;
  /** True when the provider also holds a vendor OAuth grant (never synced). */
  hasOauth?: boolean;
};

export type PiExportDefaults = {
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  defaultThinkingLevel?: string | null;
};

export type PiExportPlan = {
  /** `models.json` provider upserts keyed by pi provider key. */
  providers: Record<string, Record<string, unknown>>;
  /** `auth.json` upserts keyed by pi provider key. */
  credentials: Record<string, { type: "api_key"; key: string }>;
  /** `settings.json` upserts. */
  defaults: Record<string, string>;
  managedKeys: string[];
  actions: PiSyncAction[];
  skipped: PiSyncAction[];
};

export function piProviderKeyFor(input: {
  type?: string | null;
  vendorKey?: string | null;
  name?: string | null;
  baseUrl?: string | null;
}): string {
  const vendor = (input.vendorKey ?? "").trim().toLowerCase();
  if (input.type === "native" && vendor) return slugifyPiKey(vendor);
  if (vendor && vendor !== "custom") return slugifyPiKey(vendor);
  const host = hostOfUrl(input.baseUrl);
  if (host) return slugifyPiKey(host);
  const name = (input.name ?? "").trim();
  return slugifyPiKey(name || "custom");
}

export function slugifyPiKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "custom";
}

export function hostOfUrl(value?: string | null): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return "";
  }
}

export function piApiForApiStyle(apiStyle?: string | null): string | undefined {
  const key = (apiStyle ?? "").trim().toLowerCase().replace(/-/g, "_");
  return PI_API_BY_STYLE[key];
}

/**
 * pi resolves `"!command"` by executing a shell command and `$ENV` by reading
 * the process environment. Neither is ever evaluated by PI-Desktop: such a
 * value is preserved verbatim and reported instead.
 */
export function isUnresolvedPiValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("!")) return true;
  if (trimmed.startsWith("$$") || trimmed.startsWith("$!")) return false;
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(trimmed);
}

export function piModelEntry(binding: ModelBinding): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: binding.id };
  if (binding.alias) entry.name = binding.alias;
  if (binding.contextWindow > 0) entry.contextWindow = binding.contextWindow;
  if (binding.maxTokens > 0) entry.maxTokens = binding.maxTokens;
  if (binding.supportsImages === true) entry.input = ["text", "image"];
  const activeLevels = binding.thinkingLevels.filter(
    (level): level is ThinkingLevel => level !== "off",
  );
  if (activeLevels.length > 0) entry.reasoning = true;
  return entry;
}

export function buildPiExportPlan(input: {
  providers: PiExportProvider[];
  defaults?: PiExportDefaults;
  /** Maps a Desktop provider id to its pi provider key. */
  piKeyForProviderId?: (providerId: string) => string | undefined;
}): PiExportPlan {
  const providers: Record<string, Record<string, unknown>> = {};
  const credentials: Record<string, { type: "api_key"; key: string }> = {};
  const actions: PiSyncAction[] = [];
  const skipped: PiSyncAction[] = [];

  const seen = new Set<string>();
  for (const provider of input.providers) {
    const key = provider.key;
    if (!key || seen.has(key)) {
      skipped.push({
        kind: "provider",
        key,
        action: "unchanged",
        name: provider.name,
        reason: key ? "duplicate-key" : "missing-key",
      });
      continue;
    }
    seen.add(key);
    const entry: Record<string, unknown> = {};
    const api = piApiForApiStyle(provider.apiStyle);
    if (provider.baseUrl) entry.baseUrl = provider.baseUrl;
    if (api) entry.api = api;
    if (provider.headers && Object.keys(provider.headers).length > 0) {
      entry.headers = { ...provider.headers };
    }
    const models = provider.models
      .filter((model) => model.id.trim().length > 0)
      .map((model) => piModelEntry(model));
    if (models.length > 0) entry.models = models;
    providers[key] = entry;
    actions.push({
      kind: "provider",
      key,
      action: "create",
      name: provider.name,
    });

    const apiKey = (provider.apiKey ?? "").trim();
    if (apiKey) {
      if (isUnresolvedPiValue(apiKey)) {
        skipped.push({
          kind: "credential",
          key,
          action: "unchanged",
          name: provider.name,
          reason: "unresolved-value",
        });
      } else {
        credentials[key] = { type: "api_key", key: apiKey };
        actions.push({
          kind: "credential",
          key,
          action: "update",
          name: provider.name,
          hasSecret: true,
        });
      }
    }
    if (provider.hasOauth) {
      skipped.push({
        kind: "credential",
        key,
        action: "unchanged",
        name: provider.name,
        reason: "oauth-not-synced",
      });
    }
  }

  const mapped = input.defaults?.defaultProviderId
    ? input.piKeyForProviderId?.(input.defaults.defaultProviderId)
    : undefined;
  const defaults: Record<string, string> = {};
  if (mapped) defaults.defaultProvider = mapped;
  if (input.defaults?.defaultModelId) defaults.defaultModel = input.defaults.defaultModelId;
  if (input.defaults?.defaultThinkingLevel) {
    defaults.defaultThinkingLevel = input.defaults.defaultThinkingLevel;
  }
  for (const key of Object.keys(defaults)) {
    actions.push({ kind: "model-default", key, action: "update" });
  }

  return {
    providers,
    credentials,
    defaults,
    managedKeys: Object.keys(providers),
    actions,
    skipped,
  };
}

export type PiMergeAction = {
  kind: PiSyncActionKind;
  key: string;
  action: "create" | "update" | "unchanged" | "removed";
  name?: string;
  hasSecret?: boolean;
  reason?: string;
};

export type PiMergeResult = {
  root: Record<string, unknown>;
  actions: PiMergeAction[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeModelsArray(existing: unknown, next: unknown): unknown {
  if (!Array.isArray(next)) return existing;
  const previous = Array.isArray(existing) ? existing : [];
  const byId = new Map<string, unknown>();
  for (const item of previous) {
    const id = asRecord(item).id;
    if (typeof id === "string" && id) byId.set(id, item);
  }
  for (const item of next) {
    const id = asRecord(item).id;
    if (typeof id === "string" && id) {
      const prior = asRecord(byId.get(id));
      byId.set(id, { ...prior, ...asRecord(item) });
    }
  }
  return Array.from(byId.values());
}

/**
 * Upsert `models.json` providers. Unknown root keys, unknown providers, and
 * unknown fields inside a synced provider are preserved. A previously managed
 * key that is absent from `providers` is reported as removed and left in place.
 */
export function mergePiModelsRoot(
  existing: unknown,
  providers: Record<string, Record<string, unknown>>,
  managedKeys: readonly string[] = [],
): PiMergeResult {
  const root = { ...asRecord(existing) };
  const current = { ...asRecord(root.providers) };
  const actions: PiMergeAction[] = [];

  for (const [key, entry] of Object.entries(providers)) {
    const prior = asRecord(current[key]);
    const existed = Object.keys(prior).length > 0;
    const merged: Record<string, unknown> = { ...prior, ...entry };
    if (entry.models !== undefined) {
      merged.models = mergeModelsArray(prior.models, entry.models);
    }
    current[key] = merged;
    actions.push({
      kind: "provider",
      key,
      action: existed ? "update" : "create",
      name: typeof entry.name === "string" ? entry.name : undefined,
    });
  }

  for (const key of managedKeys) {
    if (providers[key]) continue;
    if (!(key in current)) continue;
    actions.push({ kind: "provider", key, action: "removed", reason: "no-longer-managed" });
  }

  root.providers = current;
  return { root, actions };
}

/** Upsert `auth.json` API-key entries; unknown entries are preserved. */
export function mergePiAuthRoot(
  existing: unknown,
  credentials: Record<string, { type: "api_key"; key: string }>,
  managedKeys: readonly string[] = [],
): PiMergeResult {
  const root = { ...asRecord(existing) };
  const actions: PiMergeAction[] = [];
  for (const [key, entry] of Object.entries(credentials)) {
    const existed = key in root;
    root[key] = { ...asRecord(root[key]), ...entry };
    actions.push({
      kind: "credential",
      key,
      action: existed ? "update" : "create",
      hasSecret: true,
    });
  }
  for (const key of managedKeys) {
    if (credentials[key]) continue;
    if (!(key in root)) continue;
    actions.push({ kind: "credential", key, action: "removed", reason: "no-longer-managed" });
  }
  return { root, actions };
}

/** Upsert only the three model defaults; every other setting is preserved. */
export function mergePiSettingsRoot(
  existing: unknown,
  defaults: Record<string, string>,
): PiMergeResult {
  const root = { ...asRecord(existing) };
  const actions: PiMergeAction[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    const changed = root[key] !== value;
    root[key] = value;
    actions.push({
      kind: "model-default",
      key,
      action: changed ? "update" : "unchanged",
    });
  }
  return { root, actions };
}

/**
 * Read API keys out of a parsed `auth.json`. OAuth and non-api_key entries are
 * returned separately so the caller can report them as skipped.
 */
export function parsePiAuthApiKeys(auth: unknown): {
  keys: Record<string, string>;
  oauthKeys: string[];
  unresolvedKeys: string[];
} {
  const root = asRecord(auth);
  const keys: Record<string, string> = {};
  const oauthKeys: string[] = [];
  const unresolvedKeys: string[] = [];
  for (const [id, raw] of Object.entries(root)) {
    const entry = asRecord(raw);
    const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
    if (type && type !== "api_key" && type !== "apikey" && type !== "api-key") {
      oauthKeys.push(id);
      continue;
    }
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) continue;
    if (isUnresolvedPiValue(key)) {
      unresolvedKeys.push(id);
      continue;
    }
    keys[id] = key;
  }
  return { keys, oauthKeys, unresolvedKeys };
}
