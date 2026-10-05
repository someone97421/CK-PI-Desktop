import type { ExternalMcpCandidate } from "../../../lib/api";

/** Keep inline URL credentials, paths, and query values out of candidate rows. */
export function externalMcpDisplayMeta(candidate: ExternalMcpCandidate): string {
  if (candidate.description) return candidate.description;
  if (candidate.command) return candidate.command;
  if (candidate.url) {
    try {
      const host = new URL(candidate.url).host;
      if (host) return host;
    } catch {
      // An unparseable source URL is not shown; use the config path instead.
    }
  }
  return candidate.sourcePath;
}
