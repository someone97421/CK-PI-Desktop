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
  const ids = (start, end) => messages.slice(start, end).map((message) => message.id);
  const summary = async (messageIds) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await plugin.onRendererCall('review.summary', { sessionId: 'a', messageIds });
      if (!result.pending) return result;
      await new Promise(setImmediate);
    }
    throw new Error('审查摘要未结束');
  };
  return { plugin, calls, ids, summary, gate: (value) => { gate = value; },
    activate(id) { active = id ? { sessionId: id, activeTurn: null } : null; events.emit('session:activated', active); } };
}

test('长会话里的短任务只定位并读取附近分页，结果跨会话切换复用', async (t) => {
  const h = await fixture(t, 10000);
  const ids = h.ids(500, 510);
  const result = await h.summary(ids);
  assert.equal(result.changeCount, 1);
  assert.equal(h.calls.length, 2);
  assert(h.calls.reduce((sum, call) => sum + call.messageLimit, 0) <= 201);
  h.activate('b'); h.activate('a');
  assert.equal((await h.summary(ids)).changeCount, 1);
  assert.equal(h.calls.length, 2);
});

test('长任务完整跨页，只有显式整会话视图读取全部记录', async (t) => {
  const h = await fixture(t);
  const result = await h.summary(h.ids(250, 750));
  assert.equal(result.changeCount, 50);
  assert(h.calls.length < 6);
  const task = await h.plugin.onViewInvoke('review.read', { sessionId: 'a', scopeKey: result.scopeKey });
  assert.equal(task.entries.length, 50);
  const whole = await h.plugin.onViewInvoke('review.read', { sessionId: 'a', scopeKey: result.scopeKey, showAll: true });
  assert.equal(whole.entries.length, 100);
});

test('缺失旧消息锚点仍回退查找，不遗漏剩余审查证据', async (t) => {
  const h = await fixture(t);
  const result = await h.summary(['missing', 'm500']);
  assert.equal(result.changeCount, 1);
  assert(h.calls.length > 2);
});

test('撤销使任务缓存失效，重新读取得到撤销状态', async (t) => {
  const h = await fixture(t);
  const result = await h.summary(h.ids(500, 510));
  await h.plugin.onViewInvoke('review.rollback', { sessionId: 'a', snapshotId: 's500' });
  const refreshed = await h.plugin.onViewInvoke('review.read', { sessionId: 'a', scopeKey: result.scopeKey });
  assert.equal(refreshed.entries[0].state, 'rolledBack');
});

test('切换会话后停止在途历史的后续分页', async (t) => {
  const h = await fixture(t);
  const gate = Promise.withResolvers(); h.gate(gate.promise);
  const pending = h.plugin.onViewInvoke('review.read', { sessionId: 'a', showAll: true });
  const rejected = assert.rejects(pending, { code: 'READ_CANCELLED' });
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  h.activate('b'); gate.resolve();
  await rejected;
  assert.equal(h.calls.length, 1);
});
