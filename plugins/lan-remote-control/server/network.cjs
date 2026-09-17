"use strict";

/**
 * LAN interface selection.
 *
 * The remote-control server binds exactly one private IPv4 address; 0.0.0.0
 * (or ::) would put the panel on every interface the machine happens to have,
 * including public ones, so the choice is always explicit and re-validated.
 */

const os = require("node:os");

/** Interface names that usually belong to virtual adapters, not the LAN. */
const VIRTUAL_NAME_PATTERN =
  /(virtual|vmware|vbox|virtualbox|hyper-v|vethernet|docker|wsl|tailscale|zerotier|hamachi|radmin|loopback|npcap|tap|tun|bluetooth)/i;

function parseIPv4(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  const parts = trimmed.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function isLoopbackIPv4(value) {
  const parts = parseIPv4(value);
  if (!parts) return false;
  return parts[0] === 127;
}

/** RFC1918, link-local (169.254/16) and CGNAT (100.64/10): LAN-reachable at best. */
function isPrivateIPv4(value) {
  const parts = parseIPv4(value);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Loopback is accepted for development only; it is not a phone-reachable address. */
function isAllowedBindAddress(value) {
  return isPrivateIPv4(value) || isLoopbackIPv4(value);
}

/**
 * Candidate addresses for the panel, best first. `recommended` favours a real
 * private range on a physical-looking adapter over link-local or virtual ones.
 */
function listLanAddresses() {
  const interfaces = os.networkInterfaces();
  const seen = new Set();
  const entries = [];
  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    for (const info of addresses ?? []) {
      if (!info || info.internal) continue;
      const family = typeof info.family === "string" ? info.family : String(info.family);
      if (family !== "IPv4" && family !== "4") continue;
      const address = String(info.address ?? "");
      if (!isPrivateIPv4(address)) continue;
      if (seen.has(address)) continue;
      seen.add(address);
      const parts = parseIPv4(address);
      const linkLocal = Boolean(parts && parts[0] === 169 && parts[1] === 254);
      const virtual = VIRTUAL_NAME_PATTERN.test(name);
      const score = (linkLocal ? 0 : 2) + (virtual ? 0 : 1);
      entries.push({
        address,
        label: String(name),
        virtual,
        linkLocal,
        score,
      });
    }
  }
  entries.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.address.localeCompare(right.address);
  });
  return entries.map((entry, index) => ({
    address: entry.address,
    label: entry.label,
    recommended: index === 0,
    linkLocal: entry.linkLocal,
  }));
}

function pickDefaultAddress(entries = listLanAddresses()) {
  return entries.length ? entries[0].address : null;
}

/**
 * Validate an explicitly requested bind address. An empty value means "choose
 * the best LAN interface", which the caller resolves with `pickDefaultAddress`.
 */
function normalizeRequestedAddress(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, address: null };
  }
  if (typeof value !== "string") {
    return { ok: false, code: "INVALID_PARAMS", message: "address must be a string" };
  }
  const address = value.trim();
  if (!address) return { ok: true, address: null };
  if (!parseIPv4(address)) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "address must be an IPv4 literal such as 192.168.1.5",
    };
  }
  if (!isAllowedBindAddress(address)) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `address must be a private or loopback IPv4 address: ${address}`,
    };
  }
  const local = listLanAddresses().some((entry) => entry.address === address);
  if (!local && !isLoopbackIPv4(address)) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `address is not assigned to this machine: ${address}`,
    };
  }
  return { ok: true, address };
}

module.exports = {
  parseIPv4,
  isLoopbackIPv4,
  isPrivateIPv4,
  isAllowedBindAddress,
  listLanAddresses,
  pickDefaultAddress,
  normalizeRequestedAddress,
};
