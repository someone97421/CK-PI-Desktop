'use strict';

const { createHash } = require('node:crypto');
const { collect, select, summarize } = require('./lib/evidence.cjs');
const cache = new Map();
const scopes = new Map();
let alive = false;
let active = null;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 64;

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

async function readHistory(id, ids, entry) {
  const selected = ids === null ? null : new Set(ids);
  if (selected?.size === 0) return { entries: [], missing: [] };
  const current = () => {
    if (!alive || entry.cancelled) fail('READ_CANCELLED', '审查读取已取消 / Review read cancelled');
  };
  const read = async (options) => {
    current();
    const result = await pi.desktop.invoke({ operation: 'session/get', args: [{ id, ...options }] });
    current();
    return result?.session;
  };
  let first = 0;
  let page;
  if (ids?.length) {
    // 宿主已有按消息定位和分页接口；从任务尾部读取，到任务首条即停止。
    // 极旧或已改写的历史找不到锚点时，仍以完整历史查找保留原有结果。
    const anchor = await read({ messageAround: ids[0], messageLimit: 1 });
    if (Number.isSafeInteger(anchor?.messageStart) && anchor.messageStart >= 0
      && anchor.messages?.some((message) => message.id === ids[0])) {
      page = await read({ messageAround: ids[ids.length - 1], messageLimit: 200 });
      if (page?.messages?.some((message) => message.id === ids[ids.length - 1])) first = anchor.messageStart;
      else page = undefined;
    }
  }
  const chunks = [];
  let before;
  while (alive) {
    page ??= await read({ messageLimit: 200, ...(before === undefined ? {} : { messageBefore: before }) });
    if (!page || !Array.isArray(page.messages)) fail('NOT_FOUND', '会话不可用 / Session unavailable');
    const entries = new Map();
    const missing = new Set();
    collect(selected ? page.messages.filter((message) => selected.has(message.id)) : page.messages, entries, missing);
    chunks.push({ entries: [...entries.values()], missing: [...missing] });
    if (page.hasMoreBefore !== true || (Number.isSafeInteger(page.messageStart) && page.messageStart <= first)) break;
    if (!Number.isSafeInteger(page.messageStart) || page.messageStart < 0
      || (before !== undefined && page.messageStart >= before)) {
      fail('INVALID_PAGE', '历史分页未前进 / Session pagination did not advance');
    }
    before = page.messageStart;
    if (before === 0) break;
    page = undefined;
  }
  current();
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

function discard(key, entry) {
  entry.cancelled = true;
  clearTimeout(entry.timer);
  if (cache.get(key) === entry) cache.delete(key);
}
function invalidate(id, wholeSessionOnly = false) {
  for (const [key, entry] of cache) {
    if (entry.id === id && (!wholeSessionOnly || entry.ids === null)) discard(key, entry);
  }
}
function history(id, ids = null, force = false) {
  if (force) invalidate(id);
  const key = JSON.stringify([id, ids]);
  let entry = cache.get(key);
  if (entry && (!entry.data || Date.now() - entry.at < CACHE_TTL_MS)) return entry;
  if (entry) discard(key, entry);
  entry = { id, ids, data: null, error: null, promise: null, at: 0, cancelled: false, timer: null };
  entry.promise = readHistory(id, ids, entry).then((data) => {
    entry.at = Date.now();
    entry.data = data;
    entry.timer = setTimeout(() => discard(key, entry), CACHE_TTL_MS);
    entry.timer.unref?.();
    return data;
  }, (error) => {
    entry.error = error;
    throw error;
  });
  entry.promise.catch(() => {});
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) {
    const [oldest, value] = cache.entries().next().value;
    discard(oldest, value);
  }
  return entry;
}

function activated(next) {
  const previous = active;
  active = next;
  for (const [key, entry] of cache) {
    if (entry.id !== next?.sessionId && !entry.data) discard(key, entry);
  }
  if (next?.sessionId && previous?.activeTurn?.turnId !== next.activeTurn?.turnId) invalidate(next.sessionId, true);
}
function turnEnded(event) {
  if (event?.sessionId) invalidate(event.sessionId, true);
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
  await pi.commands.register({ id: 'file-review.open', title: '任务文件审查增强 / Task review enhancements', run: async () => {
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
  const entry = history(id, resolveScope(id, key), args.refresh === true);
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
    const data = await history(id, payload.showAll ? null : ids, payload.refresh === true).promise;
    const selected = select(data, payload.showAll ? null : ids);
    return { local: true, sessionId: id, taskAvailable: ids !== null,
      ...selected, summary: summarize(selected) };
  }
  if (typeof payload.snapshotId !== 'string' || !payload.snapshotId) fail('INVALID_ARGUMENT', '缺少快照 / Missing snapshot');
  const result = await pi.desktop.invoke({ operation: 'workspace/review/rollback',
    args: [{ sessionId: id, snapshotId: payload.snapshotId }] });
  invalidate(id);
  return result;
}

async function onUnload() {
  alive = false;
  for (const [key, entry] of cache) discard(key, entry);
  pi.events.off('session:activated', activated);
  pi.events.off('session:turnEnded', turnEnded);
  cache.clear();
  scopes.clear();
  active = null;
  await pi.commands.unregister('file-review.open');
}

module.exports = { onLoad, onUnload, onRendererCall, onViewInvoke, onPanelInvoke: onViewInvoke };
