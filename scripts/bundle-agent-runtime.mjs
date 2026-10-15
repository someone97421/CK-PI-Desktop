import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../packages/agent-runtime/", import.meta.url));
const require = createRequire(join(packageRoot, "package.json"));
const { build } = require("esbuild");
const banner = "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);";
const resizeWorkerBanner = [
  "import { createRequire as __piCreateRequire } from 'node:module';",
  "import { fileURLToPath as __piFileURLToPath } from 'node:url';",
  "import { dirname as __piDirname } from 'node:path';",
  "const require = __piCreateRequire(import.meta.url);",
  "const __dirname = __piDirname(__piFileURLToPath(import.meta.url));",
].join(" ");

async function bundleImageResizeAssets(directory) {
  // 固定版本仅导出 ESM；从所属工作区的真实包目录定位附带资源。
  const codingAgentRoot = await realpath(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent"));
  const codingAgentEntry = join(codingAgentRoot, "dist/index.js");
  const codingAgentRequire = createRequire(codingAgentEntry);
  const photonEntry = codingAgentRequire.resolve("@silvia-odwyer/photon-node");
  const chunksDirectory = join(directory, "chunks");
  await mkdir(chunksDirectory, { recursive: true });
  await build({
    entryPoints: [join(dirname(codingAgentEntry), "utils/image-resize-worker.js")],
    bundle: true,
    platform: "node",
    format: "esm",
    minify: true,
    outfile: join(chunksDirectory, "image-resize-worker.js"),
    banner: { js: resizeWorkerBanner },
  });
  await copyFile(
    join(dirname(photonEntry), "photon_rs_bg.wasm"),
    join(chunksDirectory, "photon_rs_bg.wasm"),
  );
}

export async function writeBundlePackageManifest(directory) {
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  );
}

export async function bundleAgentRuntime(outputDir = join(packageRoot, "dist-bundle")) {
  await mkdir(dirname(outputDir), { recursive: true });
  const stagingDir = await mkdtemp(join(dirname(outputDir), ".dist-bundle-stage-"));
  const backupDir = join(dirname(outputDir), `.dist-bundle-backup-${randomUUID()}`);
  let previousOutputMoved = false;

  try {
    await build({
      entryPoints: [join(packageRoot, "src/sidecar.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      minify: true,
      splitting: true,
      outdir: stagingDir,
      entryNames: "sidecar",
      chunkNames: "chunks/[name]-[hash]",
      define: { PI_BUNDLED_NODE: "true" },
      banner: { js: banner },
    });
    await bundleImageResizeAssets(stagingDir);
    await writeBundlePackageManifest(stagingDir);

    // 新资源全部生成成功后再替换，失败时保留上一份可用的完整产物。
    try {
      await rename(outputDir, backupDir);
      previousOutputMoved = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagingDir, outputDir);
    } catch (error) {
      if (previousOutputMoved) {
        try {
          await rename(backupDir, outputDir);
          previousOutputMoved = false;
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], "无法安装新运行时产物或恢复上一份产物");
        }
      }
      throw error;
    }
    if (previousOutputMoved) {
      await rm(backupDir, { recursive: true });
      previousOutputMoved = false;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    if (!previousOutputMoved) await rm(backupDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bundleAgentRuntime();
}
