"use strict";

/** 枚举设置面板可展示的局域网直连地址。 */

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

function listenerAddresses() {
  const addresses = listLanAddresses();
  return [...addresses, { address: "127.0.0.1", label: "本机", recommended: addresses.length === 0 }];
}

module.exports = { listenerAddresses };
