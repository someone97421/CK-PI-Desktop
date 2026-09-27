import { link, lstat, mkdir, realpath, stat, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const ATTACHMENT_HASH = /^[0-9a-f]{64}$/i;

/** Give an extensionless attachment its media association without copying it. */
export async function openableMp4Path(
  dataDir: string,
  target: string,
  mimeType?: string,
): Promise<string> {
  const hash = basename(target);
  if (!ATTACHMENT_HASH.test(hash) || mimeType?.toLowerCase() !== "video/mp4") {
    return target;
  }
  let attachmentRoot: string;
  try {
    attachmentRoot = await realpath(join(dataDir, "attachments"));
  } catch {
    return target;
  }
  if (dirname(target) !== attachmentRoot) return target;

  const directory = join(dataDir, "openable-attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error("attachment open directory is a symbolic link");
  }
  const alias = join(directory, `${hash.toLowerCase()}.mp4`);
  try {
    if (process.platform === "win32") {
      await link(target, alias);
    } else {
      await symlink(target, alias, "file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const aliasInfo = await lstat(alias, { bigint: true });
    const targetInfo = await stat(target, { bigint: true });
    const sameFile = aliasInfo.isSymbolicLink()
      ? (await realpath(alias)) === target
      : process.platform === "win32" && aliasInfo.isFile() &&
        aliasInfo.ino !== 0n && aliasInfo.ino === targetInfo.ino &&
        aliasInfo.dev === targetInfo.dev;
    if (!sameFile) {
      throw new Error("attachment open path is already occupied");
    }
  }
  return alias;
}
