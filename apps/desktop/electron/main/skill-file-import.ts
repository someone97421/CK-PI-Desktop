import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import extractZip from "extract-zip";
import { importSkillFolders } from "./skill-folder-import";

/** 找到技能根目录后停止下钻，避免把技能附带的示例重复安装。 */
async function findSkillRoots(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
    return [directory];
  }
  const roots: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !["__MACOSX", ".git", "node_modules"].includes(entry.name)) {
      roots.push(...(await findSkillRoots(join(directory, entry.name))));
    }
  }
  return roots;
}

/** ZIP 与 .skill 共用目录导入，临时内容必须复制到所选 agents 层级。 */
export async function importSkillFile<T>(
  source: string,
  options: Record<string, unknown>,
  hostImport: (params: Record<string, unknown>) => Promise<{ skill: T }>,
): Promise<{ skill: T } | { imported: T[]; failed: Array<{ path: string; error: string }> }> {
  const extension = extname(source).toLowerCase();
  if (extension !== ".zip" && extension !== ".skill") {
    return hostImport({ ...options, path: source });
  }

  const temporary = await mkdtemp(join(tmpdir(), "pi-skill-import-"));
  try {
    const packageName = basename(source, extname(source));
    const extracted = join(temporary, !packageName || /^\.+$/.test(packageName) ? "skill" : packageName);
    await mkdir(extracted);
    await extractZip(source, { dir: extracted });
    const roots = await findSkillRoots(extracted);
    if (!roots.length) {
      throw new Error("SKILL_INVALID: archive does not contain a SKILL.md");
    }
    const importOptions = { ...options, mode: "copy", shape: "dir" };
    if (roots.length === 1) {
      return await hostImport({ ...importOptions, path: roots[0] });
    }
    const { imported, failed } = await importSkillFolders(roots, importOptions, hostImport);
    return {
      imported,
      failed: failed.map((failure) => ({
        ...failure,
        path: relative(extracted, failure.path),
      })),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
