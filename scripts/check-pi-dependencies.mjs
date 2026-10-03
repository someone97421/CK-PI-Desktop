import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetVersion = "1.0.0";

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertPin(manifestPath, section, packageName) {
  const manifest = readJson(manifestPath);
  const value = manifest[section]?.[packageName];
  if (value !== targetVersion) {
    throw new Error(`${manifestPath} ${section}.${packageName} must be exactly ${targetVersion}; found ${value ?? "missing"}`);
  }
}

function assertInstalled(packagePath, expectedName, { patched = false } = {}) {
  const link = join(root, packagePath);
  if (!existsSync(link)) throw new Error(`Install dependencies before this check; missing ${packagePath}`);
  const resolved = realpathSync(link);
  const manifest = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8"));
  if (manifest.name !== expectedName || manifest.version !== targetVersion) {
    throw new Error(`${packagePath} resolves to ${manifest.name}@${manifest.version}, expected ${expectedName}@${targetVersion}`);
  }
  if (patched && !resolved.includes("patch_hash=")) {
    throw new Error(`${packagePath} does not resolve to pnpm's patched package instance`);
  }
}

for (const packageName of [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]) {
  assertPin("packages/agent-runtime/package.json", "dependencies", packageName);
  assertInstalled(`packages/agent-runtime/node_modules/${packageName}`, packageName, { patched: true });
}
for (const packageName of ["@earendil-works/pi-ai", "@earendil-works/pi-mcp"]) {
  assertPin("apps/desktop/package.json", "devDependencies", packageName);
  assertInstalled(`apps/desktop/node_modules/${packageName}`, packageName, {
    patched: packageName === "@earendil-works/pi-ai",
  });
}

const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
for (const packageName of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-mcp"]) {
  if (new RegExp(`@earendil-works/${packageName}@0\\.99\\.1(?:[(:]|$)`).test(lockfile)) {
    throw new Error(`pnpm-lock.yaml still contains @earendil-works/${packageName}@0.99.1`);
  }
}
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const releaseAgeExclusions = workspace.match(
  /^minimumReleaseAgeExclude:[ \t]*([\s\S]*?)(?=^[A-Za-z][\w-]*:|\s*$)/m,
)?.[1] ?? "";
if (/@earendil-works\/(?:chord|pi-agent-core|pi-ai|pi-telemetry|pi-coding-agent|pi-codemode|pi-mcp|pi-tui)@/.test(releaseAgeExclusions)) {
  throw new Error("Remove the obsolete Pi-specific minimumReleaseAgeExclude entries");
}

process.stdout.write("Pi direct pins and installed package instances are aligned at 1.0.0.\n");
