"use strict";

const sessions = new Map();
const clients = new Map();
const bindChains = new Map();
let appearance = null;
let locale = "en";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}


async function desktop(operation, args = [], confirm = false) {
  return pi.desktop.invoke({ operation, args, ...(confirm ? { confirm: true } : {}) });
}

async function readAppearance() {
  try {
    const value = await pi.app.getAppearance();
    if (value && typeof value === "object") appearance = value;
  } catch {
    // Older hosts can still use prefers-color-scheme in the view.
  }
  try {
    locale = (await pi.app.getLocale()) || "en";
  } catch {
    locale = "en";
  }
  return { appearance, locale };
}

function stateFor(sessionId) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      subscriptionId: "",
      revision: 0,
      terminalRevision: 0,
      lastAt: "",
      pendingTimer: null,
      clients: new Set(),
    };
    sessions.set(sessionId, state);
  }
  return state;
}

function noteEvent(frame) {
  if (!frame || typeof frame !== "object") return;
  const sessionId = text(frame.sessionId);
  const state = sessions.get(sessionId);
  if (!state || (state.subscriptionId && frame.subscriptionId !== state.subscriptionId)) return;
  state.lastAt = text(frame.at) || new Date().toISOString();

  const eventType = frame.kind === "agent.event" && frame.payload && typeof frame.payload === "object"
    ? frame.payload.event?.type
    : "";
  const terminal = frame.kind === "agent.turnEnded" || eventType === "message_end" || eventType === "tool_execution_end" || eventType === "tool_end" || eventType === "tool_error";
  if (terminal) {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
    state.revision += 1;
    state.terminalRevision = state.revision;
    return;
  }
  if (!state.pendingTimer) {
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      state.revision += 1;
    }, 300);
  }
}

async function subscribe(sessionId, clientId) {
  const state = stateFor(sessionId);
  state.clients.add(clientId);
  if (!state.subscription) {
    state.subscription = pi.desktop.subscribe({ sessionId }).then((result) => {
      state.subscriptionId = text(result?.subscriptionId);
      state.revision += 1;
    }).catch((error) => { state.subscription = null; throw error; });
  }
  await state.subscription;
  return state;
}

async function releaseClient(clientId) {
  const sessionId = clients.get(clientId);
  clients.delete(clientId);
  if (!sessionId) return;
  const state = sessions.get(sessionId);
  if (!state) return;
  state.clients.delete(clientId);
  if (state.clients.size) return;
  sessions.delete(sessionId);
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  try {
    await state.subscription;
    if (state.subscriptionId) await pi.desktop.unsubscribe(state.subscriptionId);
  } catch {
    // 卸载时宿主也会清理订阅。
  }
}

async function bindNow(payload) {
  const clientId = text(payload?.clientId);
  const sessionId = text(payload?.sessionId);
  if (!clientId || !sessionId) throw new Error("clientId and sessionId are required");
  const previous = clients.get(clientId);
  if (previous && previous !== sessionId) await releaseClient(clientId);
  clients.set(clientId, sessionId);
  const state = await subscribe(sessionId, clientId);
  return {
    ok: true,
    sessionId,
    revision: state.revision,
    terminalRevision: state.terminalRevision,
    ...await readAppearance(),
  };
}

function withClient(clientId, operation) {
  const previous = bindChains.get(clientId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  bindChains.set(clientId, next);
  void next.then(
    () => { if (bindChains.get(clientId) === next) bindChains.delete(clientId); },
    () => { if (bindChains.get(clientId) === next) bindChains.delete(clientId); },
  );
  return next;
}

function bind(payload) {
  return withClient(text(payload?.clientId), () => bindNow(payload));
}

async function onLoad() {
  await readAppearance();
  pi.events.on("desktop:event", noteEvent);
}

async function onPanelInvoke(channel, payload = {}) {
  switch (channel) {
    case "observer.bootstrap":
      return { ok: true, sessionId: text(payload.sessionId), ...await readAppearance() };
    case "observer.bind":
      return bind(payload);
    case "observer.unbind":
      await withClient(text(payload.clientId), () => releaseClient(text(payload.clientId)));
      return { ok: true };
    case "observer.poll": {
      const sessionId = text(payload.sessionId);
      const state = sessions.get(sessionId);
      return {
        ok: true,
        revision: state?.revision || 0,
        terminalRevision: state?.terminalRevision || 0,
        lastAt: state?.lastAt || "",
      };
    }
    case "observer.history": {
      const sessionId = text(payload.sessionId);
      if (!sessionId) throw new Error("sessionId is required");
      const input = { id: sessionId, messageLimit: 200 };
      if (Number.isSafeInteger(payload.messageBefore) && payload.messageBefore >= 0) input.messageBefore = payload.messageBefore;
      return desktop("session/get", [input]);
    }
    case "observer.snapshot": {
      const sessionId = text(payload.sessionId);
      if (!sessionId) throw new Error("sessionId is required");
      return pi.desktop.getSessionSnapshot({ sessionId });
    }
    case "observer.recall": {
      const sessionId = text(payload.sessionId);
      const delegationId = text(payload.delegationId);
      if (!sessionId || !delegationId) throw new Error("sessionId and delegationId are required");
      return desktop("subagent/recallStatus", [{ sessionId, delegationId }]);
    }
    case "observer.stop": {
      const sessionId = text(payload.sessionId);
      const delegationId = text(payload.delegationId);
      if (!sessionId || !delegationId) throw new Error("sessionId and delegationId are required");
      const input = { sessionId, delegationId };
      if (Number.isSafeInteger(payload.expectedExecution)) input.expectedExecution = payload.expectedExecution;
      return desktop("subagent/stop", [input]);
    }
    case "observer.appearance":
      return { ok: true, ...await readAppearance() };
    default: {
      const error = new Error(`Unsupported observer channel: ${channel}`);
      error.code = "UNSUPPORTED";
      throw error;
    }
  }
}

async function onUnload() {
  pi.events.off("desktop:event", noteEvent);
  await Promise.allSettled([...bindChains.values()]);
  await Promise.allSettled([...clients.keys()].map(releaseClient));
  sessions.clear();
  clients.clear();
  bindChains.clear();
}

module.exports = { onLoad, onPanelInvoke, onUnload };
