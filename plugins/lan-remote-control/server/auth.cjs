"use strict";

// 主机密码只保存 scrypt 校验值；设备只保存随机令牌的 SHA-256，原文仅返回给登录设备。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const derive = promisify(crypto.scrypt);
const MAX_DEVICES = 16;
const MAX_DEVICE_NAME_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const tokenHash = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest();
const newToken = () => crypto.randomBytes(32).toString("base64url");
const hashEquals = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);
function normalizeDeviceName(value) {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DEVICE_NAME_LENGTH) : "";
  return name ? { ok: true, name } : { ok: false, code: "INVALID_PARAMS", message: "请填写设备名称" };
}

class DeviceStore {
  constructor({ file, maxDevices = MAX_DEVICES, now = Date.now } = {}) {
    this.file = file;
    this.maxDevices = maxDevices;
    this.now = now;
    this.devices = new Map();
    this.password = null;
    this.revision = 0;
    if (file && fs.existsSync(file)) {
      // 损坏或未知版本不自动覆盖，避免错误地重置访问控制。
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved.version !== 1 || !saved.password || !/^[a-f0-9]{32}$/.test(saved.password.salt) || !/^[a-f0-9]{64}$/.test(saved.password.hash) || !Array.isArray(saved.devices)) {
        throw new Error("远程认证数据无法读取，请检查插件数据目录");
      }
      this.password = saved.password;
      for (const item of saved.devices) {
        if (typeof item.id !== "string" || !normalizeDeviceName(item.name).ok || !/^[a-f0-9]{64}$/.test(item.tokenHash) || !Number.isFinite(item.expiresAt) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.lastSeenAt)) throw new Error("远程设备记录无效");
        if (item.expiresAt > now()) this.devices.set(item.id, { ...item, tokenHash: Buffer.from(item.tokenHash, "hex") });
      }
    }
  }
  get passwordConfigured() { return !!this.password; }
  get size() { return this.devices.size; }
  persist() {
    if (!this.file || !this.password) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, password: this.password,
        devices: [...this.devices.values()].map((d) => ({ ...d, tokenHash: d.tokenHash.toString("hex") })) }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  async setPassword(password) {
    if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 256) {
      throw Object.assign(new Error("密码须为 8 个字符以上，且不超过 256 字节"), { code: "INVALID_PARAMS" });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await derive(password, salt, 32)).toString("hex");
    const oldPassword = this.password, oldDevices = this.devices;
    this.password = { salt, hash };
    this.devices = new Map();
    try { this.persist(); }
    catch (error) { this.password = oldPassword; this.devices = oldDevices; throw error; }
    this.revision++;
    return [...oldDevices.keys()];
  }
  async verify(password) {
    const current = this.password;
    if (!current || typeof password !== "string" || Buffer.byteLength(password, "utf8") > 256) return false;
    const result = await derive(password, current.salt, 32);
    return current === this.password && hashEquals(result, Buffer.from(current.hash, "hex"));
  }
  add({ name, userAgent, remoteAddress } = {}) {
    const normalized = normalizeDeviceName(name);
    if (!normalized.ok) return normalized;
    for (const [id, device] of this.devices) if (device.expiresAt <= this.now()) this.devices.delete(id);
    if (this.devices.size >= this.maxDevices) return { ok: false, code: "RATE_LIMITED", message: "已登录设备达到上限，请在电脑端移除旧设备" };
    const token = newToken();
    const device = { id: crypto.randomUUID(), name: normalized.name, tokenHash: tokenHash(token),
      createdAt: this.now(), lastSeenAt: this.now(), expiresAt: this.now() + SESSION_TTL_MS,
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 256) : "",
      remoteAddress: typeof remoteAddress === "string" ? remoteAddress : "" };
    this.devices.set(device.id, device);
    try { this.persist(); } catch (error) { this.devices.delete(device.id); throw error; }
    return { ok: true, device, token };
  }
  authorize(token) {
    if (typeof token !== "string" || !token || token.length > 256) return null;
    const candidate = tokenHash(token);
    let matched = null;
    for (const device of this.devices.values()) if (device.expiresAt > this.now() && hashEquals(device.tokenHash, candidate)) matched = device;
    if (matched && this.now() - matched.lastSeenAt > 30_000) {
      matched.lastSeenAt = this.now();
      this.persist();
    }
    return matched;
  }
  get(id) { const device = this.devices.get(String(id)); return device?.expiresAt > this.now() ? device : null; }
  list() {
    return [...this.devices.values()].filter((d) => d.expiresAt > this.now()).map((d) => ({
      deviceId: d.id, name: d.name, remoteAddress: d.remoteAddress,
      createdAt: new Date(d.createdAt).toISOString(), lastSeenAt: new Date(d.lastSeenAt).toISOString(), expiresAt: new Date(d.expiresAt).toISOString(),
    }));
  }
  revoke(id) {
    const previous = this.devices.get(String(id));
    if (!previous) return false;
    this.devices.delete(String(id));
    try { this.persist(); } catch (error) { this.devices.set(previous.id, previous); throw error; }
    return true;
  }
  revokeAll() {
    const previous = this.devices;
    this.devices = new Map();
    try { this.persist(); } catch (error) { this.devices = previous; throw error; }
    this.revision++;
    return previous.size;
  }
}
module.exports = { DeviceStore, MAX_DEVICES, MAX_DEVICE_NAME_LENGTH, SESSION_TTL_MS, normalizeDeviceName, newToken, tokenHash, hashEquals };
