import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prepareBuild } from "./prepare-build.mjs";
import { isDesktopArtifact, isPiHostArtifact, retainArtifacts } from "./artifact-retention.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const mode = process.argv[2];
const modes = new Set(["dev", "desktop", "pack", "dist", "dist:win", "dist:mac", "dist:linux", "all", "js", "host", "host:dev", "runtime", "pi-host"]);
if (!modes.has(mode)) throw new Error(`未知构建入口：${mode}`);
const stamp = prepareBuild();
console.log(`这是一个助手 · ${stamp.displayVersion}`);
const require = createRequire(join(desktop, "package.json"));
let activeChild;

async function run(command, args, cwd = root) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolveRun();
      else reject(new Error(`${command} 退出：${signal ?? code}`));
    });
  });
}
async function pnpm(args, cwd = root) {
  const cli = process.env.npm_execpath;
  if (!cli || !/\.[cm]?js$/i.test(cli)) throw new Error("请通过 pnpm 脚本执行构建，例如 pnpm dev / pnpm dist");
  await run(process.execPath, [cli, ...args], cwd);
}
async function vite() {
  const cli = join(dirname(require.resolve("electron-vite/package.json")), "bin/electron-vite.js");
  await run(process.execPath, [cli, "build"], desktop);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { activeChild?.kill(signal); process.exitCode = 1; });
}

try {
  if (mode === "all" || mode === "js") {
    await pnpm(["-r", "--if-present", "build"]);
    if (mode === "all") await run("cargo", ["build", "--release", "-p", "host-core"]);
  } else if (mode === "host") {
    await run("cargo", ["build", "--release", "-p", "host-core"]);
  } else if (mode === "host:dev") {
    await run("cargo", ["run", "-p", "host-core"]);
  } else if (mode === "runtime") {
    await pnpm(["run", "build:deps"], desktop);
    await pnpm(["-C", "../../packages/agent-runtime", "bundle"], desktop);
  } else if (mode === "pi-host") {
    // pi-host 远控主机包：JS 与 sidecar 在本机构建。linux-x64 目标在本机
    // （Linux x64）构建时随本入口同步 cargo 编译当前 stamp 版本的
    // host-core；其他主机必须经 THIS_IS_A_AGENT_PI_HOST_CORE 提供交叉
    // 构建产物，bundle.mjs 会再校验 ELF x64，防止装错平台二进制。
    await pnpm(["--filter", "@pi-desktop/pi-host^...", "build"]);
    await pnpm(["--filter", "@pi-desktop/agent-runtime", "bundle"]);
    await pnpm(["--filter", "@pi-desktop/pi-host", "build"]);
    const nativeLinuxX64 = process.platform === "linux" && process.arch === "x64";
    if (nativeLinuxX64 && !process.env.THIS_IS_A_AGENT_PI_HOST_CORE?.trim()) {
      await run("cargo", ["build", "--release", "-p", "host-core"]);
    }
    const hostCoreRaw = process.env.THIS_IS_A_AGENT_PI_HOST_CORE?.trim()
      || (nativeLinuxX64 ? join(root, "target/release/pi-desktop-host-core") : "");
    const hostCore = hostCoreRaw ? resolve(hostCoreRaw) : "";
    if (!hostCore || !existsSync(hostCore)) {
      throw new Error(`缺少 linux-x64 host-core 二进制：${hostCore || "未指定"}；请通过 THIS_IS_A_AGENT_PI_HOST_CORE 提供交叉构建产物`);
    }
    const bundleName = `pi-host-${stamp.version}-linux-x64`;
    const outputDirectory = resolve(root, process.env.THIS_IS_A_AGENT_OUTPUT_DIR?.trim() || join(root, "release"));
    await mkdir(outputDirectory, { recursive: true });
    const staging = await mkdtemp(join(outputDirectory, `.building-pi-host-${stamp.displayVersion}-`));
    const completed = join(outputDirectory, basename(staging).replace(/^\.building-/, ""));
    try {
      await run(process.execPath, [join(root, "apps/pi-host/scripts/bundle.mjs"),
        "--host-core", hostCore, "--platform", "linux", "--arch", "x64", "--out", join(staging, bundleName)], root);
      await run("tar", ["-czf", join(staging, `${bundleName}.tar.gz`), "-C", staging, bundleName], root);
      const digest = createHash("sha256").update(await readFile(join(staging, `${bundleName}.tar.gz`))).digest("hex");
      await writeFile(join(staging, `${bundleName}.tar.gz.sha256`), `${digest}  ${bundleName}.tar.gz\n`);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await rename(staging, completed);
    await retainArtifacts(outputDirectory, [completed], isPiHostArtifact);
    console.log(`本次 pi-host 产物：${completed}`);
  } else {
    await pnpm(["run", "build:deps"], desktop);
    if (mode === "dev") {
      await run("cargo", ["build", "-p", "host-core"]);
      await run(process.execPath, [join(root, "scripts/dev-electron.mjs")], desktop);
    } else {
      if (mode !== "desktop") {
        await run("cargo", ["build", "--release", "-p", "host-core"]);
        await pnpm(["-C", "../../packages/agent-runtime", "bundle"], desktop);
      }
      await vite();
      if (mode !== "desktop") {
        if (process.platform !== "win32") {
          chmodSync(join(desktop, "this-is-a-agent-macOS-open.command"), 0o755);
        }
        const cli = require.resolve("electron-builder/cli.js");
        const args = mode === "pack" ? ["--dir", "--publish", "never"]
          : [...(mode.includes(":") ? [`--${mode.split(":")[1]}`] : []), "--publish", "never"];
        // 每次生成独立的一整套产物，构建失败时保留上一份成功产物。
        const releaseRoot = join(desktop, "release");
        const outputDirectory = resolve(desktop, process.env.THIS_IS_A_AGENT_OUTPUT_DIR?.trim() || "release");
        await mkdir(outputDirectory, { recursive: true });
        const staging = await mkdtemp(join(outputDirectory, `.building-${stamp.displayVersion}-`));
        const completed = join(outputDirectory, basename(staging).replace(/^\.building-/, ""));
        args.push(`--config.directories.output=${staging}`);
        // Windows 解压后重命名失败时，可显式复用同版本的已解压 Electron。
        const electronDistribution = process.env.THIS_IS_A_AGENT_ELECTRON_DIST?.trim();
        if (electronDistribution) args.push(`--config.electronDist=${electronDistribution}`);
        try {
          await run(process.execPath, [cli, ...args], desktop);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        await rename(staging, completed);
        await retainArtifacts(outputDirectory, [completed], isDesktopArtifact);
        // 自定义目录位于 release 内时，同时清理 release 中的其他历史批次。
        const relativeOutput = relative(releaseRoot, outputDirectory);
        if (relativeOutput && relativeOutput !== ".." && !relativeOutput.startsWith(`..${sep}`) && !isAbsolute(relativeOutput)) {
          await retainArtifacts(releaseRoot, [completed], isDesktopArtifact);
        }
        console.log(`本次构建产物：${completed}`);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
