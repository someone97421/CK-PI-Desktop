import { EventEmitter } from "node:events";

export class StubAutoUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
}

export class NsisUpdater extends StubAutoUpdater {
  app = { getAppPath: () => process.cwd() };
}

export const autoUpdater = new StubAutoUpdater();

export default { NsisUpdater, autoUpdater };
