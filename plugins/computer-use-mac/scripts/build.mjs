import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pack } from "../../../packages/plugin-devkit/dist/pack.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shared = resolve(root, "../computer-use-win");
const scratch = process.env.PI_SCRATCH_DIR;
if (!scratch) throw new Error("请设置 PI_SCRATCH_DIR 为临时构建目录。");
const staging = await mkdtemp(join(scratch, "computer-use-mac-package-"));
const output = join(root, "dist");
try {
  for (const name of ["main.js", "mac-runtime.js", "cua.js", "vendor.json", "vendor", "renderer", "README.md", "THIRD_PARTY_NOTICES.md"]) {
    await cp(join(root, name), join(staging, name), { recursive: true });
  }
  for (const name of ["runtime.js", "tools.js", "policy.js", "overlay.js", "powershell.js", "image-region.js", "value-reader.js", "state-value.js", "LICENSE"]) {
    await cp(join(shared, name), join(staging, name));
  }
  await cp(join(shared, "scripts"), join(staging, "scripts"), { recursive: true });
  await mkdir(join(staging, "skills"));
  await cp(join(shared, "skills/office-workflows.md"), join(staging, "skills/office-workflows.md"));
  const manifest = JSON.parse(await readFile(join(shared, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.name = "Computer Use（Mac 常驻版）";
  manifest.version = pkg.version;
  manifest.description = "Mac 桌面控制，内置完整离线签名驱动，自动启动、常驻恢复和一键权限引导，支持 Apple Silicon 与 Intel。";
  manifest.i18n["zh-CN"].name = manifest.name;
  manifest.i18n["zh-CN"].description = manifest.description;
  manifest.i18n.en.name = "Computer Use (Mac Resident)";
  manifest.i18n.en.description = "macOS desktop automation with a complete bundled signed runtime, automatic startup, recovery and permission setup. Supports Apple Silicon and Intel.";
  manifest.ui.title = { "zh-CN": manifest.name, en: manifest.i18n.en.name };
  manifest.ui.height = 740;
  manifest.contributes.commands[0].title = `${manifest.name}: 打开面板`;
  // 工具声明沿用现有插件；只复用平台无关的 Office 知识。
  manifest.contributes.skills = ["skills/office-workflows.md"];
  const require = createRequire(import.meta.url);
  const { OCU_TOOLS, STOP_TOOL } = require(join(shared, "tools.js"));
  manifest.contributes.agentTools = [...OCU_TOOLS, STOP_TOOL].map(({ name, description, risk, schema }) => ({ name, description, risk, schema }));
  await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const hash = createHash("sha256").update(await readFile(join(staging, "vendor/cua-macos.tar.gz"))).digest("hex");
  const vendor = JSON.parse(await readFile(join(staging, "vendor.json"), "utf8"));
  if (hash !== vendor.archiveSha256) throw new Error("运行环境压缩包与 vendor.json 校验值不一致。");
  await mkdir(output, { recursive: true });
  const result = await pack(staging, { outDir: output });
  for (const warning of result.check.warnings) console.warn(warning.message);
  for (const file of await readdir(output)) {
    if (file.endsWith(".piplug") && join(output, file) !== result.packagePath) await rm(join(output, file));
  }
  await writeFile(join(output, "build-info.json"), JSON.stringify({ fileName: result.fileName, byteLength: result.byteLength, shasum: result.shasum, fileCount: result.fileCount, driverVersion: vendor.version, platform: "macOS universal", builtAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(JSON.stringify({ packagePath: result.packagePath, byteLength: result.byteLength, shasum: result.shasum, fileCount: result.fileCount }, null, 2));
} finally { await rm(staging, { recursive: true, force: true }); }
