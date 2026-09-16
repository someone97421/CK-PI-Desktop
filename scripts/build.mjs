import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prepareBuild } from "./prepare-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const mode = process.argv[2];
const modes = new Set(["dev", "desktop", "pack", "dist", "dist:win", "dist:mac", "dist:linux", "all", "js", "host", "host:dev", "runtime"]);
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
        await run(process.execPath, [cli, ...args], desktop);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
