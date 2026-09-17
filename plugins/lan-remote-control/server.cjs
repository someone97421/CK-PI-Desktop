"use strict";

/**
 * LAN remote control — network service entry point.
 *
 * `main.cjs` requires this module; tests can require it directly and pass their
 * own options. Everything network-facing lives under `server/`.
 *
 *   const { createRemoteServer } = require("./server.cjs");
 *   const server = createRemoteServer({ webDir, dataDir, getAdapter, ... });
 *   await server.start({ address: "192.168.1.5", port: 7878 });
 */

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
