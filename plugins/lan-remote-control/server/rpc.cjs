"use strict";

/**
 * RPC surface: operation whitelist, mutation idempotency, adapter dispatch.
 *
 * The operation catalogue itself is owned by the host adapter — this module
 * imports whatever `adapter.cjs` exports (`OPERATION_META`, or the
 * `READ_OPERATIONS` / `MUTATION_OPERATIONS` pair) so the two sides cannot
 * drift. When the adapter exports nothing usable, everything except
 * `capabilities` fails closed with `UNSUPPORTED`.
 */

const crypto = require("node:crypto");

const MAX_OPERATION_LENGTH = 64;
const MAX_MUTATION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MUTATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_MUTATIONS_PER_DEVICE = 200;
const DEFAULT_MAX_IN_FLIGHT_PER_DEVICE = 8;
/**
 * How long a settled mutation id is remembered after its entry is evicted, so a
 * late retry of the original POST is refused instead of silently executing as a
 * fresh mutation. Kept well above the entry TTL: the gap between "the client
 * came back" and "the entry is gone" is exactly the dangerous window.
 */
const DEFAULT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES_PER_DEVICE = 2000;
const OPERATION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,4}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys the server owns inside `input`; a browser must never supply them. */
const RESERVED_INPUT_KEYS = new Set(["__attachments", "attachmentPaths", "attachmentPathsInternal"]);
/** Path-ish keys refused unless the operation explicitly opts in. */
const PATH_INPUT_KEYS = ["path", "filePath", "absolutePath", "file", "directory", "cwd"];

const STATUS_BY_CODE = Object.freeze({
  INVALID_PARAMS: 400,
  INVALID_ARGUMENT: 400,
  UNAUTHORIZED: 401,
  PERMISSION_DENIED: 403,
  CONFIRMATION_REQUIRED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  MUTATION_CONFLICT: 409,
  MUTATION_EXPIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  OPERATION_NOT_ALLOWED: 400,
  UNSUPPORTED: 501,
  NOT_READY: 503,
  UNAVAILABLE: 503,
  TIMEOUT: 504,
  INTERNAL: 500,
});

function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 400;
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isOperationName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPERATION_LENGTH &&
    OPERATION_NAME_PATTERN.test(value)
  );
}

function normalizeEntry(name, meta, mutation) {
  const record = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const declaredMutation = record.mutation === true || record.kind === "mutation";
  return {
    name,
    mutation: mutation === undefined ? declaredMutation : mutation === true || declaredMutation,
    attachments: record.attachments === true,
    allowsPath: record.allowsPath === true,
    sessionScoped: record.sessionScoped !== false,
  };
}

/**
 * Build the whitelist from an adapter module.
 *
 * Accepted shapes, in order of preference:
 *   `OPERATION_META`        → `{ "chat.send": { mutation: true, attachments: true } }`
 *   `READ_OPERATIONS` + `MUTATION_OPERATIONS` → arrays of strings or `{ name, ... }`
 */
function buildOperationTable(adapterModule) {
  const source = adapterModule && typeof adapterModule === "object" ? adapterModule : {};
  const table = new Map();

  const meta = source.OPERATION_META;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [name, entry] of Object.entries(meta)) {
      if (!isOperationName(name)) continue;
      table.set(name, normalizeEntry(name, entry, undefined));
    }
  }

  const addList = (list, mutation) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const name = typeof item === "string" ? item : item && typeof item === "object" ? item.name : null;
      if (!isOperationName(name)) continue;
      const existing = table.get(name);
      if (existing) {
        existing.mutation = existing.mutation || mutation;
        if (item && typeof item === "object") {
          if (item.attachments === true) existing.attachments = true;
          if (item.allowsPath === true) existing.allowsPath = true;
        }
        continue;
      }
      table.set(name, normalizeEntry(name, item, mutation));
    }
  };
  addList(source.READ_OPERATIONS, false);
  addList(source.MUTATION_OPERATIONS, true);

  if (table.size === 0) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message:
        "adapter.cjs did not export an operation catalogue (OPERATION_META or READ_OPERATIONS/MUTATION_OPERATIONS)",
      table: new Map(),
    };
  }
  return { ok: true, table };
}

/** Deterministic JSON: key order must not change the idempotency digest. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Digest input for idempotency: attachments contribute ids, never server paths. */
function digestInput(input) {
  if (!input || typeof input !== "object") return input ?? null;
  const clone = { ...input };
  if (Array.isArray(clone.__attachments)) {
    clone.__attachments = clone.__attachments.map((item) => ({
      id: item?.id ?? null,
      name: item?.name ?? null,
      mimeType: item?.mimeType ?? null,
      size: item?.size ?? null,
      kind: item?.kind ?? null,
    }));
  }
  return clone;
}

function digestFor(operation, input) {
  return crypto.createHash("sha256").update(stableStringify({ operation, input: digestInput(input) }), "utf8").digest("hex");
}

function codedError(code, message) {
  return { code: String(code), message: String(message) };
}

/**
 * Mutation ledger.
 *
 * A mutation is stored by `mutationId` per device. Identical payloads reuse the
 * stored outcome (including failures — the server never retries on its own),
 * a different payload under the same id is a conflict, and capacity pressure
 * never evicts an in-flight entry.
 */
class MutationStore {
  constructor({
    ttlMs = DEFAULT_MUTATION_TTL_MS,
    maxPerDevice = DEFAULT_MAX_MUTATIONS_PER_DEVICE,
    maxInFlightPerDevice = DEFAULT_MAX_IN_FLIGHT_PER_DEVICE,
    tombstoneTtlMs = DEFAULT_TOMBSTONE_TTL_MS,
    now = Date.now,
  } = {}) {
    this.ttlMs = Math.min(MAX_MUTATION_TTL_MS, Math.max(1000, ttlMs));
    this.maxPerDevice = maxPerDevice;
    this.maxInFlightPerDevice = maxInFlightPerDevice;
    this.tombstoneTtlMs = Math.max(this.ttlMs, tombstoneTtlMs);
    this.now = now;
    /** deviceId → Map(mutationId → entry) */
    this.entries = new Map();
    /** deviceId → Map(mutationId → tombstone expiry); ids that must not replay. */
    this.tombstones = new Map();
  }

  forDevice(deviceId) {
    let bucket = this.entries.get(deviceId);
    if (!bucket) {
      bucket = new Map();
      this.entries.set(deviceId, bucket);
    }
    return bucket;
  }

  countInFlight(bucket) {
    let count = 0;
    for (const entry of bucket.values()) {
      if (entry.state === "in-progress") count += 1;
    }
    return count;
  }

  /**
   * Remember a settled mutation id after its entry is dropped. A late retry of
   * the original POST then gets `MUTATION_EXPIRED` instead of quietly running
   * the mutation a second time.
   */
  markTombstone(deviceId, mutationId) {
    let stones = this.tombstones.get(deviceId);
    if (!stones) {
      stones = new Map();
      this.tombstones.set(deviceId, stones);
    }
    stones.set(mutationId, this.now() + this.tombstoneTtlMs);
    while (stones.size > MAX_TOMBSTONES_PER_DEVICE) {
      const oldest = stones.keys().next().value;
      if (oldest === undefined) break;
      stones.delete(oldest);
    }
  }

  isTombstoned(deviceId, mutationId) {
    const stones = this.tombstones.get(deviceId);
    if (!stones) return false;
    const expiresAt = stones.get(mutationId);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      stones.delete(mutationId);
      return false;
    }
    return true;
  }

  sweep() {
    const current = this.now();
    for (const [deviceId, bucket] of this.entries) {
      for (const [mutationId, entry] of bucket) {
        if (entry.state === "in-progress") continue;
        if (current - entry.completedAt >= this.ttlMs) {
          bucket.delete(mutationId);
          this.markTombstone(deviceId, mutationId);
        }
      }
      if (bucket.size === 0) this.entries.delete(deviceId);
    }
    for (const [deviceId, stones] of this.tombstones) {
      for (const [mutationId, expiresAt] of stones) {
        if (current >= expiresAt) stones.delete(mutationId);
      }
      if (stones.size === 0) this.tombstones.delete(deviceId);
    }
  }

  /** Read-only lookup for `GET /api/mutation/:id`. */
  describe(deviceId, mutationId) {
    this.sweep();
    const entry = this.entries.get(deviceId)?.get(mutationId) ?? null;
    if (entry) return { known: true, expired: false, entry };
    if (this.isTombstoned(deviceId, mutationId)) return { known: false, expired: true, entry: null };
    return { known: false, expired: false, entry: null };
  }

  /**
   * Reserve or join a mutation.
   * → `{ status: "new" | "in-progress" | "completed" | "conflict" | "expired" | "limit", entry? }`
   */
  begin({ deviceId, mutationId, digest, operation }) {
    this.sweep();
    const bucket = this.forDevice(deviceId);
    const existing = bucket.get(mutationId);
    if (existing) {
      if (existing.digest !== digest) return { status: "conflict" };
      if (existing.state === "in-progress") return { status: "in-progress", entry: existing };
      return { status: "completed", entry: existing };
    }
    if (this.isTombstoned(deviceId, mutationId)) return { status: "expired" };

    if (bucket.size >= this.maxPerDevice) {
      // Evict oldest completed first; an in-flight mutation is never dropped.
      const completed = [...bucket.values()]
        .filter((entry) => entry.state !== "in-progress")
        .sort((left, right) => left.completedAt - right.completedAt);
      while (bucket.size >= this.maxPerDevice && completed.length) {
        const victim = completed.shift();
        bucket.delete(victim.mutationId);
        this.markTombstone(deviceId, victim.mutationId);
      }
      if (bucket.size >= this.maxPerDevice) return { status: "limit" };
    }
    if (this.countInFlight(bucket) >= this.maxInFlightPerDevice) return { status: "limit" };

    let resolvePromise = () => {};
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    const entry = {
      mutationId,
      deviceId,
      operation,
      digest,
      state: "in-progress",
      createdAt: this.now(),
      completedAt: this.now(),
      outcome: null,
      promise,
      resolve: resolvePromise,
    };
    bucket.set(mutationId, entry);
    return { status: "new", entry };
  }

  settle(entry, outcome) {
    if (!entry || entry.state !== "in-progress") return;
    entry.state = outcome.ok ? "done" : "failed";
    entry.outcome = outcome;
    entry.completedAt = this.now();
    entry.resolve(entry);
  }

  clear() {
    this.entries.clear();
    this.tombstones.clear();
  }
}

/**
 * Resolve the adapter, which may be handed over as a getter so a reload that
 * swaps the instance (development plugins reload on save) is picked up.
 */
function resolveAdapter(adapter) {
  return typeof adapter === "function" ? adapter() : adapter;
}

/** Normalize whatever `adapter.invoke` returns or throws into one shape. */
async function callAdapter(adapter, operation, input, context) {
  const target = resolveAdapter(adapter);
  if (!target || typeof target.invoke !== "function") {
    return { ok: false, code: "UNSUPPORTED", message: "host adapter is unavailable" };
  }
  let value;
  try {
    value = await target.invoke(operation, input, context);
    return { ok: true, result: value === undefined ? null : value };
  } catch (error) {
    const code = typeof error?.code === "string" && error.code ? error.code : "INTERNAL";
    const message = error?.message ? String(error.message) : "operation failed";
    return { ok: false, code, message };
  }
}

/**
 * Create the RPC handler used by the HTTP route.
 *
 * `getOperationTable()` is read per request so a reloaded adapter (development
 * plugins reload on save) is picked up without restarting the server.
 */
function createRpcDispatcher({
  adapter,
  getOperationTable,
  getCapabilities,
  attachments,
  log = () => {},
} = {}) {
  const mutations = new MutationStore();

  const resolveCapabilities = async () => {
    if (typeof getCapabilities !== "function") return null;
    try {
      const value = await getCapabilities();
      return value && typeof value === "object" ? value : null;
    } catch (error) {
      log(`capabilities failed: ${error?.message ?? error}`);
      return null;
    }
  };

  const capabilityBlock = (capabilities, operation) => {
    const operations = capabilities?.operations;
    if (!operations) return null;
    const entry = Array.isArray(operations)
      ? operations.includes(operation)
        ? {}
        : { supported: false }
      : operations[operation];
    if (!entry) return { supported: false };
    if (typeof entry === "boolean") return { supported: entry };
    if (entry && typeof entry === "object") {
      return { supported: entry.supported !== false, reason: entry.reason };
    }
    return { supported: true };
  };

  /**
   * `handle({ deviceId, sessionId, body })` → `{ status, envelope }`.
   * The HTTP layer writes `envelope` verbatim.
   */
  const handle = async ({ deviceId, sessionId, body, isAuthorized = () => false }) => {
    const requestId = typeof body?.requestId === "string" && body.requestId.length <= 64 ? body.requestId : undefined;
    const fail = (code, message, requestIdOverride) => ({
      status: statusForCode(code),
      envelope: {
        ok: false,
        error: codedError(code, message),
        ...(requestIdOverride ?? requestId ? { requestId: requestIdOverride ?? requestId } : {}),
      },
    });

    if (!requestId || !isUuid(requestId)) {
      return fail("INVALID_PARAMS", "requestId must be a UUID", undefined);
    }
    const operation = body?.operation;
    if (!isOperationName(operation)) {
      return fail("INVALID_PARAMS", "operation is required");
    }

    const tableResult = typeof getOperationTable === "function" ? getOperationTable() : buildOperationTable(null);
    const operationEntry = tableResult?.ok ? tableResult.table.get(operation) : null;

    // `capabilities` is answerable even when the adapter exports no catalogue:
    // the panel and the phone render capability state from it.
    if (operation === "capabilities") {
      const capabilities = await resolveCapabilities();
      return {
        status: 200,
        envelope: { ok: true, result: capabilities, requestId },
      };
    }

    if (!tableResult?.ok) {
      return fail("UNSUPPORTED", tableResult?.message ?? "adapter did not declare any operations");
    }
    if (!operationEntry) {
      return fail("OPERATION_NOT_ALLOWED", `operation is not allowed: ${operation}`);
    }

    const mutationId = body?.mutationId;
    if (operationEntry.mutation) {
      if (!isUuid(mutationId)) {
        return fail("INVALID_PARAMS", "mutationId is required for this operation");
      }
    } else if (mutationId !== undefined) {
      return fail("INVALID_PARAMS", "mutationId is only meaningful for mutating operations");
    }

    if (body?.input !== undefined && (body.input === null || typeof body.input !== "object" || Array.isArray(body.input))) {
      return fail("INVALID_PARAMS", "input must be an object");
    }
    const input = { ...(body?.input ?? {}) };

    for (const key of Object.keys(input)) {
      if (RESERVED_INPUT_KEYS.has(key)) {
        return fail("INVALID_PARAMS", `${key} is reserved by the server`);
      }
    }
    if (!operationEntry.allowsPath) {
      for (const key of PATH_INPUT_KEYS) {
        if (input[key] !== undefined) {
          return fail("INVALID_PARAMS", `${key} is not accepted; reference local data by id`);
        }
      }
    }

    if (input.attachmentIds !== undefined) {
      if (!operationEntry.attachments) {
        return fail("INVALID_PARAMS", "operation does not accept attachments");
      }
      const resolved = attachments
        ? await attachments.resolveForRpc(input.attachmentIds, { deviceId, sessionId })
        : { ok: false, code: "UNSUPPORTED", message: "attachment store is unavailable" };
      if (!resolved.ok) return fail(resolved.code, resolved.message);
      delete input.attachmentIds;
      if (resolved.items.length) input.__attachments = attachments.toAdapterDescriptors(resolved.items);
    }

    const capabilities = await resolveCapabilities();
    const capability = capabilityBlock(capabilities, operation);
    if (capability && capability.supported === false) {
      const reason = capability.reason ? `: ${capability.reason}` : "";
      return fail("UNSUPPORTED", `operation is not supported by this host${reason}`);
    }

    const execute = async () => {
      if (!isAuthorized()) return { ok: false, error: codedError("UNAUTHORIZED", "device authorization was revoked") };
      const outcome = await callAdapter(adapter, operation, input, { isAuthorized });
      if (outcome.ok) return { ok: true, result: outcome.result };
      return { ok: false, error: codedError(outcome.code, outcome.message) };
    };

    if (!operationEntry.mutation) {
      const outcome = await execute();
      if (outcome.ok) return { status: 200, envelope: { ok: true, result: outcome.result, requestId } };
      return {
        status: statusForCode(outcome.error.code),
        envelope: { ok: false, error: outcome.error, requestId },
      };
    }

    const digest = digestFor(operation, input);
    const reservation = mutations.begin({ deviceId, mutationId, digest, operation });
    if (reservation.status === "conflict") {
      return fail("MUTATION_CONFLICT", "mutationId was already used with a different payload");
    }
    if (reservation.status === "expired") {
      // The original attempt was settled and its record evicted. Executing
      // again would be a silent replay, so the client has to decide and use a
      // fresh mutationId.
      return fail(
        "MUTATION_EXPIRED",
        "this mutationId has expired; verify the outcome with GET /api/mutation/:id and submit a new mutationId if needed",
      );
    }
    if (reservation.status === "limit") {
      return fail("RATE_LIMITED", "too many pending mutations; finish or wait before retrying");
    }
    if (reservation.status === "completed") {
      const outcome = reservation.entry.outcome;
      if (outcome.ok) {
        return { status: 200, envelope: { ok: true, result: outcome.result, requestId, replayed: true } };
      }
      return {
        status: statusForCode(outcome.error.code),
        envelope: { ok: false, error: outcome.error, requestId, replayed: true },
      };
    }
    if (reservation.status === "in-progress") {
      // Same id, same payload, first attempt still running: wait for its result
      // instead of executing the mutation twice.
      const entry = await reservation.entry.promise;
      const outcome = entry.outcome ?? { ok: false, error: codedError("INTERNAL", "mutation did not settle") };
      if (outcome.ok) {
        return { status: 200, envelope: { ok: true, result: outcome.result, requestId, replayed: true } };
      }
      return {
        status: statusForCode(outcome.error.code),
        envelope: { ok: false, error: outcome.error, requestId, replayed: true },
      };
    }

    const entry = reservation.entry;
    const outcome = await execute();
    mutations.settle(entry, outcome);
    if (outcome.ok) return { status: 200, envelope: { ok: true, result: outcome.result, requestId } };
    return {
      status: statusForCode(outcome.error.code),
      envelope: { ok: false, error: outcome.error, requestId },
    };
  };

  /**
   * Read-only mutation lookup for `GET /api/mutation/:id`.
   *
   * This is the safe way for a reconnecting client to find out whether a
   * mutation landed: it never executes anything, and it distinguishes "the
   * server still knows this id" (`pending`/`done`/`failed`) from "the id is
   * gone" (`unknown`) and "the id was settled and evicted" (`expired`, which is
   * also what a replayed POST would be refused with).
   */
  const queryMutation = ({ deviceId, mutationId }) => {
    if (!isUuid(mutationId)) {
      return {
        status: 400,
        envelope: { ok: false, error: codedError("INVALID_PARAMS", "mutationId must be a UUID") },
      };
    }
    const found = mutations.describe(deviceId, mutationId);
    if (!found.entry) {
      return {
        status: 200,
        envelope: {
          ok: true,
          result: {
            mutationId,
            known: false,
            status: found.expired ? "expired" : "unknown",
          },
        },
      };
    }
    const entry = found.entry;
    const base = { mutationId, operation: entry.operation, known: true };
    if (entry.state === "in-progress") {
      return { status: 200, envelope: { ok: true, result: { ...base, status: "pending" } } };
    }
    const completedAt = new Date(entry.completedAt).toISOString();
    if (entry.outcome?.ok) {
      return {
        status: 200,
        envelope: {
          ok: true,
          result: { ...base, status: "done", result: entry.outcome.result ?? null, completedAt },
        },
      };
    }
    return {
      status: 200,
      envelope: {
        ok: true,
        result: {
          ...base,
          status: "failed",
          error: entry.outcome?.error ?? codedError("INTERNAL", "mutation did not settle"),
          completedAt,
        },
      },
    };
  };

  return {
    handle,
    queryMutation,
    mutations,
    cancel: () => mutations.clear(),
  };
}

module.exports = {
  DEFAULT_MAX_IN_FLIGHT_PER_DEVICE,
  DEFAULT_MAX_MUTATIONS_PER_DEVICE,
  DEFAULT_MUTATION_TTL_MS,
  OPERATION_NAME_PATTERN,
  RESERVED_INPUT_KEYS,
  UUID_PATTERN,
  MutationStore,
  buildOperationTable,
  callAdapter,
  createRpcDispatcher,
  digestFor,
  isOperationName,
  isUuid,
  stableStringify,
  statusForCode,
};
