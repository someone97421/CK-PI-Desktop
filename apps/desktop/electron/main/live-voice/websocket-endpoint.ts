/**
 * Scheme rules for Live WebSocket endpoints, kept free of Electron so they can
 * be tested directly.
 *
 * A user-supplied endpoint (an OpenAI Realtime Provider base URL) follows the
 * desktop network policy (ADR 0304): plain `ws` is accepted here and the public
 * network guard decides, from `networkPolicy.mode`, whether the plaintext hop
 * and its address are allowed. Every third-party endpoint keeps `wss` only.
 */

export type LiveEndpointOrigin = "user" | "third-party";

function liveEndpointError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * Build the Realtime WebSocket URL from a Provider base URL: `https` maps to
 * `wss`, `http` maps to `ws`. The scheme is only syntax here; whether `ws` may
 * be dialed is decided by the transport's network guard.
 */
export function realtimeSocketUrl(baseUrl: string, modelId: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw liveEndpointError("Realtime Provider URL is invalid", "LIVE_PROTOCOL_UNSUPPORTED");
  }
  if (
    (base.protocol !== "https:" && base.protocol !== "http:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw liveEndpointError(
      "Realtime Provider must use an HTTP(S) base URL without credentials or query parameters",
      "LIVE_PROTOCOL_UNSUPPORTED",
    );
  }
  let path = base.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/realtime")) path = `${path}/realtime`;
  base.pathname = path;
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.search = "";
  base.searchParams.set("model", modelId);
  base.hash = "";
  return base.toString();
}

/**
 * The HTTP(S) URL the network guard judges for a Live WebSocket URL. Plain
 * `ws` is only ever accepted for a user-supplied endpoint.
 */
export function liveSocketGuardUrl(url: string, origin: LiveEndpointOrigin): string {
  const parsed = new URL(url);
  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
    return parsed.toString();
  }
  if (parsed.protocol === "ws:" && origin === "user") {
    parsed.protocol = "http:";
    return parsed.toString();
  }
  throw liveEndpointError("Live WebSocket endpoints must use TLS", "LIVE_NETWORK_POLICY_UNSUPPORTED");
}
