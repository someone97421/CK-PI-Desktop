import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { pack } from "../../../packages/plugin-devkit/dist/pack.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.env.PI_SCRATCH_DIR;
if (!scratch) throw new Error("请设置 PI_SCRATCH_DIR 为临时构建目录。");
const staging = await mkdtemp(join(scratch, "computer-use-win-package-"));
const output = join(root, "dist");
const excluded = new Set(["dist", "tests", "node_modules", ".gitignore", "package.json", "scripts/build.mjs"]);
try {
  await cp(root, staging, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(root.length + 1).replaceAll("\\", "/");
      return !excluded.has(relative);
    },
  });
  const manifest = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
  const vendor = JSON.parse(await readFile(join(staging, "vendor.json"), "utf8"));
  const hash = createHash("sha256").update(await readFile(join(staging, "vendor/cua-windows-x64.zip"))).digest("hex");
  if (hash !== vendor.archiveSha256) throw new Error("运行环境压缩包与 vendor.json 校验值不一致。");
  const result = await pack(staging, { outDir: join(staging, ".out") });
  for (const warning of result.check.warnings) console.warn(warning.message);
  const fileName = `${manifest.id}-${manifest.version}-win-x64.piplug`;
  const packagePath = join(output, fileName);
  await mkdir(output, { recursive: true });
  await rm(packagePath, { force: true });
  await rename(result.packagePath, packagePath).catch(async () => {
    await cp(result.packagePath, packagePath);
  });
  for (const file of await readdir(output)) {
    if (file.endsWith(".piplug") && file !== fileName) await rm(join(output, file));
  }
  await writeFile(join(output, "build-info.json"), JSON.stringify({ fileName, byteLength: result.byteLength, shasum: result.shasum, fileCount: result.fileCount, driverVersion: vendor.version, platform: "windows-x64", builtAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(JSON.stringify({ packagePath, byteLength: result.byteLength, shasum: result.shasum, fileCount: result.fileCount }, null, 2));
} finally { await rm(staging, { recursive: true, force: true }); }
