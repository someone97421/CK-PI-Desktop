import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const targets = {
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
};

async function runChild(command, args, cwd, env = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    let interrupted;
    const stop = (signal) => { interrupted = signal; child.kill(signal); };
    const onInterrupt = () => stop("SIGINT");
    const onTerminate = () => stop("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      if (spawnError) reject(spawnError);
      else if (code === 0 && !interrupted) resolveRun();
      else reject(new Error(`${command} 退出：${interrupted ?? signal ?? code}`));
    });
  });
}

export async function prepareBuiltinBrowse(root, { run = runChild, destination } = {}) {
  root = resolve(root);
  destination = resolve(root, destination ?? "apps/desktop/resources/browse");
  const platform = process.platform;
  const arch = process.arch;
  const target = targets[platform]?.[arch];
  if (!target) throw new Error(`Browse 仅支持 darwin/win32/linux 的 x64/arm64 原生构建：${platform}-${arch}`);
  const source = JSON.parse(await readFile(new URL("./builtin-browse-source.json", import.meta.url), "utf8"));
  if (!/^https:\/\/github\.com\/someone97421\/ck-pi-desktop-browse\.git$/.test(source.repo)
      || !/^[a-f0-9]{40}$/.test(source.revision) || source.license !== "MIT") {
    throw new Error("内置 Browse 来源必须为个人仓库、完整提交 SHA 和 MIT 许可");
  }
  const executable = platform === "win32" ? "browse.exe" : "browse";
  try {
    const prepared = JSON.parse(await readFile(join(destination, "source.json"), "utf8"));
    if (prepared.repo === source.repo && prepared.revision === source.revision && prepared.version === source.version &&
        prepared.platform === platform && prepared.arch === arch && prepared.target === target &&
        prepared.sha256 === createHash("sha256").update(await readFile(join(destination, executable))).digest("hex")) {
      await readFile(join(destination, "LICENSE"));
      if (platform !== "win32") await chmod(join(destination, executable), 0o755);
      return { destination, binary: join(destination, executable), source: prepared };
    }
  } catch { /* 资源缺失或与固定源码不符时重新准备。 */ }
  const scratch = resolve(process.env.PI_SCRATCH_DIR?.trim() || tmpdir());
  await mkdir(scratch, { recursive: true });
  const staging = await mkdtemp(join(scratch, "builtin-browse-"));
  let retainStaging = false;
  try {
    const checkout = join(staging, "source");
    const prepared = join(staging, "prepared");
    const cargoHome = join(staging, "cargo-home");
    const temporary = join(staging, "tmp");
    const targetDirectory = join(staging, "target");
    await Promise.all([checkout, prepared, cargoHome, temporary].map((path) => mkdir(path, { recursive: true })));
    await run("git", ["init", checkout], staging);
    await run("git", ["fetch", "--depth=1", "--no-tags", source.repo, source.revision], checkout);
    await run("git", ["checkout", "--detach", source.revision], checkout);

    // 独立环境包装仍由调用方 run 等待和取消，不修改父进程环境或用户 Cargo 配置。
    const cargoRunner = join(staging, "run-cargo.mjs");
    const cargoEnvironment = { CARGO_HOME: cargoHome, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    await writeFile(cargoRunner, `import { spawn } from "node:child_process";\n${runChild.toString()}\n`
      + `await runChild("cargo", process.argv.slice(2), process.cwd(), { ...process.env, ...${JSON.stringify(cargoEnvironment)} });\n`);
    await run(process.execPath, [cargoRunner, "build", "--release", "--locked", "-p", "browse",
      "--manifest-path", join(checkout, "rust/Cargo.toml"), "--target", target, "--target-dir", targetDirectory], checkout);

    const binary = join(prepared, executable);
    await copyFile(join(targetDirectory, target, "release", executable), binary);
    if (platform !== "win32") await chmod(binary, 0o755);
    await copyFile(join(checkout, "LICENSE"), join(prepared, "LICENSE"));
    const provenance = {
      ...source, platform, arch, target, executable,
      sha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
    };
    await writeFile(join(prepared, "source.json"), `${JSON.stringify(provenance, null, 2)}\n`);

    // 备份也放 scratch，跨文件系统发布时复制失败可恢复上一版。
    const backup = join(staging, "previous");
    let previous = false;
    try {
      await lstat(destination);
      previous = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous) await cp(destination, backup, { recursive: true, preserveTimestamps: true });
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rm(destination, { recursive: true, force: true });
      await cp(prepared, destination, { recursive: true });
    } catch (error) {
      try {
        await rm(destination, { recursive: true, force: true });
        if (previous) await cp(backup, destination, { recursive: true, preserveTimestamps: true });
      } catch (restoreError) {
        retainStaging = true;
        throw new AggregateError([error, restoreError], `Browse 发布和回滚失败；上一版备份保留在 ${backup}`);
      }
      throw error;
    }
    console.log(`已准备内置 Browse ${source.version}：${platform}-${arch} (${source.revision})`);
    return { destination, binary: join(destination, executable), source: provenance };
  } finally {
    if (!retainStaging) {
      await rm(staging, { recursive: true, force: true }).catch((error) => {
        console.warn(`Browse 临时目录清理失败：${staging}（${error.message}）`);
      });
    }
  }
}
