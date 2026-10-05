"use strict";
const { ComputerUseRuntime } = require("./runtime");
const { prepareService, stopService } = require("./cua");

class MacRuntime extends ComputerUseRuntime {
  async _startChild() {
    try {
      await prepareService();
      if (this.stoppedByUser) throw new Error("启动已取消。");
      await super._startChild();
    } catch (error) {
      if (this.stoppedByUser) stopService();
      throw error;
    }
  }
  stop(reason) {
    super.stop(reason);
    stopService();
  }
}
module.exports = { MacRuntime };
