import { app, dialog, shell } from "electron";
import { readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { APP_SLUG } from "@pi-desktop/shared";
import { resolveLocale } from "@pi-desktop/i18n";

// 启动配置独立于业务数据库和按数据目录划分的 Chromium profile。
export function dataDirectoryConfigPath(appData: string): string {
  return join(appData, APP_SLUG, "data-directory.json");
}

export function readConfiguredDataDirectory(appData: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(dataDirectoryConfigPath(appData), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const config = JSON.parse(text) as { dataDir?: unknown };
  if (!config || typeof config.dataDir !== "string" || !isAbsolute(config.dataDir)) {
    throw new Error("数据存储位置配置无效，请检查 data-directory.json");
  }
  if (!statSync(config.dataDir).isDirectory()) {
    throw new Error(`数据存储位置不是目录：${config.dataDir}`);
  }
  return config.dataDir;
}

export async function saveConfiguredDataDirectory(appData: string, dataDir: string): Promise<void> {
  const path = dataDirectoryConfigPath(appData);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ dataDir }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function containsPath(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

export async function validateDataDirectoryTarget(source: string, target: string): Promise<string> {
  const sourcePath = await realpath(source);
  const targetPath = await realpath(target);
  if (containsPath(sourcePath, targetPath) || containsPath(targetPath, sourcePath)) {
    throw new Error("请选择与当前数据目录互不包含的其他目录");
  }
  if ((await readdir(targetPath)).length !== 0) {
    throw new Error("请选择空目录，以免覆盖已有文件");
  }
  return targetPath;
}

/** 仅在数据库和其他写入进程关闭后执行；失败时启动配置仍指向原目录。 */
export async function migrateDataDirectory(source: string, target: string, appData: string): Promise<void> {
  const targetPath = await validateDataDirectoryTarget(source, target);
  const staging = await mkdtemp(join(dirname(targetPath), `.${basename(targetPath)}-migration-`));
  // cp 的 errorOnExist 会拒绝已创建的目标目录；临时容器与复制目标分开。
  const payload = join(staging, "data");
  try {
    await cp(await realpath(source), payload, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    // rmdir 只删除仍为空的目标；不会覆盖迁移期间写入目标的其他数据。
    await rmdir(targetPath);
    await rename(payload, targetPath);
    await saveConfiguredDataDirectory(appData, targetPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

let pendingMigration: { source: string; target: string; appData: string; english: boolean } | null = null;
let choosingDirectory = false;
// 启动入口把有效目录写入环境之前记录用户覆盖状态。
const overriddenByEnvironment = Boolean(process.env.PI_DESKTOP_DATA_DIR?.trim());

export function isRestartingForDataDirectory(): boolean {
  return pendingMigration !== null;
}

export function getDataDirectoryState(dataDir: string) {
  return { path: dataDir, overriddenByEnvironment };
}

export async function openDataDirectory(dataDir: string): Promise<void> {
  const error = await shell.openPath(dataDir);
  if (error) throw new Error(error);
}

export async function changeDataDirectory(dataDir: string, language?: unknown): Promise<{ canceled: boolean; restarting?: boolean }> {
  if (overriddenByEnvironment) throw new Error("当前数据目录由 PI_DESKTOP_DATA_DIR 环境变量指定，请先取消该覆盖");
  if (choosingDirectory || pendingMigration) throw new Error("正在更改数据存储位置，请稍候");
  choosingDirectory = true;
  try {
    const english = resolveLocale(typeof language === "string" && language !== "auto" ? language : app.getLocale()) === "en";
    const picked = await dialog.showOpenDialog({
      title: english ? "Choose data directory" : "选择数据存储目录",
      defaultPath: dataDir,
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const target = await validateDataDirectoryTarget(dataDir, resolve(picked.filePaths[0]));
    const confirmed = await dialog.showMessageBox({
      type: "question",
      title: english ? "Change data directory" : "更改数据存储位置",
      message: english ? "Copy existing data and restart the app?" : "复制现有数据并重启应用？",
      detail: english
        ? `Current directory: ${dataDir}\nNew directory: ${target}\n\nRunning sessions will stop. The app will close its database, copy conversations, settings, credentials, attachments and plugin data, then use the new directory. The original directory will be retained. If copying fails, the app will keep using the original directory. The new directory uses a separate browser cache, so websites may require signing in again.`
        : `当前目录：${dataDir}\n新目录：${target}\n\n正在运行的会话会结束。应用关闭数据库后复制会话、配置、凭据、附件和插件数据，成功后使用新目录。原目录会保留；复制失败时继续使用原目录。新目录使用独立的浏览器缓存，网页可能需要重新登录。`,
      buttons: english ? ["Copy and restart", "Cancel"] : ["复制并重启", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (confirmed.response !== 0) return { canceled: true };
    pendingMigration = { source: dataDir, target, appData: app.getPath("appData"), english };
    // 让 IPC 回执先返回，再进入既有的正常关闭流程。
    setTimeout(() => app.quit(), 100);
    return { canceled: false, restarting: true };
  } finally {
    choosingDirectory = false;
  }
}

/** 正常关闭完成后调用，复制结果确定以后才安排重启。 */
export async function finishDataDirectoryRestart(shutdownError?: unknown): Promise<void> {
  if (!pendingMigration) return;
  const migration = pendingMigration;
  try {
    if (shutdownError !== undefined) throw shutdownError;
    await migrateDataDirectory(migration.source, migration.target, migration.appData);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox(
      migration.english ? "Data directory migration failed" : "数据目录迁移失败",
      migration.english
        ? `The app will keep using the original directory: ${migration.source}\n\n${reason}`
        : `应用将继续使用原目录：${migration.source}\n\n${reason}`,
    );
  } finally {
    pendingMigration = null;
    // 恢复启动配置解析，避免内部传递给子进程的目录变成用户环境覆盖。
    delete process.env.PI_DESKTOP_DATA_DIR;
    const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE?.trim();
    app.relaunch(portableExecutable ? { execPath: portableExecutable } : undefined);
  }
}
