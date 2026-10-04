import { app, BrowserWindow, nativeImage } from "electron";
import { promises as fs, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { APP_ID } from "@pi-desktop/shared";
import { appearanceMediaDirectory, readAppearanceIconPath } from "./appearance-media";
import { iconDigest, replaceExecutableIcons, type SavedIconResource } from "./windows-icon-resources";
import { WINDOWS_ICON_HELPER } from "./windows-icon-helper";

interface TargetRecord {
  path: string;
  hash: string;
  choice: string;
  size: number;
  mtimeMs: number;
  originalIcons: SavedIconResource[];
}
interface IconState { version: 1; choice: string; targets: TargetRecord[] }
interface IconResult { ok: boolean; error?: string; warnings?: string[] }
interface PreparedJob { directory: string; requestPath: string; readyPath: string }

let restartingForIcon = false;
export const isRestartingForAppearanceIcon = () => restartingForIcon;
const normalizePath = (path: string) => resolve(path).replace(/[\\/]+$/, "").toLowerCase();

/** ICO 目录包含 PNG 帧，兼顾资源管理器的大图标和任务栏小图标。 */
export function createWindowsIco(png: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("图标必须是有效的 PNG 文件");
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map((size) => image.resize({ width: size, height: size, quality: "best" }).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let index = 0; index < sizes.length; index++) {
    const position = 6 + index * 16;
    header[position] = sizes[index] === 256 ? 0 : sizes[index];
    header[position + 1] = header[position];
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(frames[index].length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += frames[index].length;
  }
  return Buffer.concat([header, ...frames]);
}

export class WindowsAppearanceIcons {
  private readonly directory: string;
  private readonly statePath: string;
  private readonly resultPath: string;
  private readonly activeIconPath: string;
  private automaticJob: PreparedJob | null = null;
  private automaticIconPath: string | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private message: string | undefined;

  constructor(private readonly dataDir: string) {
    this.directory = join(appearanceMediaDirectory(dataDir), "windows-system-icon");
    this.statePath = join(this.directory, "state.json");
    this.resultPath = join(this.directory, "result.json");
    this.activeIconPath = join(this.directory, "app.ico");
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private async readState(): Promise<IconState | null> {
    try {
      const state = JSON.parse(await fs.readFile(this.statePath, "utf8")) as IconState;
      return state.version === 1 && Array.isArray(state.targets) ? state : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private executablePath(): string {
    // 便携临时目录每次退出都会删除；用户持有的外层 EXE 才是持久入口。
    return resolve(process.env.PORTABLE_EXECUTABLE_FILE?.trim() || process.execPath);
  }

  private async choice(): Promise<{ digest: string; ico: Buffer; custom: boolean }> {
    const pngPath = readAppearanceIconPath(this.dataDir);
    if (pngPath) {
      const png = await fs.readFile(pngPath);
      return { digest: iconDigest(png), ico: createWindowsIco(png), custom: true };
    }
    return {
      digest: "default", custom: false,
      ico: await fs.readFile(join(process.resourcesPath, "app-icon.ico")),
    };
  }

  private async pending(state: IconState | null, choice: string): Promise<boolean> {
    if (!state) return choice !== "default";
    if (state.choice !== choice) return true;
    const path = this.executablePath();
    const target = state.targets.find((item) => normalizePath(item.path) === normalizePath(path));
    if (!target) return choice !== "default";
    if (target.choice !== choice) return true;
    const stat = await fs.stat(path);
    return target.size !== stat.size || target.mtimeMs !== Math.trunc(stat.mtimeMs);
  }

  async getStatus(): Promise<{ supported: boolean; pending: boolean; message?: string }> {
    if (process.platform !== "win32" || !app.isPackaged) return { supported: false, pending: false };
    return this.serialize(async () => {
      const pngPath = readAppearanceIconPath(this.dataDir);
      const choice = pngPath ? iconDigest(await fs.readFile(pngPath)) : "default";
      return { supported: true, pending: await this.pending(await this.readState(), choice), message: this.message };
    });
  }

  /** 升级后自动重用已应用的选择；退出时替换新 EXE，不打断当前会话。 */
  async initialize(): Promise<void> {
    if (process.platform !== "win32" || !app.isPackaged) return;
    await this.serialize(async () => {
      try {
        const result = JSON.parse(await fs.readFile(this.resultPath, "utf8")) as IconResult;
        this.message = result.ok ? result.warnings?.join("\n") || undefined : result.error;
        await fs.rm(this.resultPath, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.message = String(error);
      }
      const state = await this.readState();
      const pngPath = readAppearanceIconPath(this.dataDir);
      const choice = pngPath ? iconDigest(await fs.readFile(pngPath)) : "default";
      if (state?.choice === choice && await this.pending(state, choice)) {
        this.automaticJob = await this.prepare(false);
        this.automaticIconPath = pngPath;
      }
      this.updateWindowDetails();
      app.on("browser-window-created", () => this.updateWindowDetails());
      app.on("will-quit", () => {
        if (this.automaticJob) {
          const job = this.automaticJob;
          this.automaticJob = null;
          const helper = this.spawnHelper(job);
          helper.on("error", () => { void fs.rm(job.directory, { recursive: true, force: true }); });
          helper.unref();
        }
      });
    });
  }

  updateWindowDetails(): void {
    if (process.platform !== "win32" || !app.isPackaged || !existsSync(this.activeIconPath)) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setAppDetails({
        appId: APP_ID, appIconPath: this.activeIconPath,
        relaunchCommand: `"${this.executablePath()}"`, relaunchDisplayName: app.getName(),
      });
    }
  }

  reportError(error: unknown): void {
    this.message = error instanceof Error ? error.message : String(error);
  }

  /** 选图、恢复默认或配置导入会使升级时准备的文件失效。 */
  selectionChanged(force = false): void {
    if (!force && readAppearanceIconPath(this.dataDir) === this.automaticIconPath) return;
    const job = this.automaticJob;
    this.automaticJob = null;
    if (job) void fs.rm(job.directory, { recursive: true, force: true });
  }

  private async prepare(restart: boolean): Promise<PreparedJob> {
    const choice = await this.choice();
    const state = await this.readState();
    const targetPath = this.executablePath();
    await fs.mkdir(this.directory, { recursive: true });
    // 先确认目标目录可写，失败留在设置页，不退出应用。
    const probe = join(dirname(targetPath), `.icon-write-${randomUUID()}.tmp`);
    await fs.writeFile(probe, "", { flag: "wx" });
    await fs.rm(probe, { force: true });
    const directory = await fs.mkdtemp(join(app.getPath("temp"), "this-is-a-agent-icon-"));
    try {
      const source = await fs.readFile(targetPath);
      const beforeHash = iconDigest(source);
      const previous = state?.targets.find((item) => item.hash === beforeHash);
      const originals = previous?.originalIcons;
      // 其他业务目录可能已替换同一 EXE；未知状态以本安装包的品牌图标作默认值。
      const defaultIco = await fs.readFile(join(process.resourcesPath, "app-icon.ico"));
      const patch = replaceExecutableIcons(source, choice.custom ? choice.ico : null, originals, defaultIco);
      const preparedPath = join(directory, "app.exe");
      await fs.writeFile(preparedPath, patch.bytes);
      const icoPath = join(directory, "app.ico");
      await fs.writeFile(icoPath, choice.ico);
      await fs.writeFile(join(directory, "apply.ps1"), `\uFEFF${WINDOWS_ICON_HELPER}`, "utf8");
      const requestPath = join(directory, "request.json");
      const readyPath = join(directory, "ready");
      const request = {
        id: randomUUID(), processId: process.pid, restart,
        jobDirectory: directory, readyPath, icoPath, activeIconPath: this.activeIconPath,
        statePath: this.statePath, resultPath: this.resultPath, choice: choice.digest,
        launchPath: targetPath,
        retainedTargets: state?.targets.filter((item) => normalizePath(item.path) !== normalizePath(targetPath)) ?? [],
        matchPaths: [...new Set([normalizePath(targetPath), normalizePath(process.execPath), normalizePath(this.activeIconPath)])],
        targets: [{ path: targetPath, preparedPath, beforeHash, record: {
          path: targetPath, hash: iconDigest(patch.bytes), choice: choice.digest, size: 0, mtimeMs: 0,
          originalIcons: patch.originalIcons,
        } satisfies TargetRecord }],
      };
      await fs.writeFile(requestPath, JSON.stringify(request), "utf8");
      return { directory, requestPath, readyPath };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private spawnHelper(job: PreparedJob) {
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // Start-Process 为助手创建独立的隐藏进程，使其在 Electron 退出后继续执行。
    // 启动器等待助手结束，保留退出状态；路径通过环境变量传递，不拼接为脚本。
    const launcher = String.raw`
$ErrorActionPreference = 'Stop'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $env:PI_ICON_HELPER_SCRIPT + '" -RequestPath "' + $env:PI_ICON_HELPER_REQUEST + '"'
$helper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError ($env:PI_ICON_HELPER_REQUEST + '.stderr') -PassThru
$helper.WaitForExit()
exit $helper.ExitCode
`;
    return spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")], {
      stdio: "ignore", windowsHide: true,
      env: {
        ...process.env, PI_DESKTOP_DATA_DIR: this.dataDir,
        PI_ICON_HELPER_SCRIPT: join(job.directory, "apply.ps1"),
        PI_ICON_HELPER_REQUEST: job.requestPath,
      },
      cwd: process.env.SystemRoot || "C:\\Windows",
    });
  }

  async applyAndRestart(): Promise<void> {
    if (process.platform !== "win32" || !app.isPackaged) throw new Error("系统图标替换需要在 Windows 安装版或便携版中使用");
    await this.serialize(async () => {
      if (restartingForIcon) return;
      this.selectionChanged(true);
      const job = await this.prepare(true);
      const helper = this.spawnHelper(job);
      let helperError: Error | undefined;
      helper.on("error", (error) => { helperError = error; });
      const deadline = Date.now() + 15_000;
      while (!existsSync(job.readyPath)) {
        if (helperError || helper.exitCode !== null || Date.now() > deadline) {
          helper.kill();
          const detail = await fs.readFile(`${job.requestPath}.stderr`, "utf8").catch(() => "");
          await fs.rm(job.directory, { recursive: true, force: true });
          throw helperError ?? new Error(`系统图标助手启动失败，应用保持运行${detail.trim() ? `：${detail.trim()}` : ""}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      helper.unref();
      restartingForIcon = true;
      app.quit();
    });
  }
}
