import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  downloadStarts = [];
  cancellations = [];

  async checkForUpdates() {
    this.emit("checking-for-update");
    const info = {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload
      ? (this.downloadStarts.push(info.version), Promise.resolve([]))
      : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  quitAndInstall() {}
}

function createController({ updater, settings = {}, persist = async () => {} }) {
  const logger = { app: () => {} };
  const sent = [];
  const controller = new AppUpdaterController({
    logger,
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform: "win32",
    distribution: "installed",
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => settings,
    persistDismissedVersion: persist,
  });
  return { controller, sent };
}

test("dismissing an in-app update cancels its download and disables install on quit", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const { controller } = createController({
    updater,
    persist: async (version) => persisted.push(version),
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
  assert.equal(controller.getState().status, "downloading");

  await controller.dismiss();

  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, "available");
  assert.equal(controller.getState().dismissed, true);
  assert.deepEqual(persisted, ["0.16.1"]);
  controller.dispose();
});

test("a restored dismissal blocks that release and a newer release resumes automatic delivery", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  let clearDismissal;
  const cleared = new Promise((resolve) => {
    clearDismissal = resolve;
  });
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.1" },
    persist: async (version) => {
      persisted.push(version);
      if (version === null) clearDismissal();
    },
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().dismissed, true);

  updater.nextVersion = "0.16.2";
  await controller.check();
  await cleared;
  assert.deepEqual(updater.downloadStarts, ["0.16.2"]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(controller.getState().dismissed, false);
  assert.deepEqual(persisted, [null]);
  controller.dispose();
});

test("更新文件缺失时界面和手动检查只显示简短提示，完整错误留在日志", async () => {
  const updater = new FakeUpdater();
  const logs = [];
  const error = Object.assign(new Error("Cannot find latest-mac.yml: HttpError: 404\nHeaders: private diagnostics\n at updater"), {
    code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  });
  updater.checkForUpdates = async () => {
    updater.emit("checking-for-update");
    updater.emit("error", error);
    throw error;
  };
  const controller = new AppUpdaterController({
    logger: { app: (...args) => logs.push(args) },
    send: () => {}, currentVersion: "2610.713.2345", platform: "darwin", isPackaged: true,
    autoUpdater: updater, getLocale: () => "zh-CN",
  });
  await assert.rejects(controller.check({ manual: true }), /发布版本缺少更新描述文件/);
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().error, "发布版本缺少更新描述文件，请前往 GitHub 下载或稍后重试。");
  assert.match(JSON.stringify(logs), /private diagnostics/);
  controller.dispose();
});

test("普通更新错误只展示首行，自动检查仍保持错误状态", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => {
    const error = new Error("Network unavailable\nHeaders: internal details");
    updater.emit("error", error);
    throw error;
  };
  const { controller } = createController({ updater });
  await controller.check();
  assert.equal(controller.getState().error, "Network unavailable");
  controller.dispose();
});
