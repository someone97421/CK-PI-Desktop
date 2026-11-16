"use strict";

/** 同一安装 Renderer 的 LAN 认证、IPC 与资源传输入口。 */

const {
  createRemoteServer,
  DEFAULT_PORT,
  MAX_WS_CONNECTIONS,
  SHUTDOWN_GRACE_MS,
  WS_PATH,
} = require("./server/index.cjs");

module.exports = {
  createRemoteServer,
  DEFAULT_PORT,
  MAX_WS_CONNECTIONS,
  SHUTDOWN_GRACE_MS,
  WS_PATH,
};
