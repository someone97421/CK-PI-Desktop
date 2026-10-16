import { app } from "electron";
import { spawn } from "node:child_process";
import { canonicalDataDirectoryPath, requestDataDirectoryLock } from "../application-identity";
import type { StorageRoots } from "./preferences";

const LOCK_FLAG = "--pi-storage-backup-lock";
const LOCK_READY = "PI_STORAGE_BACKUP_LOCK_READY";
const LOCK_BUSY = "PI_STORAGE_BACKUP_LOCK_BUSY";

/** 在 installation 的任何业务初始化之前分流；只持有目录已有的互操作锁。 */
export function runBackupLockProcess(): boolean {
  const flagIndex = process.argv.indexOf(LOCK_FLAG);
  if (flagIndex < 0) return false;
  const dataDir = process.argv[flagIndex + 1];
  const finish = (code = 0) => app.exit(code);
  process.stdin.on("end", () => finish());
  process.stdin.on("close", () => finish());
  process.stdin.on("error", () => finish(1));
  process.stdout.on("error", () => finish(1));
  process.stdin.resume();
  try {
    if (!dataDir || dataDir.startsWith("--")) throw new Error("Missing backup directory");
    if (!requestDataDirectoryLock(app, dataDir)) {
      process.stdout.write(`${LOCK_BUSY}\n`, () => finish(1));
      return true;
    }
    // stdin 管道随父进程退出关闭；未收到显式结束前不释放锁。
    process.stdout.write(`${LOCK_READY}\n`);
  } catch {
    finish(1);
  }
  return true;
}

type BackupLock = { assertHeld: () => void; release: () => Promise<void> };

async function acquireBackupLock(dataDir: string): Promise<BackupLock> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [
    ...(app.isPackaged ? [] : [app.getAppPath()]), LOCK_FLAG, dataDir,
  ], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const unavailable = () => new Error(`无法清理旧备份：目录正在使用或暂时不可用，请关闭使用它的应用后重试。\n${dataDir}`);
  let ended = false;
  let releasing = false;
  let lost = false;
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      ended = true;
      if (!releasing) lost = true;
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  // 提前关闭或父端写入失败都会使本次删除失败，不把它当作取得锁。
  child.stdin.on("error", () => { if (!releasing) lost = true; });
  const release = async () => {
    releasing = true;
    if (ended) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => { cleanup(); reject(unavailable()); }, 10_000);
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const lines = output.split(/\r?\n/);
        if (lines.includes(LOCK_READY)) { cleanup(); resolve(); }
        else if (lines.includes(LOCK_BUSY) || output.length > 4096) { cleanup(); reject(unavailable()); }
      };
      const onExit = () => { cleanup(); reject(unavailable()); };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onExit);
      };
      child.stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onExit);
    });
    const assertHeld = () => { if (ended || lost) throw unavailable(); };
    assertHeld();
    return { assertHeld, release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** 全部旧业务目录取得锁后才开始删除，任何占用均保留整批备份。 */
export async function withBackupDirectoryLocks<T>(backups: StorageRoots[], remove: () => Promise<T>): Promise<T> {
  const locks: BackupLock[] = [];
  try {
    const directories = new Set(backups.map((backup) => canonicalDataDirectoryPath(backup.data)));
    for (const directory of directories) locks.push(await acquireBackupLock(directory));
    for (const lock of locks) lock.assertHeld();
    const result = await remove();
    for (const lock of locks) lock.assertHeld();
    return result;
  } finally {
    await Promise.all(locks.map((lock) => lock.release()));
  }
}
