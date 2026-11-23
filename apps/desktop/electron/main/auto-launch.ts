import { app } from "electron";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { APP_NAME } from "@pi-desktop/shared";

export function setAutoLaunch(enabled: boolean): void {
  if (!app.isPackaged) throw new Error("开机自动启动仅支持打包后的应用");

  if (process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    const { openAtLogin, status } = app.getLoginItemSettings();
    const registered = openAtLogin || status === "requires-approval";
    if (registered !== enabled) throw new Error("无法更新 macOS 登录项");
    return;
  }

  if (process.platform === "win32") {
    const path = process.env.PORTABLE_EXECUTABLE_FILE?.trim() || process.execPath;
    app.setLoginItemSettings({ openAtLogin: enabled, path });
    if (app.getLoginItemSettings({ path }).openAtLogin !== enabled) {
      throw new Error("无法更新 Windows 启动项");
    }
    return;
  }

  if (process.platform === "linux") {
    const configHome = process.env.XDG_CONFIG_HOME;
    const directory = join(configHome && isAbsolute(configHome) ? configHome : join(homedir(), ".config"), "autostart");
    const entry = join(directory, "this-is-a-agent.desktop");
    if (!enabled) {
      rmSync(entry, { force: true });
      return;
    }
    const executable = process.env.APPIMAGE || process.execPath;
    const quotedExec = executable
      .replace(/[%]/g, "%%")
      .replace(/["`$\\]/g, "\\$&")
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    mkdirSync(directory, { recursive: true });
    writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="${quotedExec}"\n`);
  }
}
