'use strict';

const { createHash } = require('node:crypto');
const { collect, select, summarize } = require('./lib/evidence.cjs');
const cache = new Map();
const scopes = new Map();
let alive = false;
let active = null;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function sessionId(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', '缺少会话 ID / Missing session ID');
  return value;
}
function scopeFor(id, ids) {
  if (!Array.isArray(ids) || !ids.every((value) => typeof value === 'string')) {
    fail('INVALID_ARGUMENT', '任务范围无效 / Invalid task scope');
  }
  const messageIds = [...new Set(ids)];
  const key = createHash('sha256').update(JSON.stringify([id, messageIds])).digest('hex');
  scopes.set(key, { sessionId: id, messageIds });
  while (scopes.size > 512) scopes.delete(scopes.keys().next().value);
  return key;
}
function resolveScope(id, key) {
  if (!key) return null;
  const scope = scopes.get(key);
  if (!scope || scope.sessionId !== id) fail('SCOPE_EXPIRED', '任务范围已过期，请从聊天卡片重新打开 / Reopen the task card to restore its scope');
  return scope.messageIds;
}

async function readHistory(id) {
  const chunks = [];
  let before;
  while (alive) {
    const result = await pi.desktop.invoke({ operation: 'session/get', args: [{
      id, messageLimit: 200, ...(before === undefined ? {} : { messageBefore: before }),
    }] });
    const page = result?.session;
    if (!page || !Array.isArray(page.messages)) fail('NOT_FOUND', '会话不可用 / Session unavailable');
    const entries = new Map();
    const missing = new Set();
    collect(page.messages, entries, missing);
    chunks.push({ entries: [...entries.values()], missing: [...missing] });
    if (page.hasMoreBefore !== true) break;
    if (!Number.isSafeInteger(page.messageStart) || page.messageStart < 0
      || (before !== undefined && page.messageStart >= before)) {
      fail('INVALID_PAGE', '历史分页未前进 / Session pagination did not advance');
    }
    before = page.messageStart;
    if (before === 0) break;
  }
  if (!alive) fail('PLUGIN_UNLOADED', '插件已卸载 / Plugin unloaded');
  const seen = new Set();
  return {
    entries: chunks.reverse().flatMap((chunk) => chunk.entries).filter((entry) => {
      if (seen.has(entry.snapshotId)) return false;
      seen.add(entry.snapshotId);
      return true;
    }),
    missing: chunks.flatMap((chunk) => chunk.missing),
  };
}

function history(id, force = false) {
  if (force) cache.delete(id);
  let entry = cache.get(id);
  if (entry) return entry;
  entry = { data: null, error: null, promise: null };
  entry.promise = readHistory(id).then((data) => { entry.data = data; return data; }, (error) => {
    entry.error = error;
    throw error;
  });
  entry.promise.catch(() => {});
  cache.set(id, entry);
  while (cache.size > 4) cache.delete(cache.keys().next().value);
  return entry;
}

function activated(next) {
  const previous = active;
  active = next;
  if (next?.sessionId && (previous?.sessionId !== next.sessionId
    || previous?.activeTurn?.turnId !== next.activeTurn?.turnId)) cache.delete(next.sessionId);
}
function turnEnded(event) {
  if (event?.sessionId) cache.delete(event.sessionId);
}
async function open(id, key) {
  resolveScope(id, key);
  await pi.ui.revealView({ viewId: 'review', sessionId: id,
    location: JSON.stringify({ sessionId: id, ...(key ? { scopeKey: key } : {}) }) });
  return { ok: true };
}

async function onLoad() {
  alive = true;
  pi.events.on('session:activated', activated);
  pi.events.on('session:turnEnded', turnEnded);
  active = await pi.session.getActive();
  await pi.commands.register({ id: 'file-review.open', title: '文件改动审查 / File review', run: async () => {
    const current = await pi.session.getActive();
    if (!current) fail('NO_LOCAL_SESSION', '请先打开本地会话 / Open a local session first');
    return open(current.sessionId);
  } });
}

async function onRendererCall(method, args = {}) {
  const id = sessionId(args.sessionId);
  if (method === 'review.open') return open(id, args.scopeKey);
  if (method !== 'review.summary') fail('INVALID_ARGUMENT', '未知操作 / Unknown operation');
  if (active?.sessionId !== id) return { local: false, pending: false };
  const key = scopeFor(id, args.messageIds);
  const entry = history(id, args.refresh === true);
  if (entry.error) throw entry.error;
  if (!entry.data) return { pending: true };
  return { pending: false, scopeKey: key, ...summarize(select(entry.data, resolveScope(id, key))) };
}

async function onViewInvoke(channel, payload = {}) {
  if (!['review.read', 'review.rollback'].includes(channel)) fail('INVALID_ARGUMENT', '未知操作 / Unknown operation');
  const current = await pi.session.getActive();
  if (!current || (payload.sessionId && current.sessionId !== payload.sessionId)) {
    return { local: false, sessionId: payload.sessionId || null };
  }
  const id = sessionId(payload.sessionId || current.sessionId);
  if (channel === 'review.read') {
    const ids = resolveScope(id, payload.scopeKey);
    const data = await history(id, payload.refresh === true).promise;
    const selected = select(data, payload.showAll ? null : ids);
    return { local: true, sessionId: id, taskAvailable: ids !== null,
      ...selected, summary: summarize(selected) };
  }
  if (typeof payload.snapshotId !== 'string' || !payload.snapshotId) fail('INVALID_ARGUMENT', '缺少快照 / Missing snapshot');
  const result = await pi.desktop.invoke({ operation: 'workspace/review/rollback',
    args: [{ sessionId: id, snapshotId: payload.snapshotId }] });
  cache.delete(id);
  return result;
}

async function onUnload() {
  alive = false;
  pi.events.off('session:activated', activated);
  pi.events.off('session:turnEnded', turnEnded);
  cache.clear();
  scopes.clear();
  active = null;
  await pi.commands.unregister('file-review.open');
}

module.exports = { onLoad, onUnload, onRendererCall, onViewInvoke, onPanelInvoke: onViewInvoke };
