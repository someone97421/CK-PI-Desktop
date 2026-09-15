#!/usr/bin/env node
/**
 * Electron ships its runtime binary from a `postinstall` script, but pnpm
 * decides whether to run dependency build scripts from the lockfile's
 * `requiresBuild` flag. This repository's lockfile carries no such flag, so
 * pnpm never runs it, `pnpm rebuild electron` is a no-op, and
 * `electron-vite dev` fails with "Electron uninstall".
 *
 * This script restores the binary deterministically by running the same
 * install script Electron ships. Idempotent: exits immediately once dist/ is
 * present. The download honors `electron_mirror` from .npmrc / ELECTRON_MIRROR.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "apps", "desktop", "package.json"));

let packageJsonPath;
try {
  packageJsonPath = require.resolve("electron/package.json");
} catch {
  console.error(
    "[ensure-electron] The electron package is not installed. Run `pnpm install` first.",
  );
  process.exit(1);
}

const packageDir = dirname(packageJsonPath);
const distDir = join(packageDir, "dist");
if (existsSync(distDir)) process.exit(0);

console.log("[ensure-electron] Electron runtime binary is missing; downloading ...");
execFileSync(process.execPath, [join(packageDir, "install.js")], {
  cwd: packageDir,
  env: process.env,
  stdio: "inherit",
});

if (!existsSync(distDir)) {
  console.error("[ensure-electron] Download finished but dist/ is still missing.");
  process.exit(1);
}
console.log("[ensure-electron] Electron runtime binary is ready.");
