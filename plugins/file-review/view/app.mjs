import { language, translate } from '../shared/i18n.mjs';

const root = document.getElementById('app');
const bridge = window.pluginBridge;
const themeStyle = document.createElement('style');
document.head.append(themeStyle);
let locale = 'zh-CN';
let context = {};
let showAll = true;
let data = null;
let loading = false;
let notice = null;
let sequence = 0;
let destroyed = false;
let tokenNames = [];
const expanded = new Set();
const busy = new Set();
const subscriptions = [];
const t = (key, values) => translate(locale, key, values);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(text, action, disabled = false) {
  const node = el('button', '', text);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
function counts(additions, deletions) {
  const node = el('span', 'counts');
  node.append(el('span', 'add', `+${additions}`), el('span', 'del', `−${deletions}`));
  return node;
}
function errorText(error) {
  return error?.code === 'SCOPE_EXPIRED' ? t('scopeExpired') : String(error?.message || error);
}
function diffBody(change) {
  const body = el('div', 'change-body');
  if (change.binary) body.append(el('p', 'note diff-note', t('binary')));
  if (change.truncated) body.append(el('p', 'note diff-note', t('truncated')));
  if (change.hunks.length && !change.binary) {
    const diff = el('div', 'diff');
    for (const hunk of change.hunks) {
      diff.append(el('div', 'diff-line hunk', hunk.header));
      for (const line of hunk.lines) {
        const row = el('div', `diff-line ${line.type}`);
        const sign = el('span', 'sign', line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ');
        sign.setAttribute('aria-hidden', 'true');
        row.append(sign, el('span', 'line-text', line.text));
        diff.append(row);
      }
    }
    body.append(diff);
  } else if (!change.binary && !change.truncated) body.append(el('p', 'note diff-note', t('noLines')));
  const actions = el('div', 'actions');
  if (change.state === 'rolledBack') actions.append(el('span', 'state', `✓ ${t('rolledBack')}`));
  else if (change.reversible) actions.append(button(t(busy.has(change.snapshotId) ? 'rollingBack' : 'rollback'),
    () => void rollback(change), busy.has(change.snapshotId)));
  else actions.append(el('span', 'state', t('rollbackUnavailable')));
  body.append(actions);
  return body;
}
function changeCard(change, index) {
  const details = el('details', 'change');
  details.dataset.snapshotId = change.snapshotId;
  details.dataset.state = change.state;
  details.dataset.status = change.status;
  const summary = el('summary', 'change-row');
  const mark = el('span', 'mark', { added: 'A', modified: 'M', deleted: 'D' }[change.status]);
  mark.title = t(change.status);
  summary.append(mark, el('span', 'change-name', t('number', { n: index + 1 })), counts(change.additions, change.deletions));
  summary.setAttribute('aria-label', `${t(change.status)} · ${change.path} · ${t('number', { n: index + 1 })} · +${change.additions} −${change.deletions}${change.state === 'rolledBack' ? ` · ${t('rolledBack')}` : ''}`);
  if (change.state === 'rolledBack') summary.append(el('span', 'state', t('rolledBack')));
  details.append(summary);
  if (expanded.has(change.snapshotId)) {
    details.open = true;
    details.append(diffBody(change));
  }
  details.addEventListener('toggle', () => {
    if (details.open) {
      expanded.add(change.snapshotId);
      if (!details.querySelector('.change-body')) details.append(diffBody(change));
    } else {
      expanded.delete(change.snapshotId);
      details.querySelector('.change-body')?.remove();
    }
  });
  return details;
}

function render() {
  if (destroyed) return;
  const scrollTop = document.documentElement.scrollTop;
  const fragment = document.createDocumentFragment();
  const toolbar = el('header', 'toolbar');
  const heading = el('div', 'title-row');
  heading.append(el('h1', '', t('title')), button(t('refresh'), () => void load(true), loading));
  const scope = el('div', 'scope-row');
  scope.setAttribute('role', 'group');
  scope.setAttribute('aria-label', t('scope'));
  if (context.scopeKey) {
    for (const [key, all] of [['task', false], ['session', true]]) {
      const node = button(t(key), () => { showAll = all; data = null; notice = null; void load(); });
      node.setAttribute('aria-pressed', String(showAll === all));
      scope.append(node);
    }
  } else scope.append(el('span', 'state', t('session')));
  if (data?.summary) {
    const summary = data.summary;
    const totals = el('div', 'totals');
    totals.append(el('span', '', t('files', { n: summary.fileCount })),
      el('span', 'state', t('edits', { n: summary.changeCount })), counts(summary.additions, summary.deletions));
    scope.append(totals);
  }
  toolbar.append(heading, scope);
  fragment.append(toolbar);
  const content = el('div', 'content');
  content.append(el('p', 'note', t('snapshot')));
  if (notice) {
    const feedback = el('div', 'notice', notice.text);
    feedback.dataset.tone = notice.tone;
    feedback.setAttribute('role', notice.tone === 'error' ? 'alert' : 'status');
    content.append(feedback);
  }
  if (data?.missingEvidence) content.append(el('p', 'note', t('evidence')));
  if (loading && !data) content.append(el('div', 'empty', t('loading')));
  else if (data?.local === false) content.append(el('div', 'empty', t('localOnly')));
  else if (data && !data.entries?.length) {
    const empty = el('div', 'empty');
    empty.append(el('span', 'empty-symbol', '±'), el('span', '', t(showAll ? 'empty' : 'taskEmpty')));
    content.append(empty);
  } else if (data?.entries) {
    const grouped = new Map();
    for (const change of data.entries) {
      if (!grouped.has(change.path)) grouped.set(change.path, []);
      grouped.get(change.path).push(change);
    }
    for (const [path, changes] of grouped) {
      const group = el('section', 'file-group');
      const title = el('h2', 'file-heading');
      const pathNode = el('span', 'file-path', path);
      pathNode.title = path;
      title.append(pathNode, el('span', 'file-meta', t('edits', { n: changes.length })));
      group.append(title);
      changes.forEach((change, index) => group.append(changeCard(change, index)));
      content.append(group);
    }
  }
  fragment.append(content);
  root.replaceChildren(fragment);
  root.setAttribute('aria-busy', String(loading));
  document.documentElement.scrollTop = scrollTop;
}

async function load(refresh = false) {
  const version = ++sequence;
  loading = true;
  render();
  try {
    if (!bridge) throw new Error(t('bridgeMissing'));
    const result = await bridge.invoke('review.read', { ...context, showAll, refresh });
    if (version !== sequence || destroyed) return;
    data = result;
    if (result.sessionId) context.sessionId = result.sessionId;
  } catch (error) {
    if (version !== sequence || destroyed) return;
    data = null;
    notice = { tone: 'error', text: `${t('error')}: ${errorText(error)}` };
  } finally {
    if (version === sequence && !destroyed) { loading = false; render(); }
  }
}

async function rollback(change) {
  if (busy.has(change.snapshotId)) return;
  const requestedContext = JSON.stringify(context);
  busy.add(change.snapshotId);
  notice = null;
  render();
  try {
    const outcome = await bridge.invoke('review.rollback', { sessionId: context.sessionId, snapshotId: change.snapshotId });
    if (destroyed || requestedContext !== JSON.stringify(context)) return;
    const status = outcome.status;
    const success = status === 'rolledBack' || status === 'alreadyRolledBack';
    const key = { rolledBack: 'success', alreadyRolledBack: 'alreadyRolledBack', conflict: 'conflict', unavailable: 'unavailable' }[status] || 'unknownStatus';
    notice = { tone: success ? 'info' : 'error', text: `${change.path}\n${t(key)}` };
    if (success) {
      for (const entry of data?.entries || []) {
        if (entry.snapshotId === change.snapshotId) entry.state = 'rolledBack';
      }
      await load();
    }
  } catch (error) {
    if (!destroyed && requestedContext === JSON.stringify(context)) notice = { tone: 'error', text: `${t('rollbackError')}: ${errorText(error)}` };
  } finally {
    busy.delete(change.snapshotId);
    render();
  }
}

function applyAppearance(appearance) {
  const base = appearance?.base;
  document.documentElement.dataset.base = base === 'light' || base === 'dark' ? base
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  locale = language(appearance?.locale || locale);
  document.documentElement.lang = locale;
  document.title = t('title');
  themeStyle.textContent = appearance?.pluginTheme?.css || '';
  tokenNames.forEach((name) => document.documentElement.style.removeProperty(name));
  tokenNames = [];
  for (const [name, value] of Object.entries(appearance?.tokens || {})) {
    if (name.startsWith('--') && typeof value === 'string') {
      document.documentElement.style.setProperty(name, value);
      tokenNames.push(name);
    }
  }
  render();
}
function openLocation(value) {
  try {
    const location = typeof value === 'string' ? value : value?.location;
    if (!location) return;
    const next = JSON.parse(location);
    context = { sessionId: next.sessionId, ...(next.scopeKey ? { scopeKey: next.scopeKey } : {}) };
    showAll = !next.scopeKey;
    data = null;
    notice = null;
    expanded.clear();
    document.documentElement.scrollTop = 0;
    void load();
  } catch (error) {
    notice = { tone: 'error', text: `${t('error')}: ${errorText(error)}` };
    render();
  }
}
function activated(next) {
  if (!next || (context.sessionId && next.sessionId !== context.sessionId)) {
    ++sequence;
    data = { local: false };
    loading = false;
    render();
    return;
  }
  if (!next.activeTurn) void load(true);
}
function listen(name, handler) {
  if (!bridge) return;
  const disposer = bridge.on(name, handler);
  subscriptions.push(typeof disposer === 'function' ? disposer : () => bridge.off?.(name, handler));
}
listen('appearance:changed', applyAppearance);
listen('view:open', openLocation);
listen('session:activated', activated);
window.addEventListener('beforeunload', () => {
  destroyed = true;
  ++sequence;
  subscriptions.splice(0).forEach((dispose) => dispose());
}, { once: true });
applyAppearance(null);
bridge?.invoke('app.getAppearance').then(applyAppearance).catch(() => {});
const initial = new URLSearchParams(location.search).get('piViewOpen');
if (initial) openLocation(initial);
else void load();
