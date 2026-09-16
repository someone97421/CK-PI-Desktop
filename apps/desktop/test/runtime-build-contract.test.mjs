import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const desktopPackageUrl = new URL("../package.json", import.meta.url);
// Double quotes work under both cmd.exe and sh; single quotes are literal on
// Windows, which silently matched no projects and skipped the dependency build.
const dependencyBuild = 'pnpm --filter "@pi-desktop/desktop^..." build';
const buildSource = await readFile(new URL("../../../scripts/build.mjs", import.meta.url), "utf8");

const readScripts = async () => {
  const pkg = JSON.parse(await readFile(desktopPackageUrl, "utf8"));
  return pkg.scripts ?? {};
};

test("build:deps rebuilds every workspace dependency consumed by Electron", async () => {
  const scripts = await readScripts();

  assert.ok(
    (scripts["build:deps"] ?? "").includes(dependencyBuild),
    "build:deps must rebuild every workspace dependency consumed by Electron",
  );
});

test("desktop dev builds all workspace dependencies before Electron starts", async () => {
  const scripts = await readScripts();
  assert.equal(scripts.dev, "node ../../scripts/build.mjs dev");
  assert.ok(buildSource.indexOf('await pnpm(["run", "build:deps"]') < buildSource.indexOf('if (mode === "dev")'));
  assert.match(buildSource, /if \(mode === "dev"\)[\s\S]*?await run\("cargo", \["build", "-p", "host-core"\]\);[\s\S]*?scripts\/dev-electron\.mjs/);
});

test("packaging scripts rebuild workspace dependencies before bundling", async () => {
  const scripts = await readScripts();

  for (const name of ["pack", "dist", "dist:mac", "dist:win", "dist:linux"]) {
    assert.equal(scripts[name], `node ../../scripts/build.mjs ${name}`);
  }
  assert.ok(buildSource.indexOf('await pnpm(["run", "build:deps"]') < buildSource.indexOf("await vite()"));
  assert.ok(buildSource.indexOf("prepareBuild()") < buildSource.indexOf("await pnpm("));
});

// tsc -p exits 0 without emitting when a tsbuildinfo claims the project is
// up to date, even if dist/ is gone. Keeping the marker inside dist means
// losing the output also loses the marker, so the next build really rebuilds.
test("workspace packages keep their tsbuildinfo inside the output directory", async () => {
  const packages = ["shared", "i18n", "plugin-sdk", "plugin-devkit", "agent-runtime"];

  for (const name of packages) {
    const configUrl = new URL(`../../../packages/${name}/tsconfig.json`, import.meta.url);
    const config = JSON.parse(await readFile(configUrl, "utf8"));
    const { outDir, tsBuildInfoFile, composite } = config.compilerOptions ?? {};

    assert.equal(outDir, "dist", `${name} must emit into dist`);
    assert.ok(composite, `${name} is expected to stay a composite project`);
    assert.equal(
      tsBuildInfoFile,
      "dist/tsconfig.tsbuildinfo",
      `${name} must store tsbuildinfo inside dist so a removed dist forces a real rebuild`,
    );

    const pkgUrl = new URL(`../../../packages/${name}/package.json`, import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
    assert.match(
      pkg.scripts?.clean ?? "",
      /rmSync\('dist'/,
      `${name} clean must remove dist (which now carries the tsbuildinfo)`,
    );
  }
});
