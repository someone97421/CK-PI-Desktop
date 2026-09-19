import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function isChild(root, target) {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// 只清理指定产物目录的直属条目；保留项必须已经存在，拒绝沿符号链接清理。
export async function retainArtifacts(directory, retainedPaths, matches) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`产物目录不能是符号链接：${root}`);
  const realRoot = await realpath(root);
  const keep = new Set();
  for (const path of retainedPaths) {
    const target = resolve(path);
    if (!isChild(root, target) || !isChild(realRoot, await realpath(target))) {
      throw new Error(`保留产物必须位于产物目录内：${target}`);
    }
    keep.add(relative(root, target).split(sep)[0]);
  }
  if (keep.size === 0) throw new Error("必须指定本次成功生成的产物，才能清理历史产物");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (keep.has(entry.name) || !matches(entry)) continue;
    const target = join(root, entry.name);
    if (entry.isSymbolicLink() || !isChild(realRoot, await realpath(target))) {
      throw new Error(`拒绝清理指向产物目录外的条目：${target}`);
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log(`已清理历史产物：${target}`);
  }
}

export function isDesktopArtifact(entry) {
  if (entry.isDirectory()) {
    return /^\d{8}-\d{6}(?:-[A-Za-z0-9]+)?$/.test(entry.name)
      || /^(?:win(?:-[a-z0-9]+)?-unpacked|linux(?:-[a-z0-9]+)?-unpacked|mac(?:-[a-z0-9]+)?)(?:\.tmp)?$/.test(entry.name);
  }
  return entry.isFile() && (
    /^this-is-a-agent-.*\.(?:exe|dmg|zip|AppImage|deb|rpm|tar\.gz|blockmap)$/.test(entry.name)
    || /^(?:latest(?:-[a-z0-9-]+)?|builder-debug|builder-effective-config)\.ya?ml$/.test(entry.name)
  );
}
export function isPiHostArtifact(entry) {
  if (entry.isDirectory()) {
    return /^pi-host-\d{8}-\d{6}(?:-[A-Za-z0-9]+)?$/.test(entry.name);
  }
  return entry.isFile() && /^pi-host-.*\.tar\.gz(?:\.sha256)?$/.test(entry.name);
}
