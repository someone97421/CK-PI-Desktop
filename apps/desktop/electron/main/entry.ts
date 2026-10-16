import { app, BrowserWindow } from "electron";
import { defaultDataDir, hasSingleInstanceLock, isBackupLockProcess, storageOverridden } from "./installation";
import { prepareStorage } from "./storage/bootstrap";

// installation 同步分流持锁助手并配置正常启动身份；冷维护期间不加载业务入口。
if (!isBackupLockProcess && hasSingleInstanceLock) {
  let booted = false;
  app.on("second-instance", () => {
    if (booted) return;
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  void prepareStorage(defaultDataDir, storageOverridden)
    .then(() => {
      booted = true;
      return import("./index");
    })
    .catch((error: unknown) => {
      console.error("存储启动失败", error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
}
