import type { UpdateMode, UpdatePreference } from "@pi-desktop/shared";

export type WindowsDistribution = "installed" | "zip" | "portable";

export function supportsAutomaticUpdates(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isPackaged) return false;
  if (platform === "win32") return true;
  return platform === "linux" && Boolean(env.APPIMAGE);
}

export function resolveDefaultUpdatePreference(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distribution?: WindowsDistribution,
): UpdatePreference {
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  if (
    platform === "win32" &&
    (Boolean(env.PORTABLE_EXECUTABLE_FILE) || distribution === "zip" || distribution === "portable")
  ) {
    return "manual";
  }
  return "automatic";
}

export function resolveStoredUpdatePreference(
  value: unknown,
  fallback: UpdatePreference,
): UpdatePreference {
  return value === "automatic" || value === "manual" ? value : fallback;
}

export function resolveEffectiveUpdatePreference(
  preference: UpdatePreference,
  automaticSupported: boolean,
): UpdatePreference {
  return automaticSupported ? preference : "manual";
}

/**
 * The fourth argument remains compatible with the fork's preference-only API;
 * upstream callers may pass a Windows distribution before the preference.
 */
export function resolveUpdateMode(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  distributionOrPreference?: WindowsDistribution | UpdatePreference,
  preference?: UpdatePreference,
): UpdateMode {
  if (!isPackaged) return "disabled";
  if (!supportsAutomaticUpdates(platform, isPackaged, env)) return "manual";
  const distribution = distributionOrPreference === "installed" ||
    distributionOrPreference === "zip" ||
    distributionOrPreference === "portable"
    ? distributionOrPreference
    : undefined;
  const selectedPreference = preference ?? (
    distributionOrPreference === "automatic" || distributionOrPreference === "manual"
      ? distributionOrPreference
      : undefined
  );
  const selected = selectedPreference ?? resolveDefaultUpdatePreference(
    platform,
    isPackaged,
    env,
    distribution,
  );
  return selected === "automatic" ? "in-app" : "manual";
}
