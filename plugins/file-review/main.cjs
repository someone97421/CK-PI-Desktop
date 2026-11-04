'use strict';

const { collect, summarize } = require('./lib/evidence.cjs');
const cache = new Map();
let alive = false;
let active = null;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 16;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function sessionId(value) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENT', '缺少会话 ID / Missing session ID');
  return value;
}

async function readHistory(id, entry) {
  const current = () => {
    if (!alive || entry.cancelled) fail('READ_CANCELLED', '审查读取已取消 / Review read cancelled');
  };
  const chunks = [];
  let before;
  while (alive) {
    current();
    const result = await pi.desktop.invoke({ operation: 'session/get',
      args: [{ id, messageLimit: 200, ...(before === undefined ? {} : { messageBefore: before }) }] });
    current();
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
  current();
  const seen = new Set();
  return {
    entries: chunks.reverse().flatMap((chunk) => chunk.entries).filter((entry) => {
      if (seen.has(entry.snapshotId)) return false;
      seen.add(entry.snapshotId);
      return true;
    }),
    missingEvidence: chunks.some((chunk) => chunk.missing.length > 0),
  };
}

function discard(id, entry) {
  entry.cancelled = true;
  clearTimeout(entry.timer);
  if (cache.get(id) === entry) cache.delete(id);
}
function invalidate(id) {
  const entry = cache.get(id);
  if (entry) discard(id, entry);
}
function history(id, force = false) {
  if (force) invalidate(id);
  let entry = cache.get(id);
  if (entry && (!entry.data || Date.now() - entry.at < CACHE_TTL_MS)) return entry;
  if (entry) discard(id, entry);
  entry = { data: null, promise: null, at: 0, cancelled: false, timer: null };
  entry.promise = readHistory(id, entry).then((data) => {
    entry.at = Date.now();
    entry.data = data;
    entry.timer = setTimeout(() => discard(id, entry), CACHE_TTL_MS);
    entry.timer.unref?.();
    return data;
  });
  entry.promise.catch(() => {});
  cache.set(id, entry);
  while (cache.size > CACHE_LIMIT) {
    const [oldest, value] = cache.entries().next().value;
    discard(oldest, value);
  }
  return entry;
}

function activated(next) {
  const previous = active;
  active = next;
  for (const [id, entry] of cache) {
    if (id !== next?.sessionId && !entry.data) discard(id, entry);
  }
  if (next?.sessionId && previous?.activeTurn?.turnId !== next.activeTurn?.turnId) invalidate(next.sessionId);
}
function turnEnded(event) {
  if (event?.sessionId) invalidate(event.sessionId);
}

async function onLoad() {
  alive = true;
  pi.events.on('session:activated', activated);
  pi.events.on('session:turnEnded', turnEnded);
  active = await pi.session.getActive();
  await pi.commands.register({ id: 'file-review.open', title: '整会话文件审查 / Session file review', run: async () => {
    const current = await pi.session.getActive();
    if (!current) fail('NO_LOCAL_SESSION', '请先打开本地会话 / Open a local session first');
    await pi.ui.revealView({ viewId: 'review', sessionId: current.sessionId,
      location: JSON.stringify({ sessionId: current.sessionId }) });
    return { ok: true };
  } });
}

async function onViewInvoke(channel, payload = {}) {
  if (!['review.read', 'review.rollback'].includes(channel)) fail('INVALID_ARGUMENT', '未知操作 / Unknown operation');
  const current = await pi.session.getActive();
  if (!current || (payload.sessionId && current.sessionId !== payload.sessionId)) {
    return { local: false, sessionId: payload.sessionId || null };
  }
  const id = sessionId(payload.sessionId || current.sessionId);
  if (channel === 'review.read') {
    const data = await history(id, payload.refresh === true).promise;
    return { local: true, sessionId: id, ...data, summary: summarize(data.entries) };
  }
  if (typeof payload.snapshotId !== 'string' || !payload.snapshotId) fail('INVALID_ARGUMENT', '缺少快照 / Missing snapshot');
  const result = await pi.desktop.invoke({ operation: 'workspace/review/rollback',
    args: [{ sessionId: id, snapshotId: payload.snapshotId }] });
  invalidate(id);
  return result;
}

async function onUnload() {
  alive = false;
  for (const [id, entry] of cache) discard(id, entry);
  pi.events.off('session:activated', activated);
  pi.events.off('session:turnEnded', turnEnded);
  cache.clear();
  active = null;
  await pi.commands.unregister('file-review.open');
}

module.exports = { onLoad, onUnload, onViewInvoke, onPanelInvoke: onViewInvoke };
