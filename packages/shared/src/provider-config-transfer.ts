/**
 * Import/export of provider settings as a portable JSON file.
 *
 * The file is meant to move a provider setup between machines or keep a
 * backup, so it carries everything the provider dialog owns: endpoints,
 * headers, model selections, and the per-model overrides. Credentials are
 * optional and travel in a plainly named `apiKey` field — a vendor OAuth grant
 * is never exported, because only the vendor can reissue one.
 *
 * Validation stays at the envelope level plus `name`. The field-level rules
 * already live in host-core, which rejects anything malformed on create or
 * update, and duplicating them here would let the two drift apart.
 */

import type { ModelBinding, ThinkingLevel } from "./types.js";

export const PROVIDER_EXPORT_KIND = "pi-desktop.providers";
export const PROVIDER_EXPORT_VERSION = 1;

export type ProviderExportEntry = {
  name: string;
  vendorKey?: string;
  type?: "native" | "openai_compatible" | "custom";
  protocol?: string;
  apiStyle?: string;
  baseUrl?: string;
  authKind?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  models?: ModelBinding[];
  /** @deprecated Mirrors the provider row; `models[0]?.id` is authoritative. */
  defaultModelId?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: ThinkingLevel[];
  oauthAccountLabel?: string;
  /** Present only when the export included credentials. */
  apiKey?: string;
};

export type ProviderExportFile = {
  kind: typeof PROVIDER_EXPORT_KIND;
  version: number;
  exportedAt: string;
  app?: string;
  providers: ProviderExportEntry[];
};

/** The subset of a provider row this module reads. */
export type ProviderSource = {
  name: string;
  vendorKey?: string | null;
  type?: string | null;
  protocol?: string | null;
  apiStyle?: string | null;
  baseUrl?: string | null;
  authKind?: string | null;
  enabled?: boolean;
  headers?: Record<string, string> | null;
  models?: ModelBinding[] | null;
  defaultModelId?: string | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  supportsReasoning?: boolean;
  supportedThinkingLevels?: ThinkingLevel[] | null;
  oauthAccountLabel?: string | null;
  hasOauth?: boolean;
};

export type ProviderParseResult =
  | { ok: true; file: ProviderExportFile; warnings: string[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Drop blanks so an export never carries `undefined`-shaped noise. */
function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out as T;
}

/** Project one provider row into its export shape. */
export function providerExportEntryFrom(
  provider: ProviderSource,
  apiKey?: string | null,
): ProviderExportEntry {
  const type =
    provider.type === "native" ||
    provider.type === "openai_compatible" ||
    provider.type === "custom"
      ? provider.type
      : undefined;
  return compact({
    name: provider.name,
    vendorKey: optionalString(provider.vendorKey)?.toLowerCase(),
    type,
    protocol: optionalString(provider.protocol),
    apiStyle: optionalString(provider.apiStyle),
    baseUrl: optionalString(provider.baseUrl),
    authKind: optionalString(provider.authKind),
    enabled: provider.enabled === false ? false : undefined,
    headers: provider.headers ?? undefined,
    models: provider.models ?? undefined,
    defaultModelId: optionalString(provider.defaultModelId),
    contextWindow: optionalNumber(provider.contextWindow),
    maxOutputTokens: optionalNumber(provider.maxOutputTokens),
    temperature: optionalNumber(provider.temperature),
    supportsReasoning: provider.supportsReasoning === true ? true : undefined,
    supportedThinkingLevels: provider.supportedThinkingLevels ?? undefined,
    oauthAccountLabel: optionalString(provider.oauthAccountLabel),
    apiKey: optionalString(apiKey),
  }) as ProviderExportEntry;
}

export function buildProviderExportFile(
  entries: ProviderExportEntry[],
  options: { app?: string; now?: Date } = {},
): ProviderExportFile {
  return {
    kind: PROVIDER_EXPORT_KIND,
    version: PROVIDER_EXPORT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    ...(options.app ? { app: options.app } : {}),
    providers: entries,
  };
}

/**
 * Validate an uploaded document. Tolerant about extra fields, strict about the
 * envelope and about `name`, which is the only field the import depends on for
 * matching.
 */
export function parseProviderExportFile(input: unknown): ProviderParseResult {
  let document: unknown = input;
  if (typeof input === "string") {
    try {
      document = JSON.parse(input);
    } catch {
      return { ok: false, error: "PROVIDER_IMPORT_INVALID: not valid JSON" };
    }
  }
  if (!isRecord(document)) {
    return { ok: false, error: "PROVIDER_IMPORT_INVALID: expected a JSON object" };
  }
  if (document.kind !== PROVIDER_EXPORT_KIND) {
    return {
      ok: false,
      error: `PROVIDER_IMPORT_INVALID: not a provider export (kind=${String(document.kind)})`,
    };
  }
  const version = optionalNumber(document.version);
  if (version === undefined) {
    return { ok: false, error: "PROVIDER_IMPORT_INVALID: missing version" };
  }
  if (version > PROVIDER_EXPORT_VERSION) {
    return {
      ok: false,
      error: `PROVIDER_IMPORT_INVALID: version ${version} is newer than this build supports`,
    };
  }
  if (!Array.isArray(document.providers)) {
    return { ok: false, error: "PROVIDER_IMPORT_INVALID: providers must be an array" };
  }

  const warnings: string[] = [];
  const providers: ProviderExportEntry[] = [];
  document.providers.forEach((raw, index) => {
    if (!isRecord(raw) || !optionalString(raw.name)) {
      warnings.push(`entry ${index + 1}: skipped, no name`);
      return;
    }
    providers.push(raw as ProviderExportEntry);
  });
  if (providers.length === 0) {
    return { ok: false, error: "PROVIDER_IMPORT_INVALID: no usable providers" };
  }

  return {
    ok: true,
    warnings,
    file: {
      kind: PROVIDER_EXPORT_KIND,
      version,
      exportedAt: optionalString(document.exportedAt) ?? new Date().toISOString(),
      ...(optionalString(document.app) ? { app: String(document.app) } : {}),
      providers,
    },
  };
}

/** Lower-cased name is the identity an import matches on. */
export function providerImportKey(entry: { name: string }): string {
  return entry.name.trim().toLowerCase();
}

export type ProviderImportStep = {
  action: "create" | "update";
  key: string;
  entry: ProviderExportEntry;
  id?: string;
};

export type ProviderImportPlan = {
  steps: ProviderImportStep[];
  /** Names repeated inside one file; only the first occurrence is applied. */
  duplicates: string[];
};

/**
 * Plan an import against the providers that already exist. A name match
 * updates in place so re-importing a backup never duplicates rows. Repeats
 * inside the file itself are dropped: host-core rejects a duplicate name, and
 * silently turning the second copy into an update would target a row id that
 * does not exist yet.
 */
export function planProviderImport(
  existing: ReadonlyArray<{ id: string; name: string }>,
  entries: readonly ProviderExportEntry[],
): ProviderImportPlan {
  const byKey = new Map<string, string>();
  for (const provider of existing) byKey.set(providerImportKey(provider), provider.id);

  const steps: ProviderImportStep[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = providerImportKey(entry);
    if (seen.has(key)) {
      duplicates.push(entry.name);
      continue;
    }
    seen.add(key);
    const id = byKey.get(key);
    steps.push(id ? { action: "update", key, entry, id } : { action: "create", key, entry });
  }
  return { steps, duplicates };
}

/** Fields host-core accepts on create/update for a provider row. */
export function providerImportPayload(entry: ProviderExportEntry): Record<string, unknown> {
  return compact({
    name: entry.name.trim(),
    vendorKey: entry.vendorKey,
    type: entry.type,
    protocol: entry.protocol,
    apiStyle: entry.apiStyle,
    baseUrl: entry.baseUrl,
    authKind: entry.authKind,
    headers: entry.headers,
    models: entry.models,
    defaultModelId: entry.defaultModelId,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    temperature: entry.temperature,
    supportsReasoning: entry.supportsReasoning,
    supportedThinkingLevels: entry.supportedThinkingLevels,
    oauthAccountLabel: entry.oauthAccountLabel,
  });
}

export type ProviderImportResult = {
  ok: boolean;
  canceled?: boolean;
  created: number;
  updated: number;
  failed: number;
  warnings: string[];
  errors: string[];
};

export type ProviderExportResult = {
  ok: boolean;
  canceled?: boolean;
  count: number;
  /** Number of entries that carried a credential. Report only, never the value. */
  withCredentials: number;
  path?: string;
  error?: string;
};
