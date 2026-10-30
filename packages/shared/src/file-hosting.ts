import type { FileHostingSettings, LitterboxExpiration } from "./media-input.js";

export const LITTERBOX_EXPIRATIONS = ["1h", "12h", "24h", "72h"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function fileHostingWriteError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!record(value)) return "fileHosting must be an object";
  if (value.litterbox === undefined) return null;
  if (!record(value.litterbox)) return "fileHosting.litterbox must be an object";
  if (value.litterbox.enabled !== undefined && typeof value.litterbox.enabled !== "boolean") {
    return "fileHosting.litterbox.enabled must be a boolean";
  }
  if (value.litterbox.expiration !== undefined &&
      !LITTERBOX_EXPIRATIONS.includes(value.litterbox.expiration as LitterboxExpiration)) {
    return "fileHosting.litterbox.expiration must be 1h, 12h, 24h or 72h";
  }
  return null;
}

export function normalizeFileHostingSettings(value: unknown): FileHostingSettings {
  const litterbox: Record<string, unknown> = record(value) && record(value.litterbox) ? value.litterbox : {};
  return {
    litterbox: {
      enabled: litterbox.enabled === true,
      expiration: LITTERBOX_EXPIRATIONS.includes(litterbox.expiration as LitterboxExpiration)
        ? litterbox.expiration as LitterboxExpiration
        : "24h",
    },
  };
}
