"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isInsidePath } = require("./http.cjs");

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_DEVICE = 32;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function decodeFilenameHeader(raw) {
  let value = typeof raw === "string" ? raw : "";
  try { value = decodeURIComponent(value); } catch {}
  const name = (value.split(/[\\/]/).pop() || "file").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return !name || name === "." || name === ".." ? "file" : name.slice(-200);
}

function normalizeMimeType(raw) {
  return typeof raw === "string" ? raw.split(";")[0].trim().toLowerCase() || "application/octet-stream" : "application/octet-stream";
}

function imageKind(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return true;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("latin1", 0, 6))) return true;
  return buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP";
}

/** 仅暂存 Renderer 上传，宿主完成复制后立即移除。 */
class AttachmentStore {
  constructor({ dir, ttlMs = DEFAULT_TTL_MS, maxBytes = DEFAULT_MAX_BYTES, maxPerDevice = MAX_PER_DEVICE, now = Date.now } = {}) {
    if (!dir) throw new Error("AttachmentStore requires a directory");
    this.dir = path.resolve(dir);
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxPerDevice = maxPerDevice;
    this.now = now;
    this.items = new Map();
    this.pending = new Map();
    this.generation = 0;
    this.active = false;
  }

  async init() {
    this.generation++;
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await fsp.lstat(this.dir)).isSymbolicLink()) throw new Error("upload directory must not be a symlink");
    this.dir = await fsp.realpath(this.dir);
    this.active = true;
    this.pending.clear();
    await this.pruneExpired();
  }

  async save({ deviceId, name, mimeType, buffer, isAuthorized = () => false }) {
    if (!this.active) return { ok: false, code: "NOT_READY", message: "upload store is not ready" };
    if (!Buffer.isBuffer(buffer)) return { ok: false, code: "INVALID_PARAMS", message: "upload body is required" };
    if (buffer.length > this.maxBytes) return { ok: false, code: "PAYLOAD_TOO_LARGE", message: `upload exceeds ${this.maxBytes} bytes` };
    const owned = [...this.items.values()].filter(item => item.deviceId === deviceId).length;
    if (owned + (this.pending.get(deviceId) || 0) >= this.maxPerDevice) return { ok: false, code: "RATE_LIMITED", message: "upload quota reached for this device" };
    const generation = this.generation;
    const current = () => this.active && this.generation === generation && isAuthorized();
    this.pending.set(deviceId, (this.pending.get(deviceId) || 0) + 1);
    let filePath;
    try {
      await this.pruneExpired();
      if (!current()) return { ok: false, code: "NOT_READY", message: "upload store was closed" };
      const id = crypto.randomBytes(16).toString("base64url");
      const filename = decodeFilenameHeader(name);
      filePath = path.join(this.dir, `${id}${path.extname(filename) || ".bin"}`);
      if (!isInsidePath(this.dir, filePath)) throw new Error("upload path escaped its directory");
      try { await fsp.writeFile(filePath, buffer, { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST") await this.removeFile({ filePath });
        throw error;
      }
      if (!current()) {
        await this.removeFile({ filePath });
        return { ok: false, code: "NOT_READY", message: "upload store was closed" };
      }
      const item = { id, deviceId, name: filename, mimeType: normalizeMimeType(mimeType),
        kind: imageKind(buffer) ? "image" : "file", size: buffer.length, filePath, expiresAt: this.now() + this.ttlMs };
      this.items.set(id, item);
      return { ok: true, item: { id } };
    } finally {
      if (this.generation === generation) {
        const pending = (this.pending.get(deviceId) || 0) - 1;
        if (pending > 0) this.pending.set(deviceId, pending);
        else this.pending.delete(deviceId);
      }
    }
  }

  get(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    const item = this.items.get(id);
    return item && this.now() < item.expiresAt ? item : null;
  }

  async removeFile(item) {
    if (typeof item?.filePath !== "string" || !isInsidePath(this.dir, item.filePath)) return;
    await fsp.rm(item.filePath, { force: true }).catch(() => undefined);
  }

  async remove(id, deviceId) {
    const item = this.items.get(id);
    if (!item || (deviceId && item.deviceId !== deviceId)) return false;
    this.items.delete(id);
    await this.removeFile(item);
    return true;
  }

  async revokeDevice(deviceId) {
    for (const item of [...this.items.values()]) if (item.deviceId === deviceId) await this.remove(item.id);
  }

  async pruneExpired() {
    for (const item of [...this.items.values()]) if (this.now() >= item.expiresAt) await this.remove(item.id);
  }

  async dispose() {
    this.active = false;
    this.generation++;
    this.pending.clear();
    const items = [...this.items.values()];
    this.items.clear();
    for (const item of items) await this.removeFile(item);
    await fsp.rmdir(this.dir).catch(() => undefined);
  }
}

module.exports = { AttachmentStore, DEFAULT_MAX_BYTES, DEFAULT_TTL_MS, MAX_PER_DEVICE, decodeFilenameHeader, normalizeMimeType };
