import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * pnpm copies the lockfile it actually installed from into the virtual
 * store, next to the store entries it describes.
 */
export const VIRTUAL_STORE_LOCKFILE = join("node_modules", ".pnpm", "lock.yaml");

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the patch hashes pnpm recorded for `name@version` in a lockfile.
 *
 * Every patched snapshot is keyed `'name@version(patch_hash=<hex>)...`
 * (single-quoted for scoped names, bare otherwise), so the snapshot keys
 * carry the full hash even when the matching `.pnpm` directory name has
 * been shortened.
 */
export function patchHashesIn(lockText, name, version) {
  const snapshotKey = new RegExp(
    `'?${escapeForRegExp(name)}@${escapeForRegExp(version)}\\(patch_hash=([a-f0-9]+)\\)`,
    "g",
  );
  return [...new Set([...lockText.matchAll(snapshotKey)].map((match) => match[1]))].sort();
}

/**
 * Patch hashes of the instances pnpm actually installed, read from the
 * virtual store's own lockfile.
 */
export function installedPatchHashes(root, name, version) {
  return patchHashesIn(readFileSync(join(root, VIRTUAL_STORE_LOCKFILE), "utf8"), name, version);
}