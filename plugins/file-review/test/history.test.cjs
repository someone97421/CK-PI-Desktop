'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { join } = require('node:path');
const vm = require('node:vm');

async function fixture(t, count = 1000) {
  const messages = Array.from({ length: count }, (_, index) => index % 10 ? {
    id: `m${index}`, role: 'assistant', content: '正文',
  } : {
    id: `m${index}`, role: 'tool', toolName: 'Edit', toolStatus: 'success',
    toolResult: { details: { root: 'workspace', review: {
      version: 1, snapshotId: `s${index}`, messageId: `m${index}`, path: 'file.ts',
      operation: 'edit', status: 'modified', state: 'active', additions: 1, deletions: 0,
      hunks: [], reversible: true,
    } } },
  });
  let active = { sessionId: 'a', activeTurn: null }, gate;
  const events = new EventEmitter(), calls = [];
  const pi = {
    events, session: { getActive: async () => active },
    commands: { register: async () => {}, unregister: async () => {} },
    ui: { revealView: async () => {} },
    desktop: { invoke: async ({ operation, args: [input] }) => {
      if (operation === 'workspace/review/rollback') {
        for (const message of messages) if (message.toolResult?.details.review.snapshotId === input.snapshotId) {
          message.toolResult.details.review.state = 'rolledBack';
        }
        return { status: 'rolledBack' };
      }
      assert.equal(operation, 'session/get');
      calls.push(input);
      if (gate) await gate;
      const position = input.messageAround === undefined ? null : messages.findIndex((message) => message.id === input.messageAround);
      if (position === -1) return { session: null };
      const end = position === null ? input.messageBefore ?? messages.length
        : Math.min(messages.length, position + Math.floor(input.messageLimit / 2) + 1);
      const start = Math.max(0, end - input.messageLimit);
      return { session: { messages: messages.slice(start, end), messageStart: start, messageEnd: end,
        hasMoreBefore: start > 0, hasMoreAfter: end < messages.length } };
    } },
  };
  const path = join(__dirname, '..', 'main.cjs');
  const context = { module: { exports: {} }, require: createRequire(path), pi, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync(path, 'utf8'), context, { filename: path });
  const plugin = context.module.exports;
  await plugin.onLoad();
  t.after(() => plugin.onUnload());
  const read = (refresh = false) => plugin.onViewInvoke('review.read', { sessionId: 'a', refresh });
  return { plugin, calls, read, gate: (value) => { gate = value; },
    activate(id) { active = id ? { sessionId: id, activeTurn: null } : null; events.emit('session:activated', active); } };
}

test('整会话分页读取全部记录，并在缓存期内跨会话切换复用', async (t) => {
  const h = await fixture(t, 1000);
  const whole = await h.read();
  assert.equal(whole.entries.length, 100);
  assert.equal(whole.summary.fileCount, 1);
  assert.equal(whole.summary.changeCount, 100);
  assert.equal(whole.missingEvidence, false);
  const calls = h.calls.length;
  assert(h.calls.every((call) => call.messageLimit === 200 && call.messageAround === undefined));
  h.activate('b'); h.activate('a');
  assert.equal((await h.read()).entries.length, 100);
  assert.equal(h.calls.length, calls);
});

test('撤销使整会话缓存失效，重新读取得到撤销状态', async (t) => {
  const h = await fixture(t);
  await h.read();
  await h.plugin.onViewInvoke('review.rollback', { sessionId: 'a', snapshotId: 's500' });
  const refreshed = await h.read();
  assert.equal(refreshed.entries.find((entry) => entry.snapshotId === 's500').state, 'rolledBack');
});

test('切换会话后停止在途历史的后续分页', async (t) => {
  const h = await fixture(t);
  const gate = Promise.withResolvers(); h.gate(gate.promise);
  const pending = h.read();
  const rejected = assert.rejects(pending, { code: 'READ_CANCELLED' });
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  h.activate('b'); gate.resolve();
  await rejected;
  assert.equal(h.calls.length, 1);
});
