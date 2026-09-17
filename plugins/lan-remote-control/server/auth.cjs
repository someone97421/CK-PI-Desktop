"use strict";

/**
 * Pairing and device authorization, in memory only.
 *
 * Nothing here is persisted: the plan requires that stopping the plugin, the
 * app exiting or the service being disabled invalidates every phone. A device
 * token is a 256-bit random value whose sha256 is what stays in this module;
 * the raw token exists only in the approve → first-status-poll handoff.
 */

const crypto = require("node:crypto");

const DEFAULT_PAIR_TTL_MS = 120_000;
const MIN_PAIR_TTL_MS = 30_000;
const MAX_PAIR_TTL_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
/** How long an approved ticket may still be picked up by the phone. */
const CLAIM_WINDOW_MS = 5 * 60_000;
const MAX_PENDING_REQUESTS = 16;
const MAX_DEVICES = 16;
const MAX_DEVICE_NAME_LENGTH = 64;
const LAST_SEEN_THROTTLE_MS = 30_000;

/** Strip control characters and path-ish noise from a self-reported device name. */
function normalizeDeviceName(value) {
  const raw = typeof value === "string" ? value : "";
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return { ok: false, code: "INVALID_PARAMS", message: "name is required" };
  if (cleaned.length > MAX_DEVICE_NAME_LENGTH) {
    return { ok: true, name: cleaned.slice(0, MAX_DEVICE_NAME_LENGTH) };
  }
  return { ok: true, name: cleaned };
}

function clampTtl(ttlMs) {
  const value = Number(ttlMs);
  if (!Number.isFinite(value)) return DEFAULT_PAIR_TTL_MS;
  return Math.min(MAX_PAIR_TTL_MS, Math.max(MIN_PAIR_TTL_MS, Math.trunc(value)));
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest();
}

/** Constant-time compare that tolerates length mismatch without throwing. */
function hashEquals(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return false;
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

class PairingStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** One-time pairing tokens handed out by the local panel: token → entry. */
    this.offers = new Map();
    /** requestId → request record. */
    this.requests = new Map();
    /** ticket → requestId. */
    this.tickets = new Map();
    /** Devices whose claim window closed before the phone picked up the token. */
    this.orphanDeviceIds = [];
  }

  /** Drop expired offers/requests; report devices that never collected a token. */
  prune() {
    const current = this.now();
    for (const [token, offer] of this.offers) {
      if (current >= offer.expiresAt) this.offers.delete(token);
    }
    for (const [requestId, request] of this.requests) {
      if (request.status === "pending" && current >= request.expiresAt) {
        request.status = "expired";
      }
      if (
        request.status === "approved" &&
        !request.claimed &&
        request.claimExpiresAt !== null &&
        current >= request.claimExpiresAt
      ) {
        request.status = "expired";
        if (request.deviceId) this.orphanDeviceIds.push(request.deviceId);
        request.deviceId = null;
        request.deviceToken = null;
      }
      const settled = request.status === "expired" || request.status === "rejected";
      if (settled && current - request.settledAt > CLAIM_WINDOW_MS) {
        this.requests.delete(requestId);
        this.tickets.delete(request.ticket);
      }
    }
    return { orphanDeviceIds: [...this.orphanDeviceIds] };
  }

  takeOrphanDevices() {
    this.prune();
    return this.orphanDeviceIds.splice(0);
  }

  /** Local panel asked for a QR payload; the raw token never leaves memory. */
  createOffer({ ttlMs } = {}) {
    this.prune();
    const ttl = clampTtl(ttlMs);
    const token = newToken();
    this.offers.clear();
    this.offers.set(token, { createdAt: this.now(), expiresAt: this.now() + ttl, ttlMs: ttl });
    return { token, expiresAt: this.now() + ttl, ttlMs: ttl };
  }

  get activeOffer() {
    this.prune();
    for (const offer of this.offers.values()) {
      return { expiresAt: offer.expiresAt };
    }
    return null;
  }

  /** Phone exchanged the fragment token for a pending request. */
  consumeOffer(token, { name, remoteAddress } = {}) {
    this.prune();
    const offer = this.offers.get(String(token ?? ""));
    if (!offer) {
      return { ok: false, code: "INVALID_PARAMS", message: "pairing code is unknown or expired" };
    }
    // One-time: consumed whether or not the rest of this call succeeds.
    this.offers.delete(String(token));
    if (this.now() >= offer.expiresAt) {
      return { ok: false, code: "INVALID_PARAMS", message: "pairing code is unknown or expired" };
    }
    const normalized = normalizeDeviceName(name);
    if (!normalized.ok) return normalized;

    const pending = [...this.requests.values()].filter((request) => request.status === "pending").length;
    if (pending >= MAX_PENDING_REQUESTS) {
      return { ok: false, code: "RATE_LIMITED", message: "too many pending pairing requests" };
    }

    const requestId = crypto.randomUUID();
    const ticket = crypto.randomBytes(24).toString("base64url");
    const request = {
      requestId,
      ticket,
      name: normalized.name,
      remoteAddress: typeof remoteAddress === "string" ? remoteAddress : "",
      status: "pending",
      createdAt: this.now(),
      expiresAt: this.now() + offer.ttlMs,
      settledAt: this.now(),
      approvedAt: null,
      claimExpiresAt: null,
      claimed: false,
      deviceId: null,
      deviceName: null,
      deviceToken: null,
    };
    this.requests.set(requestId, request);
    this.tickets.set(ticket, requestId);
    return {
      ok: true,
      request,
      ticket,
      expiresAt: new Date(request.expiresAt).toISOString(),
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    };
  }

  get(requestId) {
    return this.requests.get(String(requestId ?? "")) ?? null;
  }

  listPending() {
    this.prune();
    return [...this.requests.values()]
      .filter((request) => request.status === "pending")
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((request) => ({
        requestId: request.requestId,
        name: request.name,
        createdAt: new Date(request.createdAt).toISOString(),
        expiresAt: new Date(request.expiresAt).toISOString(),
        remoteAddress: request.remoteAddress,
      }));
  }

  /** Local panel only: attach the freshly minted device to the request. */
  approve(requestId, { deviceId, deviceName, deviceToken }) {
    this.prune();
    const request = this.requests.get(String(requestId ?? ""));
    if (!request) return { ok: false, code: "NOT_FOUND", message: "pairing request not found" };
    if (request.status !== "pending") {
      return { ok: false, code: "CONFLICT", message: `pairing request is ${request.status}` };
    }
    if (this.now() >= request.expiresAt) {
      request.status = "expired";
      request.settledAt = this.now();
      return { ok: false, code: "NOT_FOUND", message: "pairing request expired" };
    }
    request.status = "approved";
    request.settledAt = this.now();
    request.approvedAt = this.now();
    request.claimExpiresAt = this.now() + CLAIM_WINDOW_MS;
    request.deviceId = deviceId;
    request.deviceName = deviceName;
    request.deviceToken = deviceToken;
    return { ok: true, request };
  }

  reject(requestId) {
    this.prune();
    const request = this.requests.get(String(requestId ?? ""));
    if (!request) return { ok: false, code: "NOT_FOUND", message: "pairing request not found" };
    if (request.status !== "pending") {
      return { ok: false, code: "CONFLICT", message: `pairing request is ${request.status}` };
    }
    request.status = "rejected";
    request.settledAt = this.now();
    return { ok: true, request };
  }

  /**
   * Ticket poll. The device token is released exactly once; a second poll of an
   * approved ticket reports `expired` so a leaked ticket is worth nothing.
   */
  status(ticket) {
    this.prune();
    const requestId = this.tickets.get(String(ticket ?? ""));
    if (!requestId) return { ok: false, code: "NOT_FOUND", message: "unknown pairing ticket" };
    const request = this.requests.get(requestId);
    if (!request) return { ok: false, code: "NOT_FOUND", message: "unknown pairing ticket" };
    if (request.status === "pending" && this.now() >= request.expiresAt) {
      request.status = "expired";
      request.settledAt = this.now();
    }
    if (request.status === "approved") {
      if (request.claimed || !request.deviceToken) {
        return { ok: true, result: { status: "expired" } };
      }
      if (request.claimExpiresAt !== null && this.now() >= request.claimExpiresAt) {
        request.status = "expired";
        request.settledAt = this.now();
        if (request.deviceId) this.orphanDeviceIds.push(request.deviceId);
        request.deviceId = null;
        request.deviceToken = null;
        return { ok: true, result: { status: "expired" } };
      }
      request.claimed = true;
      const token = request.deviceToken;
      request.deviceToken = null;
      this.tickets.delete(String(ticket));
      this.requests.delete(requestId);
      return {
        ok: true,
        result: {
          status: "approved",
          token,
          deviceId: request.deviceId,
          deviceName: request.deviceName,
        },
      };
    }
    return { ok: true, result: { status: request.status } };
  }

  clear() {
    this.offers.clear();
    this.requests.clear();
    this.tickets.clear();
    this.orphanDeviceIds = [];
  }
}

class DeviceStore {
  constructor({ maxDevices = MAX_DEVICES, now = Date.now } = {}) {
    this.maxDevices = maxDevices;
    this.now = now;
    /** deviceId → device record. */
    this.devices = new Map();
  }

  get size() {
    return this.devices.size;
  }

  add({ name, userAgent } = {}) {
    const normalized = normalizeDeviceName(name);
    if (!normalized.ok) return normalized;
    if (this.devices.size >= this.maxDevices) {
      return { ok: false, code: "RATE_LIMITED", message: "device limit reached" };
    }
    const token = newToken();
    const device = {
      id: crypto.randomUUID(),
      name: normalized.name,
      tokenHash: tokenHash(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      userAgent: typeof userAgent === "string" ? userAgent.slice(0, 256) : "",
    };
    this.devices.set(device.id, device);
    // The raw token is returned once and never stored.
    return { ok: true, device, token };
  }

  /**
   * Bearer token → device. Every device is compared so the work does not leak
   * which entry matched; the set is capped at 16, so this stays cheap.
   */
  authorize(token) {
    if (typeof token !== "string" || !token || token.length > 256) return null;
    const candidate = tokenHash(token);
    let matched = null;
    for (const device of this.devices.values()) {
      if (hashEquals(device.tokenHash, candidate)) matched = device;
    }
    if (!matched) return null;
    if (this.now() - matched.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
      matched.lastSeenAt = this.now();
    }
    return matched;
  }

  get(deviceId) {
    return this.devices.get(String(deviceId ?? "")) ?? null;
  }

  list() {
    return [...this.devices.values()].map((device) => ({
      deviceId: device.id,
      name: device.name,
      createdAt: new Date(device.createdAt).toISOString(),
      lastSeenAt: new Date(device.lastSeenAt).toISOString(),
    }));
  }

  revoke(deviceId) {
    return this.devices.delete(String(deviceId ?? ""));
  }

  revokeAll() {
    const count = this.devices.size;
    this.devices.clear();
    return count;
  }

  clear() {
    this.devices.clear();
  }
}

module.exports = {
  CLAIM_WINDOW_MS,
  DEFAULT_PAIR_TTL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_DEVICES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_PAIR_TTL_MS,
  MIN_PAIR_TTL_MS,
  DeviceStore,
  PairingStore,
  clampTtl,
  hashEquals,
  newToken,
  normalizeDeviceName,
  tokenHash,
};
