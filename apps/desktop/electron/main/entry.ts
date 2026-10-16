import { app, BrowserWindow, dialog } from "electron";
import { defaultDataDir, hasSingleInstanceLock, isBackupLockProcess, storageOverridden } from "./installation";
import { prepareStorage } from "./storage/bootstrap";
import { registerPluginSchemes } from "./plugin-schemes";
import { reportMainProcessError } from "./main-process-errors";
import { redactValue } from "./logger";

// installation 同步分流持锁助手并配置正常启动身份；冷维护期间不加载业务入口。
if (!isBackupLockProcess && hasSingleInstanceLock) {
  // 动态加载业务入口可能晚于 ready，协议权限必须在同步入口一次性注册。
  registerPluginSchemes();
  let booted = false;
  app.on("second-instance", () => {
    if (booted) return;
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  void prepareStorage(defaultDataDir, storageOverridden)
    .then(async () => {
      await import("./index");
      booted = true;
    })
    .catch((error: unknown) => {
      const record = reportMainProcessError("unhandledRejection", error);
      try {
        dialog.showErrorBox("应用启动失败", String(redactValue(record.detail)));
      } finally {
        app.exit(1);
      }
    });
}
