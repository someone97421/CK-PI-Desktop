"use strict";

/**
 * Attachment staging.
 *
 * The plugin owns one private directory under its plugin data path. Uploads are
 * validated (declared type, magic bytes, extension, size), renamed to a random
 * server-side id, and only ever read back through an authenticated route. A
 * browser never sees a filesystem path, and nothing outside this directory is
 * ever written or deleted.
 */

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { isInsidePath } = require("./http.cjs");

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_DEVICE = 32;
const MAX_NAME_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * Allowed upload types. `magic` names the signature the bytes must carry;
 * `ext` lists the file extensions that may accompany the type. `kind` is the
 * coarse class the host/UI protocol understands: `image` or `file`.
 */
const ALLOWED_TYPES = Object.freeze({
  "image/png": { kind: "image", ext: [".png"], magic: "png", stored: ".png" },
  "image/jpeg": { kind: "image", ext: [".jpg", ".jpeg", ".jpe"], magic: "jpeg", stored: ".jpg" },
  "image/webp": { kind: "image", ext: [".webp"], magic: "webp", stored: ".webp" },
  "image/gif": { kind: "image", ext: [".gif"], magic: "gif", stored: ".gif" },
  "application/pdf": { kind: "file", ext: [".pdf"], magic: "pdf", stored: ".pdf" },
  "text/plain": { kind: "file", ext: [".txt", ".text", ".log", ".csv", ".json", ".md"], magic: null, stored: ".txt" },
  "text/markdown": { kind: "file", ext: [".md", ".markdown", ".txt"], magic: null, stored: ".md" },
  "text/csv": { kind: "file", ext: [".csv"], magic: null, stored: ".csv" },
  "application/json": { kind: "file", ext: [".json"], magic: null, stored: ".json" },
});

/** Vendor spellings browsers actually send. */
const MIME_ALIASES = Object.freeze({
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "text/x-markdown": "text/markdown",
  "text/x-csv": "text/csv",
  "application/csv": "text/csv",
  "application/x-pdf": "application/pdf",
});

function normalizeMimeType(raw) {
  if (typeof raw !== "string") return "";
  const base = raw.split(";")[0].trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

function sniffMagic(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (buffer.length >= 6) {
    const header = buffer.toString("latin1", 0, 6);
    if (header === "GIF87a" || header === "GIF89a") return "gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (buffer.length >= 5 && buffer.toString("latin1", 0, 5) === "%PDF-") {
    return "pdf";
  }
  return null;
}

/**
 * UTF-8 text check over the whole buffer. Slicing a prefix could cut a
 * multi-byte character and refuse an ordinary file, so the size cap that makes
 * this affordable is the upload cap itself (10 MiB).
 */
function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode the `X-Filename` header. The client sends `encodeURIComponent(name)`,
 * so a malformed escape is a client bug rather than a reason to trust the
 * fallback; the name is reduced to a basename and stripped of control chars.
 */
function decodeFilenameHeader(raw) {
  if (typeof raw !== "string" || !raw) return "file";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const base = decoded.split(/[\\/]/).pop() ?? "file";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(-MAX_NAME_LENGTH) : cleaned;
}

function validateSessionId(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return { ok: false, code: "INVALID_PARAMS", message: "X-Session-Id is required" };
  }
  if (!SESSION_ID_PATTERN.test(value)) {
    return { ok: false, code: "INVALID_PARAMS", message: "X-Session-Id is malformed" };
  }
  return { ok: true, sessionId: value };
}

/**
 * Validate one upload against the declared type: the type must be allowed, a
 * present file extension must belong to that type, and image/PDF bytes must
 * carry the expected signature. A mismatch is refused rather than coerced.
 */
function validateUpload({ mimeType, filename, buffer }) {
  const mime = normalizeMimeType(mimeType);
  const rule = ALLOWED_TYPES[mime];
  if (!rule) {
    return { ok: false, code: "UNSUPPORTED", message: `unsupported upload type: ${mime || "unknown"}` };
  }
  const ext = path.extname(filename).toLowerCase();
  if (ext && !rule.ext.includes(ext)) {
    return { ok: false, code: "INVALID_PARAMS", message: `filename extension ${ext} does not match ${mime}` };
  }
  if (rule.magic) {
    const sniffed = sniffMagic(buffer);
    if (sniffed !== rule.magic) {
      return { ok: false, code: "INVALID_PARAMS", message: `file content does not match ${mime}` };
    }
  } else if (!looksLikeText(buffer)) {
    return { ok: false, code: "INVALID_PARAMS", message: `file content does not look like ${mime}` };
  }
  return { ok: true, mimeType: mime, rule };
}

class AttachmentStore {
  constructor({
    dir,
    ttlMs = DEFAULT_TTL_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxPerDevice = MAX_PER_DEVICE,
    now = Date.now,
  } = {}) {
    if (!dir) throw new Error("AttachmentStore requires a directory");
    this.dir = path.resolve(dir);
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxPerDevice = maxPerDevice;
    this.now = now;
    /** attachmentId → metadata (never persisted). */
    this.items = new Map();
    /** deviceId → uploads between quota check and store insert. */
    this.pending = new Map();
    /** Bumped by init/dispose so a save that spans a teardown cannot re-index. */
    this.generation = 0;
    this.active = false;
  }

  current(generation) {
    return this.active && this.generation === generation;
  }

  async init() {
    this.generation += 1;
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await fsp.lstat(this.dir)).isSymbolicLink()) throw new Error("attachment directory must not be a symlink");
    this.dir = await fsp.realpath(this.dir);
    this.active = true;
    this.pending.clear();
    await this.pruneExpired();
  }

  countForDevice(deviceId) {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.deviceId === deviceId) count += 1;
    }
    return count;
  }

  /** Live items plus uploads already past the quota check but not yet stored. */
  reservedForDevice(deviceId) {
    return this.countForDevice(deviceId) + (this.pending.get(deviceId) ?? 0);
  }

  markPending(deviceId, delta) {
    const next = (this.pending.get(deviceId) ?? 0) + delta;
    if (next <= 0) this.pending.delete(deviceId);
    else this.pending.set(deviceId, next);
  }

  /**
   * Store one validated upload. The caller has already read the bytes under the
   * size cap; this re-checks the cap, reserves a quota slot before the first
   * await so concurrent uploads cannot overshoot the device limit, and refuses
   * to file anything once the store has been disposed (`generation` guard).
   */
  async save({ deviceId, sessionId, name, mimeType, buffer, isAuthorized = () => false }) {
    if (!this.active) return { ok: false, code: "NOT_READY", message: "attachment store is not ready" };
    if (!Buffer.isBuffer(buffer)) {
      return { ok: false, code: "INVALID_PARAMS", message: "upload body is required" };
    }
    if (buffer.length === 0) {
      return { ok: false, code: "INVALID_PARAMS", message: "upload body is empty" };
    }
    if (buffer.length > this.maxBytes) {
      return { ok: false, code: "PAYLOAD_TOO_LARGE", message: `upload exceeds ${this.maxBytes} bytes` };
    }
    const session = validateSessionId(sessionId);
    if (!session.ok) return session;
    const filename = decodeFilenameHeader(name);
    const validated = validateUpload({ mimeType, filename, buffer });
    if (!validated.ok) return validated;
    if (this.reservedForDevice(deviceId) >= this.maxPerDevice) {
      return { ok: false, code: "RATE_LIMITED", message: "attachment quota reached for this device" };
    }
    const generation = this.generation;
    this.markPending(deviceId, 1);
    let filePath = null;
    try {
      await this.pruneExpired();
      if (!this.current(generation) || !isAuthorized()) {
        return { ok: false, code: "NOT_READY", message: "attachment store was closed" };
      }
      const id = crypto.randomBytes(16).toString("base64url");
      filePath = path.join(this.dir, `${id}${validated.rule.stored}`);
      if (!isInsidePath(this.dir, filePath)) {
        filePath = null;
        return { ok: false, code: "INTERNAL", message: "attachment path escaped its directory" };
      }
      try {
        await fsp.writeFile(filePath, buffer, { mode: 0o600, flag: "wx" });
      } catch {
        filePath = null;
        return { ok: false, code: "INTERNAL", message: "failed to stage the upload" };
      }
      if (!this.current(generation) || !isAuthorized()) {
        // Disposed while the bytes were being written: nothing may be indexed
        // after teardown, so the file this call created is removed again.
        await this.removeFile({ filePath });
        filePath = null;
        return { ok: false, code: "NOT_READY", message: "attachment store was closed" };
      }
      const item = {
        id,
        deviceId,
        sessionId: session.sessionId,
        name: filename,
        mimeType: validated.mimeType,
        kind: validated.rule.kind,
        size: buffer.length,
        filePath,
        createdAt: this.now(),
        expiresAt: this.now() + this.ttlMs,
      };
      this.items.set(id, item);
      return { ok: true, item: this.publicView(item) };
    } finally {
      this.markPending(deviceId, -1);
    }
  }

  publicView(item) {
    return { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size, kind: item.kind };
  }

  /** Metadata for the authenticated preview route; the caller checks the device. */
  get(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    const item = this.items.get(id);
    if (!item) return null;
    if (this.now() >= item.expiresAt) return null;
    return item;
  }

  /**
   * Resolve `input.attachmentIds` for one RPC call. Only the owning device, and
   * only the session the file was uploaded for, may reference an attachment.
   */
  async resolveForRpc(ids, { deviceId, sessionId }) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: true, items: [] };
    }
    if (ids.length > 8) {
      return { ok: false, code: "INVALID_PARAMS", message: "at most 8 attachments per request" };
    }
    const resolved = [];
    for (const rawId of ids) {
      if (typeof rawId !== "string" || !ID_PATTERN.test(rawId)) {
        return { ok: false, code: "INVALID_PARAMS", message: "attachment id is malformed" };
      }
      const item = this.items.get(rawId);
      if (!item || this.now() >= item.expiresAt) {
        return { ok: false, code: "NOT_FOUND", message: "attachment is unknown or expired" };
      }
      if (item.deviceId !== deviceId) {
        return { ok: false, code: "NOT_FOUND", message: "attachment belongs to another device" };
      }
      if (
        typeof sessionId === "string" &&
        sessionId &&
        item.sessionId &&
        item.sessionId !== sessionId
      ) {
        return { ok: false, code: "NOT_FOUND", message: "attachment belongs to another session" };
      }
      try {
        const stats = await fsp.lstat(item.filePath);
        const real = await fsp.realpath(item.filePath);
        if (!stats.isFile() || stats.isSymbolicLink() || !isInsidePath(this.dir, real) || stats.size !== item.size) throw new Error("invalid staged file");
      } catch {
        this.items.delete(rawId);
        return { ok: false, code: "NOT_FOUND", message: "attachment data is gone" };
      }
      resolved.push(item);
    }
    return { ok: true, items: resolved };
  }

  /** Internal descriptors handed to the adapter; never returned to a browser. */
  toAdapterDescriptors(items) {
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      kind: item.kind,
      sessionId: item.sessionId,
      path: item.filePath,
    }));
  }

  listForDevice(deviceId) {
    return [...this.items.values()]
      .filter((item) => item.deviceId === deviceId)
      .map((item) => this.publicView(item));
  }

  /** Remove one staged file; refuses any path outside the store's own directory. */
  async removeFile(item) {
    const filePath = item?.filePath;
    if (typeof filePath !== "string" || !isInsidePath(this.dir, filePath)) return;
    try {
      await fsp.rm(filePath, { force: true });
    } catch {
      // Best effort: a file already gone is the desired end state.
    }
  }

  async remove(id, deviceId) {
    const item = this.items.get(String(id ?? ""));
    if (!item) return false;
    if (deviceId && item.deviceId !== deviceId) return false;
    this.items.delete(item.id);
    await this.removeFile(item);
    return true;
  }

  async revokeDevice(deviceId) {
    const owned = [...this.items.values()].filter((item) => item.deviceId === deviceId);
    for (const item of owned) {
      this.items.delete(item.id);
      await this.removeFile(item);
    }
    return owned.length;
  }

  async pruneExpired() {
    const current = this.now();
    for (const item of [...this.items.values()]) {
      if (current >= item.expiresAt) {
        this.items.delete(item.id);
        await this.removeFile(item);
      }
    }
  }

  /**
   * Stop-time cleanup. The store is marked inactive first, so an upload still
   * in flight sees `NOT_READY` and deletes the file it wrote; only files this
   * store created are removed, and the directory goes only when empty.
   */
  async dispose() {
    this.active = false;
    this.generation += 1;
    this.pending.clear();
    const owned = [...this.items.values()];
    this.items.clear();
    for (const item of owned) await this.removeFile(item);
    try {
      await fsp.rmdir(this.dir);
    } catch {
      // Non-empty (a stray file) or already gone: leave it alone.
    }
  }
}

module.exports = {
  ALLOWED_TYPES,
  AttachmentStore,
  DEFAULT_MAX_BYTES,
  DEFAULT_TTL_MS,
  ID_PATTERN,
  MAX_PER_DEVICE,
  SESSION_ID_PATTERN,
  decodeFilenameHeader,
  looksLikeText,
  normalizeMimeType,
  sniffMagic,
  validateSessionId,
  validateUpload,
};
