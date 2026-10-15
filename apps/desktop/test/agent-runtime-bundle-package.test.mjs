import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeBundlePackageManifest } from "../../../scripts/bundle-agent-runtime.mjs";

// 安装包中的 sidecar.js 使用 ESM；通过真实构建入口及其清单写入函数检查契约，
// 不执行完整 esbuild，也不依赖预先生成的 shared/dist。
const desktopPackageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const agentRuntimePackageJson = JSON.parse(
  await readFile(
    new URL("../../../packages/agent-runtime/package.json", import.meta.url),
    "utf8",
  ),
);
const bundleSource = await readFile(
  new URL("../../../scripts/bundle-agent-runtime.mjs", import.meta.url),
  "utf8",
);

test("desktop packaging ships the whole agent-runtime dist-bundle directory", () => {
  const entry = desktopPackageJson.build.extraResources.find(
    (resource) => resource.to === "agent-runtime",
  );
  assert.deepEqual(entry, {
    from: "../../packages/agent-runtime/dist-bundle",
    to: "agent-runtime",
  });
});

test("agent-runtime 的 bundle 命令使用独立构建入口", () => {
  assert.equal(
    agentRuntimePackageJson.scripts.bundle,
    "node ../../scripts/bundle-agent-runtime.mjs",
  );
});

test("agent-runtime bundle emits an ESM sidecar entry", () => {
  const mainBuild = bundleSource.slice(
    bundleSource.indexOf("export async function bundleAgentRuntime("),
    bundleSource.indexOf("await bundleImageResizeAssets(stagingDir)"),
  );
  assert.match(mainBuild, /entryPoints: \[join\(packageRoot, "src\/sidecar\.ts"\)\]/);
  assert.match(mainBuild, /format: "esm"/);
  assert.match(mainBuild, /outdir: stagingDir/);
  assert.match(mainBuild, /entryNames: "sidecar"/);
});

test("构建成功后在发布产物前写入 ESM 清单", () => {
  const assetsIndex = bundleSource.indexOf("await bundleImageResizeAssets(stagingDir)");
  const manifestIndex = bundleSource.indexOf("await writeBundlePackageManifest(stagingDir)");
  const publishIndex = bundleSource.indexOf("await rename(stagingDir, outputDir)");
  assert.ok(assetsIndex >= 0);
  assert.ok(manifestIndex > assetsIndex);
  assert.ok(publishIndex > manifestIndex);
});

test("真实清单写入函数生成 Node 可识别的 ESM package.json", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-bundle-"));
  try {
    await writeBundlePackageManifest(workDir);
    const written = JSON.parse(
      await readFile(join(workDir, "package.json"), "utf8"),
    );
    assert.equal(written.type, "module");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("agent-runtime bundle declares the bundled-Node flag for the kernel extension loader", () => {
  assert.match(bundleSource, /define: \{ PI_BUNDLED_NODE: "true" \}/);
});
