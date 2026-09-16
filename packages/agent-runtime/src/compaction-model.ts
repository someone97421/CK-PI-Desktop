/** Select a compaction model using configured capabilities, not the current message mix. */
import { OAUTH_AUTH_KIND } from "@pi-desktop/shared";
import { providerHeadersEqual } from "./provider-headers.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import type { ModelConfig } from "./thinking-level.js";

type ModelMetadata = Pick<ModelConfig, "contextWindow" | "modalities" | "input">;

/** Use effective settings, including explicit overrides for custom models. */
export function configuredContextWindow(config?: ModelMetadata | null): number | undefined {
  const window = config?.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window > 0
    ? window
    : undefined;
}

/** Include the full modality list (PDF/audio/etc.) as well as the adapter subset. */
export function declaredInputModalities(config?: ModelMetadata | null): Set<string> | undefined {
  if (!config) return undefined;
  const declared = [...(config.modalities?.input ?? []), ...(config.input ?? [])];
  return declared.length > 0 ? new Set(declared) : undefined;
}

/** A 256k model cannot summarize a 1M session, even if its current history is small. */
export function compactionModelCompatible(
  session: Pick<RuntimeProviderConfig, "modelConfig">,
  candidate: Pick<RuntimeProviderConfig, "modelConfig">,
): boolean {
  const sessionWindow = configuredContextWindow(session.modelConfig);
  const candidateWindow = configuredContextWindow(candidate.modelConfig);
  if (sessionWindow === undefined || candidateWindow === undefined) return false;
  if (candidateWindow < sessionWindow) return false;
  const sessionInput = declaredInputModalities(session.modelConfig);
  const candidateInput = declaredInputModalities(candidate.modelConfig);
  if (!sessionInput || !candidateInput) return false;
  for (const modality of sessionInput) {
    if (!candidateInput.has(modality)) return false;
  }
  return true;
}

export function compactionProviderAvailable(provider?: RuntimeProviderConfig | null): boolean {
  if (!provider?.modelId || provider.extensionAgentKey) return false;
  return Boolean(provider.apiKey) || provider.authKind === "none" ||
    (provider.authKind === OAUTH_AUTH_KIND && typeof provider.resolveAuth === "function");
}

/** Undefined preserves the main model's existing summary request behavior. */
export function resolveCompactionProvider(
  session: RuntimeProviderConfig,
  candidate?: RuntimeProviderConfig,
): RuntimeProviderConfig | undefined {
  // Extension agents own their transport and real model outside this binding.
  if (session.extensionAgentKey) return undefined;
  if (!candidate || !compactionProviderAvailable(candidate)) return undefined;
  if (candidate.id === session.id && candidate.modelId === session.modelId) return undefined;
  return compactionModelCompatible(session, candidate) ? candidate : undefined;
}

/** Changes to the selected provider must rebuild its request binding on the next launch. */
export function compactionProvidersEqual(
  left?: RuntimeProviderConfig,
  right?: RuntimeProviderConfig,
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.id === right.id &&
    left.modelId === right.modelId &&
    (left.vendorKey ?? "") === (right.vendorKey ?? "") &&
    (left.baseUrl ?? "") === (right.baseUrl ?? "") &&
    left.apiKey === right.apiKey &&
    (left.authKind ?? "") === (right.authKind ?? "") &&
    (left.apiStyle ?? "") === (right.apiStyle ?? "") &&
    providerHeadersEqual(left.headers, right.headers) &&
    left.supportsReasoning === right.supportsReasoning &&
    [...left.supportedThinkingLevels].sort().join(",") === [...right.supportedThinkingLevels].sort().join(",") &&
    JSON.stringify(left.modelConfig ?? null) === JSON.stringify(right.modelConfig ?? null)
  );
}
