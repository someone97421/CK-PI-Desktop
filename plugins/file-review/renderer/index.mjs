import React, { useEffect, useState } from 'react';
import { translate } from '../shared/i18n.mjs';

const h = React.createElement;
const dispose = [];

export function onLoad(pi) {
  function TaskReviewEntry({ sessionId, task }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [locale, setLocale] = useState(document.documentElement.lang);
    useEffect(() => {
      const observer = new MutationObserver(() => setLocale(document.documentElement.lang));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      return () => observer.disconnect();
    }, []);
    if (!task?.settled || !task.messageIds?.length || sessionId?.startsWith('remote:')) return null;
    const open = async () => {
      if (busy) return;
      setBusy(true);
      setError('');
      try {
        await pi.dispatch('plugin.call', {
          method: 'review.open', args: { sessionId, messageIds: task.messageIds },
        });
      } catch (reason) {
        setError(String(reason?.message || reason));
      } finally {
        setBusy(false);
      }
    };
    return h('button', {
      type: 'button', className: 'fr-open-enhanced', onClick: open,
      disabled: busy, title: error || translate(locale, 'title'),
    }, translate(locale, 'reviewEnhanced'));
  }
  dispose.push(pi.ui.injectStyle(`
    .fr-open-enhanced{margin-top:8px;border:0;background:transparent;color:var(--color-text-muted,inherit);font:inherit;cursor:pointer;padding:4px 0}
    .fr-open-enhanced:hover{color:var(--color-text-primary,inherit)}.fr-open-enhanced:disabled{opacity:.5;cursor:default}
    .fr-open-enhanced:focus-visible{outline:2px solid var(--color-accent,currentColor);outline-offset:2px}
  `));
  dispose.push(pi.slots.register({ slot: 'entryExtra', component: TaskReviewEntry }));
}

export function onUnload() {
  dispose.splice(0).reverse().forEach((fn) => fn());
}
