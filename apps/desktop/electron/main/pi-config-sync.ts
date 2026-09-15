/**
 * Manual, explicit export of PI-Desktop providers into the system pi CLI
 * configuration (ADR 0257).
 *
 * Owns only file access for the export direction: reading `~/.pi/agent` files,
 * merging through the pure helpers in `@pi-desktop/shared`, atomic writes, and
 * the `pi-sync.json` sidecar that records managed keys and last fingerprints.
 * Provider rows and secrets are resolved by the caller through host RPC; this
 * module never talks to the host.
 *
 * Import stays on the existing explicit scan in
 * `importers/model-config.ts`, which already covers `~/.pi/agent/models.json`.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPiExportPlan,
  mergePiAuthRoot,
  mergePiModelsRoot,
  mergePiSettingsRoot,
  parseJsonDocument,
  type PiExportDefaults,
  type PiExportProvider,
  type PiSyncAction,
  type PiSyncApplyResult,
  type PiSyncFileId,
  type PiSyncPreview,
  type PiSyncStatus,
} from "@pi-desktop/shared";

const SYNC_STATE_FILE = "pi-sync.json";
const SYNC_STATE_VERSION = 1;

type PiSyncState = {
  version: number;
  lastSyncedAt: string | null;
  fingerprints: Partial<Record<PiSyncFileId, string>>;
  managedProviderKeys: string[];
  managedCredentialKeys: string[];
  providerKeyById: Record<string, string>;
};

const EMPTY_STATE: PiSyncState = {
  version: SYNC_STATE_VERSION,
  lastSyncedAt: null,
  fingerprints: {},
  managedProviderKeys: [],
  managedCredentialKeys: [],
  providerKeyById: {},
};

export type PiSyncRoots = {
  homeDir: string;
  agentDir: string;
  dataDir: string;
};

export function resolvePiSyncRoots(options?: {
  homeDir?: string;
  dataDir?: string;
}): PiSyncRoots {
  const home = options?.homeDir ?? os.homedir();
  const dataDir =
    options?.dataDir ??
    process.env.PI_DESKTOP_DATA_DIR ??
    path.join(home, ".pi-desktop");
  return { homeDir: home, agentDir: path.join(home, ".pi", "agent"), dataDir };
}

export type PiFileRead = {
  exists: boolean;
  text: string | null;
  json: unknown;
  fingerprint: string | null;
  path: string;
};

function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readPiFile(filePath: string): Promise<PiFileRead> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return {
      exists: true,
      text,
      json: parseJsonDocument(text),
      fingerprint: fingerprint(text),
      path: filePath,
    };
  } catch {
    return { exists: false, text: null, json: null, fingerprint: null, path: filePath };
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readState(dataDir: string): Promise<PiSyncState> {
  const file = path.join(dataDir, SYNC_STATE_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<PiSyncState>;
    return {
      version: SYNC_STATE_VERSION,
      lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : null,
      fingerprints:
        parsed.fingerprints && typeof parsed.fingerprints === "object"
          ? (parsed.fingerprints as PiSyncState["fingerprints"])
          : {},
      managedProviderKeys: Array.isArray(parsed.managedProviderKeys)
        ? parsed.managedProviderKeys.filter((key): key is string => typeof key === "string")
        : [],
      managedCredentialKeys: Array.isArray(parsed.managedCredentialKeys)
        ? parsed.managedCredentialKeys.filter((key): key is string => typeof key === "string")
        : [],
      providerKeyById:
        parsed.providerKeyById && typeof parsed.providerKeyById === "object"
          ? (parsed.providerKeyById as Record<string, string>)
          : {},
    };
  } catch {
    return { ...EMPTY_STATE, fingerprints: {}, providerKeyById: {} };
  }
}

async function writeState(dataDir: string, state: PiSyncState): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, SYNC_STATE_FILE);
  await writeFileAtomic(target, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Atomic replace: write a sibling temp file, then rename over the target. The
 * temp name is unique per call so a crash never renames a partial write of a
 * concurrent export.
 */
async function writeFileAtomic(
  target: string,
  contents: string,
  mode?: number,
): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      effectiveMode = (await fs.stat(target)).mode & 0o777;
    } catch {
      effectiveMode = undefined;
    }
  }
  await fs.writeFile(
    temp,
    contents,
    effectiveMode === undefined ? undefined : { mode: effectiveMode },
  );
  await fs.rename(temp, target);
}

function fileFor(agentDir: string, id: PiSyncFileId): string {
  return path.join(agentDir, `${id}.json`);
}

export type PiExportInput = {
  providers: PiExportProvider[];
  defaults?: PiExportDefaults;
  piKeyForProviderId?: (providerId: string) => string | undefined;
  /** Recorded provider-id → key mapping, merged into the sidecar on apply. */
  providerKeyById?: Record<string, string>;
};

type ExportPlan = {
  models: string | null;
  auth: string | null;
  settings: string | null;
  actions: PiSyncAction[];
  skipped: PiSyncAction[];
  managedProviderKeys: string[];
  managedCredentialKeys: string[];
};

async function planExport(
  roots: PiSyncRoots,
  state: PiSyncState,
  input: PiExportInput,
): Promise<{ plan: ExportPlan; drift: boolean; reads: Record<PiSyncFileId, PiFileRead> }> {
  const reads = {
    models: await readPiFile(fileFor(roots.agentDir, "models")),
    auth: await readPiFile(fileFor(roots.agentDir, "auth")),
    settings: await readPiFile(fileFor(roots.agentDir, "settings")),
  };

  const built = buildPiExportPlan({
    providers: input.providers,
    defaults: input.defaults,
    piKeyForProviderId: input.piKeyForProviderId,
  });

  const models = mergePiModelsRoot(
    reads.models.json,
    built.providers,
    state.managedProviderKeys,
  );
  const auth = mergePiAuthRoot(
    reads.auth.json,
    built.credentials,
    state.managedCredentialKeys,
  );
  const settings = mergePiSettingsRoot(reads.settings.json, built.defaults);

  const actions: PiSyncAction[] = [
    ...models.actions,
    ...auth.actions,
    ...settings.actions,
  ];
  const drift =
    (reads.models.fingerprint !== null &&
      state.fingerprints.models !== undefined &&
      reads.models.fingerprint !== state.fingerprints.models) ||
    (reads.auth.fingerprint !== null &&
      state.fingerprints.auth !== undefined &&
      reads.auth.fingerprint !== state.fingerprints.auth) ||
    (reads.settings.fingerprint !== null &&
      state.fingerprints.settings !== undefined &&
      reads.settings.fingerprint !== state.fingerprints.settings);

  const changeText = (read: PiFileRead, next: Record<string, unknown>): string | null => {
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    return serialized === read.text ? null : serialized;
  };

  return {
    plan: {
      models: changeText(reads.models, models.root),
      auth: changeText(reads.auth, auth.root),
      settings: changeText(reads.settings, settings.root),
      actions,
      skipped: built.skipped,
      managedProviderKeys: built.managedKeys,
      managedCredentialKeys: Object.keys(built.credentials),
    },
    drift,
    reads,
  };
}

export async function getPiSyncStatus(options?: {
  homeDir?: string;
  dataDir?: string;
}): Promise<PiSyncStatus> {
  const roots = resolvePiSyncRoots(options);
  const state = await readState(roots.dataDir);
  const records = await Promise.all(
    (["models", "auth", "settings"] as PiSyncFileId[]).map(async (id) => {
      const read = await readPiFile(fileFor(roots.agentDir, id));
      const recorded = state.fingerprints[id];
      return [
        id,
        {
          exists: read.exists,
          fingerprint: read.fingerprint,
          drifted:
            read.fingerprint !== null &&
            recorded !== undefined &&
            read.fingerprint !== recorded,
        },
      ] as const;
    }),
  );
  const files = Object.fromEntries(records) as PiSyncStatus["files"];
  return {
    agentDir: roots.agentDir,
    available: await pathExists(roots.agentDir),
    files,
    managedProviderKeys: state.managedProviderKeys,
    lastSyncedAt: state.lastSyncedAt,
  };
}

export async function previewPiExport(
  input: PiExportInput,
  options?: { homeDir?: string; dataDir?: string },
): Promise<PiSyncPreview> {
  const roots = resolvePiSyncRoots(options);
  const state = await readState(roots.dataDir);
  const { plan, drift } = await planExport(roots, state, input);
  const blockers: string[] = [];
  if (!(await pathExists(roots.agentDir))) blockers.push("pi-agent-dir-missing");
  return {
    direction: "export",
    agentDir: roots.agentDir,
    drift,
    actions: plan.actions,
    skipped: plan.skipped,
    blockers,
  };
}

export async function applyPiExport(
  input: PiExportInput,
  options?: { homeDir?: string; dataDir?: string },
): Promise<PiSyncApplyResult> {
  const roots = resolvePiSyncRoots(options);
  const empty: PiSyncApplyResult = {
    ok: false,
    applied: 0,
    skipped: 0,
    failed: 0,
    written: [],
  };
  if (!(await pathExists(roots.agentDir))) {
    return { ...empty, error: "pi-agent-dir-missing" };
  }

  const state = await readState(roots.dataDir);
  const { plan, reads } = await planExport(roots, state, input);

  const written: PiSyncFileId[] = [];
  const targets: Array<[PiSyncFileId, string | null, number | undefined]> = [
    ["models", plan.models, undefined],
    ["auth", plan.auth, 0o600],
    ["settings", plan.settings, undefined],
  ];
  try {
    for (const [id, contents, mode] of targets) {
      if (contents === null) continue;
      await writeFileAtomic(fileFor(roots.agentDir, id), contents, mode);
      written.push(id);
    }
  } catch (error) {
    return {
      ...empty,
      written,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const nextFingerprints = { ...state.fingerprints };
  for (const id of written) {
    const read = reads[id];
    const target = fileFor(roots.agentDir, id);
    const after = await readPiFile(target);
    nextFingerprints[id] = after.fingerprint ?? read.fingerprint ?? undefined;
  }
  await writeState(roots.dataDir, {
    version: SYNC_STATE_VERSION,
    lastSyncedAt: new Date().toISOString(),
    fingerprints: nextFingerprints,
    managedProviderKeys: plan.managedProviderKeys,
    managedCredentialKeys: plan.managedCredentialKeys,
    providerKeyById: { ...state.providerKeyById, ...(input.providerKeyById ?? {}) },
  }).catch(() => undefined);

  // A planned create/update only counts as applied when a file was actually
  // written; an unchanged re-export reports zero.
  const changed =
    written.length === 0
      ? 0
      : plan.actions.filter(
          (action) => action.action === "create" || action.action === "update",
        ).length;
  return {
    ok: true,
    applied: changed,
    skipped: plan.skipped.length,
    failed: 0,
    written,
  };
}

/** Resolve which pi provider key a Desktop provider id maps to. */
export function piKeyForProviderIdFrom(
  providers: readonly { id: string; key: string }[],
): (providerId: string) => string | undefined {
  const map = new Map(providers.map((provider) => [provider.id, provider.key]));
  return (providerId) => map.get(providerId);
}
