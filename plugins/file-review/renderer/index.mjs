import React, { useEffect, useState } from 'react';
import { translate } from '../shared/i18n.mjs';

const h = React.createElement;
let api;
let loaded = false;
let queueTimer;
let working = false;
const queue = [];
const dispose = [];

function pump() {
  queueTimer = undefined;
  if (!loaded || working || !queue.length) return;
  working = true;
  const item = queue.shift();
  api.dispatch('plugin.call', { method: item.method, args: item.args })
    .then(item.resolve, item.reject).finally(() => {
      working = false;
      if (loaded) queueTimer = setTimeout(pump, 180);
    });
}
function call(method, args) {
  return new Promise((resolve, reject) => {
    if (!loaded) return reject(new Error('Plugin unloaded'));
    queue.push({ method, args, resolve, reject });
    if (!working && !queueTimer) pump();
  });
}

function TaskReview({ sessionId, task }) {
  const settled = task?.settled === true;
  const ids = JSON.stringify(task?.messageIds || []);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
  const [locale, setLocale] = useState(document.documentElement.lang);
  const t = (key, values) => translate(locale, key, values);
  useEffect(() => {
    const observer = new MutationObserver(() => setLocale(document.documentElement.lang));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    let retry;
    setSummary(null);
    setError('');
    const fetch = async (refresh = false) => {
      try {
        const result = await call('review.summary', { sessionId, messageIds: JSON.parse(ids), refresh });
        if (cancelled) return;
        if (result.pending) retry = setTimeout(() => void fetch(), 1000);
        else setSummary(result);
      } catch (reason) {
        if (!cancelled) setError(String(reason?.message || reason));
      }
    };
    void fetch(attempt > 0);
    return () => { cancelled = true; clearTimeout(retry); };
  }, [sessionId, ids, settled, attempt]);
  if (!settled || summary?.local === false) return null;
  const open = async () => {
    setOpening(true);
    setError('');
    try { await call('review.open', { sessionId, scopeKey: summary.scopeKey }); }
    catch (reason) { setError(String(reason?.message || reason)); }
    finally { setOpening(false); }
  };
  return h('section', { className: 'fr-task', 'aria-label': t('title') },
    h('div', { className: 'fr-heading' },
      h('span', { className: 'fr-glyph', 'aria-hidden': true }, '±'),
      h('span', null, summary ? summary.fileCount ? t('files', { n: summary.fileCount }) : t('taskEmpty') : t('loading')),
      summary?.changeCount ? h('span', { className: 'fr-counts' },
        h('span', { className: 'fr-add' }, `+${summary.additions}`),
        h('span', { className: 'fr-del' }, `−${summary.deletions}`)) : null,
      h('button', { type: 'button', className: 'fr-open', onClick: open,
        disabled: !summary || !summary.fileCount || opening }, t('review'))),
    summary?.missingEvidence ? h('p', { className: 'fr-note' }, t('evidence')) : null,
    summary?.files.length ? h('ul', { className: 'fr-files' }, summary.files.map((file, index) =>
      h('li', { key: index }, h('span', { title: file.path, className: 'fr-path' }, file.path),
        h('span', { className: 'fr-muted' }, t('edits', { n: file.changes }))))) : null,
    summary?.fileCount > summary.files.length ? h('p', { className: 'fr-note' }, t('more', { n: summary.fileCount - summary.files.length })) : null,
    error ? h('div', { className: 'fr-error', role: 'status' }, `${t('error')}: ${error} `,
      h('button', { type: 'button', onClick: () => setAttempt((value) => value + 1) }, t('retry'))) : null);
}

export function onLoad(pi) {
  api = pi;
  loaded = true;
  dispose.push(pi.ui.injectStyle(`
    .fr-task{margin:12px 0;border:1px solid var(--color-border-default,#8883);border-radius:var(--radius-sm,10px);padding:12px;color:var(--color-text-primary,inherit);font-size:var(--text-md,13px)}
    .fr-heading{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.fr-glyph{font:600 18px var(--font-mono,monospace)}
    .fr-open{margin-left:auto}.fr-task button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--color-border-default,#8883);border-radius:var(--radius-xs,8px);background:var(--color-bg-secondary,transparent);padding:4px 9px}
    .fr-task button:hover{background:var(--color-bg-hover,#8881)}.fr-task button:disabled{opacity:.45;cursor:default}.fr-task button:focus-visible{outline:2px solid var(--color-accent,currentColor);outline-offset:2px}
    .fr-files{list-style:none;padding:0;margin:9px 0 0}.fr-files li{display:flex;gap:12px;justify-content:space-between;padding:3px 0}.fr-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-family:var(--font-mono,monospace)}
    .fr-muted,.fr-note{color:var(--color-text-muted,#888);font-size:var(--text-sm,12px)}.fr-muted{flex:none}.fr-note{margin:8px 0 0;line-height:1.5}.fr-counts{display:flex;gap:7px;font-family:var(--font-mono,monospace)}.fr-add{color:var(--color-success,#238b55)}.fr-del,.fr-error{color:var(--color-error,#cd5555)}.fr-error{margin-top:8px;overflow-wrap:anywhere}
  `));
  dispose.push(pi.slots.register({ slot: 'entryExtra', component: TaskReview }));
}
export function onUnload() {
  loaded = false;
  clearTimeout(queueTimer);
  queueTimer = undefined;
  queue.splice(0).forEach((item) => item.reject(new Error('Plugin unloaded')));
  dispose.splice(0).reverse().forEach((fn) => fn());
  api = undefined;
}
