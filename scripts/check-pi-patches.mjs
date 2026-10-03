import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  {
    name: "@earendil-works/pi-agent-core",
    patch: "patches/@earendil-works__pi-agent-core@1.0.0.patch",
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-agent-core",
    markers: ["hosted_search_update", "localRequestErrorDetails"],
  },
  {
    name: "@earendil-works/pi-ai",
    patch: "patches/@earendil-works__pi-ai@1.0.0.patch",
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-ai",
    markers: ["hostedSearch", "withLocalRequestErrors", "AnthropicOAuthTokenError", "Retry-After"],
  },
  {
    name: "@earendil-works/pi-coding-agent",
    patch: "patches/@earendil-works__pi-coding-agent@1.0.0.patch",
    packagePath: "packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent",
    markers: ["hostedSearchReplayProjection", "estimateProjectedContextTokens"],
  },
];
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");

for (const entry of entries) {
  if (!existsSync(join(root, entry.patch))) throw new Error(`Missing patch: ${entry.patch}`);
  const patchText = readFileSync(join(root, entry.patch), "utf8");
  if (/diff --git a\/[^\n]*package-lock\.json/.test(patchText)) {
    throw new Error(`${entry.patch} must not change unrelated upstream package-lock.json files`);
  }
  for (const marker of entry.markers) {
    if (!patchText.includes(marker)) throw new Error(`${entry.patch} is missing audited behavior marker ${marker}`);
  }
  const workspaceMapping = `'${entry.name}@1.0.0': ${entry.patch}`;
  if (!workspace.includes(workspaceMapping)) throw new Error(`pnpm-workspace.yaml does not map ${entry.name} to ${entry.patch}`);
  const packagePath = join(root, entry.packagePath);
  const resolved = realpathSync(packagePath);
  const patchHash = resolved.match(/patch_hash=([a-f0-9]+)/)?.[1];
  if (!patchHash || !lockfile.includes(`${entry.name}@1.0.0(patch_hash=${patchHash}`)) {
    throw new Error(`${entry.name}@1.0.0 installed patch hash is absent from pnpm-lock.yaml`);
  }
}

const piAiPatch = readFileSync(join(root, entries[1].patch), "utf8");
for (const declarationPath of [
  "dist/index.d.ts",
  "dist/types.d.ts",
  "dist/utils/assistant-message-frame.d.ts",
  "dist/utils/estimate.d.ts",
  "dist/utils/hosted-search.d.ts",
  "dist/utils/local-request-error.d.ts",
  "dist/utils/local-request-stream.d.ts",
]) {
  if (!piAiPatch.includes(`diff --git a/${declarationPath} `)) {
    throw new Error(`Pi AI patch is missing the audited declaration file ${declarationPath}`);
  }
}

const codingAgentPatch = readFileSync(join(root, entries[2].patch), "utf8");
if (!codingAgentPatch.includes("+export declare function estimateProjectedContextTokens(")) {
  throw new Error("Pi coding-agent runtime estimator declaration is missing from its patch");
}

process.stdout.write("All three Pi 1.0.0 patches are mapped, locked, installed, and contain the audited contracts.\n");
