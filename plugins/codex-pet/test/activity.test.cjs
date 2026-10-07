'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ActivityMonitor } = require('../lib/activity.cjs');
const TIME = '2026-10-06T00:00:00.000Z';
const LATER = '2026-10-06T01:00:00.000Z';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const session = (id, running = false) => ({ id, title: `会话 ${id}`, running, updatedAt: TIME });
const snapshot = (id, extra = {}) => ({ sessionId: id, revision: 1, status: 'idle', queuedTurns: [], items: [{ content: '秘密聊天全文' }], activeItems: [], pendingApprovals: [], pendingInputs: [], generatedAt: TIME, ...extra });
const note = (id, kind = 'task.completed', extra = {}) => ({ id: `n-${id}`, sessionId: id, sessionTitle: `会话 ${id}`, turnId: `t-${id}`, kind, createdAt: TIME, readAt: null, ...extra });

function host(sessions = [], notes = []) {
  const events = new EventEmitter();
  const data = { sessions, notes, statuses: new Map(), snapshots: new Map(), subscriptions: new Map(), calls: [], reads: [], peak: 0, concurrent: 0, maxConcurrent: 0, failure: null, subscribeGate: null, snapshotGate: null, listGate: null };
  async function request(action) {
    data.concurrent++; data.maxConcurrent = Math.max(data.maxConcurrent, data.concurrent);
    try { await tick(); return await action(); } finally { data.concurrent--; }
  }
  const pi = { events, desktop: {
    invoke(input) { return request(async () => {
      data.calls.push(input);
      assert.ok(Array.isArray(input.args));
      if (data.failure === input.operation) throw new Error('宿主暂不可用');
      if (input.operation === 'session/list') { if (data.listGate) await data.listGate.promise; return { sessions: data.sessions }; }
      if (input.operation === 'notification/list') return { notifications: data.notes.map((n) => ({ ...n })) };
      if (input.operation === 'agent/getStatus') {
        const id = input.args[0];
        assert.equal(typeof id, 'string', 'agent/getStatus 使用 sessionId 位置参数');
        const live = data.snapshots.get(id);
        return { status: data.statuses.get(id) || {
          sessionId: id,
          isRunning: data.sessions.find((s) => s.id === id)?.running === true || ['running', 'busy'].includes(live?.status || live?.session?.status),
          pendingToolConfirmations: live?.pendingApprovals?.length || 0,
        } };
      }
      if (input.operation === 'notification/markRead') { data.notes.find((n) => n.id === input.args[0].id).readAt = LATER; return { ok: true }; }
      if (input.operation === 'notification/markAllRead') { data.notes.forEach((n) => { n.readAt = LATER; }); return { ok: true }; }
      throw new Error(`未允许的调用 ${input.operation}`);
    }); },
    subscribe({ sessionId }) { return request(async () => {
      if (data.failure === 'subscribe') throw new Error('订阅失败');
      data.subscribeStarted = (data.subscribeStarted || 0) + 1;
      if (data.subscribeGate) await data.subscribeGate.promise;
      assert.ok(events.listenerCount('desktop:event') > 0 || data.subscribeGate, '先注册监听器');
      const subscriptionId = `sub-${sessionId}`;
      data.subscriptions.set(subscriptionId, sessionId); data.peak = Math.max(data.peak, data.subscriptions.size);
      return { subscriptionId, sessionId, snapshot: data.snapshots.get(sessionId) || snapshot(sessionId, sessions.find((s) => s.id === sessionId)?.running ? { status: 'running' } : {}) };
    }); },
    unsubscribe(id) { return request(() => { data.subscriptions.delete(id); return { ok: true }; }); },
    getSessionSnapshot({ sessionId }) { return request(async () => {
      data.reads.push(sessionId);
      if (data.failure === 'snapshot') throw new Error('快照失败');
      const captured = data.snapshots.get(sessionId) || snapshot(sessionId, data.sessions.find((s) => s.id === sessionId)?.running ? { status: 'running' } : {});
      if (data.snapshotGate) await data.snapshotGate.promise;
      return captured;
    }); },
  } };
  data.emit = (sessionId, event, extra = {}) => events.emit('desktop:event', { kind: 'agent.event', sessionId, at: LATER, payload: { sessionId, turnId: `t-${sessionId}`, ts: Date.parse(LATER), event, ...extra } });
  return { pi, data };
}

function monitor(t, pi, options = {}) {
  const value = new ActivityMonitor(pi, { pollSeconds: 3600, ...options });
  t.after(() => value.stop());
  return value;
}

test('优先级、等待计数、队列及简短摘要，不暴露聊天原文', async (t) => {
  const { pi, data } = host(['wait', 'bad', 'done', 'run', 'idle'].map((id) => session(id, ['wait', 'run'].includes(id))), [note('done'), note('bad', 'task.failed', { errorCode: 'NETWORK_ERROR' })]);
  data.snapshots.set('wait', snapshot('wait', { status: 'running', pendingApprovals: [{ id: 'a', summary: '秘密聊天全文' }], pendingInputs: [{ id: 'i', questions: ['秘密聊天全文'] }], queuedTurns: [{}] }));
  data.snapshots.set('run', snapshot('run', { status: 'running', activeItems: [{ content: { toolName: 'Read', content: '秘密聊天全文' } }] }));
  const changes = [];
  const value = monitor(t, pi, { onChange: (state) => changes.push(state) });
  await value.start();
  const state = value.getState();
  assert.deepEqual(state.rows.map((r) => r.state), ['needs-input', 'blocked', 'ready', 'running']);
  assert.equal(state.state, 'needs-input');
  assert.equal(state.rows[0].pendingCount, 2); assert.equal(state.rows[0].queuedCount, 1);
  assert.deepEqual(state.rows.map((r) => r.unreadCount), [0, 1, 1, 0]);
  assert.equal(state.rows[3].detail, '正在使用 Read');
  assert.ok(!JSON.stringify(state).includes('秘密聊天全文'));
  assert.deepEqual(changes.at(-1), state);
  state.rows[0].title = '修改外部副本'; assert.notEqual(value.getState().rows[0].title, state.rows[0].title);
});

test('周期同步已读；最新已读结果不回退到旧未读失败；标记保留通知记录', async (t) => {
  const { pi, data } = host([session('a'), session('b')], [note('a'), note('a', 'task.failed', { id: 'old', createdAt: '2026-10-05T00:00:00.000Z' }), note('b', 'task.failed')]);
  const value = monitor(t, pi); await value.start();
  data.notes[0].readAt = LATER;
  await value.refresh(); assert.deepEqual(value.getState().rows.map((r) => r.sessionId), ['b']);
  await value.markRead('b'); assert.equal(value.getState().state, null); assert.equal(data.notes.length, 3);
  data.notes[0].readAt = null; await value.refresh(); assert.equal(value.getState().state, 'ready');
  await value.markAllRead(); assert.equal(value.getState().state, null); assert.equal(data.notes.length, 3);
});

test('新轮次运行优先于旧 ready/failed，结束等待本轮持久化通知', async (t) => {
  const { pi, data } = host([session('a', true)], [note('a', 'task.failed', { turnId: 'old' })]);
  data.snapshots.set('a', snapshot('a', { status: 'running', activeTurn: { id: 'new', startedAt: LATER, status: 'running' } }));
  const value = monitor(t, pi); await value.start(); assert.equal(value.getState().state, 'running');
  data.emit('a', { type: 'agent_end' }, { turnId: 'new' }); assert.equal(value.getState().state, null);
  data.snapshots.set('a', snapshot('a', { revision: 2 })); data.sessions[0].running = false;
  data.notes.unshift(note('a', 'task.completed', { id: 'new-note', turnId: 'new', createdAt: '2026-10-06T02:00:00.000Z' }));
  await value.refresh(); assert.equal(value.getState().state, 'ready');
});

test('16 订阅上限、固定关注、超额候选轮换与 bounded 并发', async (t) => {
  const { pi, data } = host(Array.from({ length: 36 }, (_, i) => session(`s${i}`, true)));
  const value = monitor(t, pi); await value.start();
  assert.equal(data.subscriptions.size, 16); assert.equal(data.peak, 16);
  assert.equal(value.getState().rows.length, 36);
  const fixed = [...data.subscriptions.keys()]; const seen = new Set(data.reads);
  for (let i = 0; i < 3; i++) { await value.refresh(); data.reads.forEach((id) => seen.add(id)); }
  assert.deepEqual([...data.subscriptions.keys()], fixed); assert.equal(seen.size, 36); assert.ok(data.maxConcurrent <= 4);
  data.snapshots.set('s35', snapshot('s35', { status: 'running', pendingInputs: [{ id: 'question' }] }));
  for (let i = 0; i < 4; i++) await value.refresh();
  assert.ok([...data.subscriptions.values()].includes('s35')); assert.equal(data.peak, 16);
});

test('轻量状态轮转发现等待并订阅，空闲会话不读取历史快照', async (t) => {
  const { pi, data } = host(Array.from({ length: 100 }, (_, i) => ({ ...session(`s${i}`), updatedAt: new Date(Date.parse(TIME) - i * 1000).toISOString() })));
  data.snapshots.set('s17', snapshot('s17', { pendingApprovals: [{ id: 'approval' }] }));
  const value = monitor(t, pi); await value.start();
  assert.equal(data.calls.filter((call) => call.operation === 'agent/getStatus').length, 16);
  assert.equal(data.reads.length, 0); assert.equal(value.getState().state, null); assert.equal(value.getState().stale, false);
  await value.refresh(); assert.equal(value.getState().state, 'needs-input');
  assert.ok([...data.subscriptions.values()].includes('s17'));
  assert.equal(data.subscriptions.size, 1); assert.equal(data.reads.length, 0);
});

test('根事件开始/结束、工具摘要与队列；忽略子代理及 turn_end；快照纠偏清等待', async (t) => {
  const { pi, data } = host([session('a', true)]); const value = monitor(t, pi); await value.start();
  data.emit('a', { type: 'agent_start' }); data.emit('a', { type: 'tool_start', toolName: 'Bash', args: '秘密参数' });
  assert.equal(value.getState().rows[0].detail, '正在使用 Bash');
  data.emit('a', { type: 'agent_end' }, { parentToolCallId: 'child' }); data.emit('a', { type: 'turn_end' });
  assert.equal(value.getState().state, 'running');
  data.emit('a', { type: 'asktool_request', request: { id: 'i' } }); assert.equal(value.getState().state, 'needs-input');
  pi.events.emit('desktop:event', { kind: 'agent.queueChanged', sessionId: 'a', payload: { sessionId: 'a', entries: [{ content: '秘密聊天原文' }, {}] } });
  assert.equal(value.getState().rows[0].queuedCount, 2);
  data.snapshots.set('a', snapshot('a', { status: 'running', revision: 2 })); await value.refresh();
  assert.equal(value.getState().state, 'running'); assert.equal(value.getState().rows[0].pendingCount, 0);
  data.emit('a', { type: 'agent_end' }); assert.equal(value.getState().state, null);
});

test('refresh 合并；stop 在 subscribe 返回前发生仍清理所有注册，并允许重启', async (t) => {
  const { pi, data } = host([session('a', true), session('b', true)]); data.subscribeGate = deferred();
  const value = monitor(t, pi); const started = value.start();
  while (data.subscribeStarted !== 2) await tick();
  const first = value.refresh(); assert.equal(first, value.refresh());
  const stopped = value.stop(); assert.equal(pi.events.listenerCount('desktop:event'), 0);
  data.subscribeGate.resolve(); await Promise.all([started, first, stopped]);
  assert.equal(data.subscriptions.size, 0); assert.equal(value._timer, null); assert.equal(value._hintTimer, null);
  const calls = data.calls.length; await value.refresh(); assert.equal(data.calls.length, calls);
  data.subscribeGate = null; await value.start(); assert.equal(data.subscriptions.size, 2); assert.equal(pi.events.listenerCount('desktop:event'), 1);
});

test('请求期间更新的根事件不被旧快照覆盖；后续快照重建', async (t) => {
  const { pi, data } = host([session('a', true)]); const value = monitor(t, pi); await value.start();
  data.snapshotGate = deferred(); const refreshed = value.refresh();
  while (!data.reads.length) await tick();
  data.emit('a', { type: 'asktool_request', request: { id: 'new-question' } });
  data.snapshotGate.resolve(); await refreshed; assert.equal(value.getState().state, 'needs-input');
  data.snapshotGate = null; data.snapshots.set('a', snapshot('a', { status: 'running', revision: 2 }));
  await value.refresh(); assert.equal(value.getState().state, 'running');
});

test('列表/通知/快照失败保留已有 rows、标记 stale，成功刷新恢复', async (t) => {
  const { pi, data } = host([session('a', true)], [note('b')]); const value = monitor(t, pi); await value.start();
  const rows = value.getState().rows;
  for (const failure of ['session/list', 'notification/list', 'snapshot']) {
    data.failure = failure; await value.refresh();
    assert.deepEqual(value.getState().rows, rows); assert.equal(value.getState().stale, true); assert.ok(value.getState().error);
  }
  data.failure = null; await value.refresh(); assert.equal(value.getState().stale, false); assert.equal(value.getState().error, null);
});

test('多订阅重复 session.changed 只产生一次列表刷新，hint 不读重型快照', async (t) => {
  const { pi, data } = host([session('a', true), session('b', true)]); const value = monitor(t, pi); await value.start();
  const lists = () => data.calls.filter((call) => call.operation === 'session/list').length;
  const before = lists(); const reads = data.reads.length;
  for (let i = 0; i < 16; i++) pi.events.emit('desktop:event', { kind: 'session.changed', subscriptionId: `sub-${i}`, payload: { reason: 'updated', sessionId: 'bad', running: false } });
  await delay(50); assert.equal(lists(), before + 1); assert.equal(data.reads.length, reads); assert.equal(value.getState().state, 'running');
  pi.events.emit('desktop:event', { kind: 'session.changed', payload: {} }); await value.stop();
  await delay(35); assert.equal(lists(), before + 1);
});

test('当前宿主嵌套 session 快照与周期计时配置', async (t) => {
  const { pi, data } = host([session('a')]);
  data.snapshots.set('a', { ...snapshot('a'), status: undefined, session: { id: 'a', status: 'running' }, activeTurn: { id: 't-a', status: 'running', startedAt: TIME } });
  const value = monitor(t, pi); await value.start(); assert.equal(value.getState().state, 'running');
  value.setPollSeconds(0.02); assert.equal(value.pollSeconds, 0.02);
  await delay(45); assert.ok(data.calls.filter((call) => call.operation === 'session/list').length >= 2);
  assert.throws(() => value.setPollSeconds(0), RangeError);
  await value.stop(); assert.equal(pi.events.listenerCount('desktop:event'), 0);
});

test('agent.turnEnded 不接受旧轮次结束；根结束等待持久化失败通知', async (t) => {
  const { pi, data } = host([session('a', true)]); const value = monitor(t, pi); await value.start();
  data.emit('a', { type: 'agent_start' });
  pi.events.emit('desktop:event', { kind: 'agent.turnEnded', sessionId: 'a', payload: { sessionId: 'a', turnId: 'old', reason: 'completed' } });
  assert.equal(value.getState().state, 'running');
  pi.events.emit('desktop:event', { kind: 'agent.turnEnded', sessionId: 'a', payload: { sessionId: 'a', turnId: 't-a', reason: 'error' } });
  assert.equal(value.getState().state, null);
  data.sessions[0].running = false; data.snapshots.set('a', snapshot('a', { revision: 2 }));
  data.notes.push(note('a', 'task.failed', { createdAt: LATER, errorCode: 'FAILED' }));
  await value.refresh(); assert.equal(value.getState().state, 'blocked');
});

test('新候选订阅失败仍保留原有 rows 并标 stale', async (t) => {
  const { pi, data } = host([session('a')], [note('a')]); const value = monitor(t, pi); await value.start();
  const rows = value.getState().rows;
  data.sessions.push(session('b', true)); data.failure = 'subscribe';
  await value.refresh(); assert.deepEqual(value.getState().rows, rows); assert.equal(value.getState().stale, true);
  data.failure = null; await value.refresh(); assert.equal(value.getState().stale, false); assert.equal(data.subscriptions.size, 1);
});

test('已读写入与刷新并发时再读持久化结果；所有请求总并发不超过四', async (t) => {
  const { pi, data } = host(Array.from({ length: 12 }, (_, i) => session(`s${i}`, true)), Array.from({ length: 12 }, (_, i) => note(`s${i}`)));
  const value = monitor(t, pi); await value.start(); data.snapshotGate = deferred();
  const refreshed = value.refresh();
  while (data.reads.length < 4) await tick();
  const marked = value.markAllRead(); data.snapshotGate.resolve();
  await Promise.all([refreshed, marked]); assert.ok(data.notes.every((n) => n.readAt)); assert.ok(data.maxConcurrent <= 4);
  data.snapshotGate = null; data.sessions.forEach((s) => { s.running = false; data.snapshots.set(s.id, snapshot(s.id, { revision: 2 })); });
  await value.refresh(); assert.equal(value.getState().state, null);
});

test('第41之后的旧会话最终全部轻量探测，发现 busy 和 awaiting_permission', async (t) => {
  const { pi, data } = host(Array.from({ length: 70 }, (_, i) => ({ ...session(`s${i}`), updatedAt: new Date(Date.parse(TIME) - i * 1000).toISOString() })));
  data.statuses.set('s41', { sessionId: 's41', isRunning: false, pendingToolConfirmations: 0, status: 'awaiting_permission' });
  data.snapshots.set('s41', { ...snapshot('s41'), status: undefined, session: { id: 's41', status: 'awaiting_permission' }, pendingApprovals: [{ id: 'approval' }] });
  data.statuses.set('s69', { sessionId: 's69', isRunning: false, pendingToolConfirmations: 0, status: 'busy' });
  data.snapshots.set('s69', { ...snapshot('s69'), status: undefined, session: { id: 's69', status: 'busy' } });
  const value = monitor(t, pi); await value.start();
  for (let i = 0; i < 4; i++) await value.refresh();
  const probes = data.calls.filter((call) => call.operation === 'agent/getStatus');
  assert.equal(new Set(probes.map((call) => call.args[0])).size, 70);
  assert.ok(data.maxConcurrent <= 4); assert.ok(data.peak <= 16);
  assert.deepEqual(value.getState().rows.map((row) => [row.sessionId, row.state]), [['s41', 'needs-input'], ['s69', 'running']]);
  assert.equal(value.getState().stale, false); assert.equal(value.getState().error, null);
  assert.deepEqual(new Set(data.subscriptions.values()), new Set(['s41', 's69']));
  assert.ok(data.reads.every((id) => id === 's41' || id === 's69'));
});

test('模型正文更新气泡并限制长度，忽略思考、工具、子代理与任务汇总', async (t) => {
  const { pi, data } = host([session('a', true)]);
  const value = monitor(t, pi); await value.start();
  const message = { id: 'm-a', role: 'assistant', content: '正在检查接口。', thinking: '隐藏思考' };
  data.emit('a', { type: 'message_start', message });
  assert.equal(value.getState().output.text, message.content);
  data.emit('a', { type: 'message_update', message: { ...message, content: '正在检查接口。已找到事件订阅。' } });
  const output = value.getState().output;
  assert.equal(output.text, '正在检查接口。已找到事件订阅。');
  assert.equal(output.sessionId, 'a'); assert.equal(output.title, '会话 a');
  data.emit('a', { type: 'message_update', stream: 'delta', deltaThinking: '隐藏思考', message: { ...message, content: '' } });
  data.emit('a', { type: 'message_update', message: { ...message, content: '子代理' } }, { parentToolCallId: 'child' });
  data.emit('a', { type: 'message_end', taskSummary: true, message: { ...message, content: '任务汇总' } });
  data.emit('a', { type: 'message_end', message: { id: 'tool', role: 'tool', content: '工具结果' } });
  assert.deepEqual(value.getState().output, output);
  data.emit('a', { type: 'message_end', message: { ...message, content: '长'.repeat(500) + '最新进度' } });
  assert.equal(value.getState().output.text.length, 240); assert.ok(value.getState().output.text.endsWith('最新进度'));
  assert.ok(!JSON.stringify(value.getState()).includes('隐藏思考'));
  value.getState().output.text = '外部修改'; assert.notEqual(value.getState().output.text, '外部修改');
});

test('气泡到期后相同快照不重播；只恢复当前轮文本，新轮与旧轮隔离', async (t) => {
  const { pi, data } = host([session('a', true)]);
  const active = { status: 'running', activeTurn: { id: 't-a', status: 'running' }, activeItems: [
    { turnId: 'old', content: { id: 'old', role: 'assistant', content: '旧轮内容' } },
    { turnId: 't-a', content: { id: 'm-a', role: 'assistant', content: '当前进度' } },
  ] };
  data.snapshots.set('a', snapshot('a', active));
  const value = monitor(t, pi); await value.start();
  assert.equal(value.getState().output.text, '当前进度');
  const future = Date.now() + 13000;
  t.mock.method(Date, 'now', () => future);
  assert.equal(value.getState().output, null);
  await value.refresh(); assert.equal(value.getState().output, null);
  data.emit('a', { type: 'message_update', message: { id: 'm-a', role: 'assistant', content: '更新进度' } });
  assert.equal(value.getState().output.text, '更新进度');
  data.emit('a', { type: 'agent_start' }, { turnId: 'new' });
  assert.equal(value.getState().output, null);
  data.emit('a', { type: 'message_end', message: { id: 'm-a', role: 'assistant', content: '迟到的旧消息' } });
  assert.equal(value.getState().output, null);
  data.emit('a', { type: 'message_update', message: { id: 'new-message', role: 'assistant', content: '新轮进度' } }, { turnId: 'new' });
  assert.equal(value.getState().output.text, '新轮进度');
  data.sessions = []; await value.refresh(); assert.equal(value.getState().output, null);
});

test('流式增量保留空格并累加，resetText 和最终完整正文覆盖旧片段', async (t) => {
  const { pi, data } = host([session('a', true)]);
  const value = monitor(t, pi); await value.start();
  const message = { id: 'm', role: 'assistant', content: '', status: 'streaming' };
  data.emit('a', { type: 'message_start', message });
  data.emit('a', { type: 'message_update', stream: 'delta', message, deltaText: '正在检查 ' });
  data.emit('a', { type: 'message_update', stream: 'delta', message, deltaText: 'SDK' });
  assert.equal(value.getState().output.text, '正在检查 SDK');
  data.emit('a', { type: 'message_update', stream: 'delta', message, resetText: true, deltaText: '改为检查 UI' });
  assert.equal(value.getState().output.text, '改为检查 UI');
  data.emit('a', { type: 'message_end', message: { ...message, content: '检查完成', status: 'complete' } });
  assert.equal(value.getState().output.text, '检查完成');
});
