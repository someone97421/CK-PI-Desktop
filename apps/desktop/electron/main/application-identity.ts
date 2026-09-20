import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { APP_LEGACY_LOCK_NAME, APP_NAME, APP_SLUG } from "@pi-desktop/shared";
import type { App } from "electron";

function canonicalPath(path: string): string {
  let canonical = resolve(path);
  try { canonical = realpathSync.native(canonical); } catch {}
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** 共用业务目录，独立 Chromium 配置；锁的路径在 Electron 创建锁对象时固定。 */
export function configureApplicationIdentity(app: App, options: { home?: string; dataDir?: string } = {}): { dataDir: string; hasSingleInstanceLock: boolean } {
  const defaultDataDir = join(options.home ?? homedir(), ".pi-desktop");
  const dataDir = resolve((options.dataDir ?? process.env.PI_DESKTOP_DATA_DIR)?.trim() || defaultDataDir);
  mkdirSync(dataDir, { recursive: true });
  const key = canonicalPath(dataDir);
  const isDefault = key === canonicalPath(defaultDataDir);
  const profileKey = createHash("sha256").update(key).digest("hex").slice(0, 24);
  const appData = app.getPath("appData");
  const profileDir = isDefault ? join(appData, APP_SLUG) : join(appData, APP_SLUG, "profiles", profileKey);
  // 默认目录沿用原版 Electron 锁位置与程序名，让原版也能识别新版占用。
  // 自定义目录按真实路径归一化，同目录的开发版和安装版互斥，不同目录可并行。
  const lockDir = isDefault ? join(appData, APP_LEGACY_LOCK_NAME)
    : join(appData, "pi-desktop-data-locks", profileKey);
  mkdirSync(lockDir, { recursive: true });
  app.setName(APP_LEGACY_LOCK_NAME);
  app.setPath("userData", lockDir);
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    return { dataDir, hasSingleInstanceLock: false };
  }
  app.setName(APP_NAME);
  const diagnosticsDir = join(profileDir, "diagnostics");
  const crashDumpsDir = join(diagnosticsDir, "crash-dumps");
  // 不把新版 Chromium 缓存、网页 Cookie 或本地存储写入原版的 profile。
  for (const path of [profileDir, join(profileDir, "chromium"), diagnosticsDir, crashDumpsDir]) {
    mkdirSync(path, { recursive: true });
  }
  app.setPath("userData", profileDir);
  app.setPath("sessionData", join(profileDir, "chromium"));
  app.setPath("crashDumps", crashDumpsDir);
  app.setAppLogsPath(join(profileDir, "logs"));
  return { dataDir, hasSingleInstanceLock: true };
}
