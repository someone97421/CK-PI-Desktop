"use strict";

class SubscriptionPool {
  constructor(hooks) {
    this.hooks = hooks;
    this.entries = new Map();
    this.closing = new Map();
  }
  acquire(id) {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { count: 0 };
      entry.ready = (this.closing.get(id) || Promise.resolve()).then(() =>
        this.hooks.onSubscribe?.(id),
      );
      this.entries.set(id, entry);
    }
    entry.count++;
    return entry.ready;
  }
  release(id) {
    const entry = this.entries.get(id);
    if (!entry || --entry.count > 0) return;
    this.entries.delete(id);
    const closing = entry.ready.then(
      () => this.hooks.onUnsubscribe?.(id),
      () => undefined,
    );
    this.closing.set(
      id,
      closing.catch(() => undefined),
    );
    closing
      .finally(() => {
        if (!this.entries.has(id)) this.closing.delete(id);
      })
      .catch(() => undefined);
    return closing;
  }
  async clear() {
    const tasks = [];
    for (const [id, entry] of this.entries) {
      entry.count = 1;
      tasks.push(this.release(id));
    }
    await Promise.allSettled(tasks);
  }
}
module.exports = { SubscriptionPool };
