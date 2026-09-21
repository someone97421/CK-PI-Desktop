"use strict";

const { renderSupervision, handleSupervisionAction } = require("./supervision");
const stopRequests = new Set();
const actions = new Map();
const helpers = {
  desktopInvoke: (operation, args = []) => pi.desktop.invoke({ operation, args }),
  getSessionSnapshot: (input) => pi.desktop.getSessionSnapshot(input),
};

function executionKey(context) {
  return JSON.stringify([context.sessionId, context.delegationId, context.execution ?? context.collaboration?.execution]);
}

function render(context) {
  const key = executionKey(context);
  if (!context.running || !context.live || context.collaboration?.phase === "finished") stopRequests.delete(key);
  return renderSupervision({ ...context, requested: stopRequests.has(key) }, helpers);
}

async function onPanelInvoke(channel, payload = {}) {
  if (payload.viewId !== "supervision") throw new Error("Unknown inline view");
  const context = payload.context;
  if (channel === "inline.render") return render(context);
  if (channel !== "inline.action") throw new Error(`Unsupported inline view channel: ${channel}`);
  const key = executionKey(context);
  if (actions.has(key)) {
    await actions.get(key);
    return render(context);
  }
  if (payload.action === "stop" && stopRequests.has(key)) return render(context);
  const operation = (async () => {
    if (payload.action === "stop") stopRequests.add(key);
    try {
      await handleSupervisionAction(context, payload.action, helpers);
    } catch (error) {
      stopRequests.delete(key);
      throw error;
    }
  })();
  actions.set(key, operation);
  try {
    await operation;
    return await render(context);
  } finally {
    actions.delete(key);
  }
}

function onUnload() { stopRequests.clear(); actions.clear(); }
module.exports = { onPanelInvoke, onUnload };
