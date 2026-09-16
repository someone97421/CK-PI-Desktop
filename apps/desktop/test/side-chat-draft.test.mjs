import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
register(new URL('./helpers/ts-import-hooks.mjs', import.meta.url));
const { createSideChatSlice } = await import('../src/stores/slices/side-chat-slice.ts');
const { api } = await import('../src/lib/api.ts');

function fixture() {
  const state = {
    activeSessionId: 'parent', sessions: [{ id: 'parent', title: 'Main' }],
    messages: [{ id: 'a1', role: 'assistant', content: 'Anchor' }],
    toasts: [],
    showToast(message) { state.toasts.push(message); },
    runningSessions: {}, sideChats: {}, sideChatTranscripts: {},
    workPanelTabs: [], activeWorkPanelTabId: null, workPanelContexts: {},
    openWorkPanelTabForSession(parent, tab) {
      assert.equal(parent, 'parent');
      state.workPanelTabs = [tab]; state.activeWorkPanelTabId = tab.id;
    },
    closeWorkPanelTab(id) { state.workPanelTabs = state.workPanelTabs.filter(t => t.id !== id); },
    sendPrompt: async (...args) => { sends.push(args); return true; },
  };
  const sends = [];
  const forks = [];
  api.forkSession = async (...args) => {
    forks.push(args);
    return { session: { id: 'child', title: 'Side', messages: state.messages } };
  };
  Object.assign(state, createSideChatSlice({
    get: () => state,
    set: update => Object.assign(state, typeof update === 'function' ? update(state) : update),
    commitForkedSession: (child, options) => {
      assert.equal(options.activate, false); state.sessions.push(child);
    },
    withoutRecordKey: (record, key) => Object.fromEntries(Object.entries(record).filter(([id]) => id !== key)),
  }));
  return { state, forks, sends };
}

test('opening, typing, whitespace sending, and closing never create a session', async () => {
  const { state, forks, sends } = fixture();
  const [id, again] = await Promise.all([state.openSideChat('a1'), state.openSideChat('a1')]);
  assert.equal(id, again);
  state.updateSideChatDraft(id, 'not sent');
  assert.equal(state.sessions.length, 1);
  state.updateSideChatDraft(id, '  ');
  assert.equal(await state.sendSideChatPrompt(id), false);
  state.closeSideChat(id);
  assert.deepEqual(state.sideChats, {});
  assert.deepEqual(forks, []); assert.deepEqual(sends, []);
});

test('selection prefills a quote without sending or replacing existing text', async () => {
  const { state, forks, sends } = fixture();
  const id = await state.openSideChat('a1', 'selected\ntext');
  assert.equal(state.sideChats[id].draft, '> selected\n> text\n\n');
  state.updateSideChatDraft(id, 'my question');
  await state.openSideChat('a1', 'another quote');
  assert.match(state.sideChats[id].draft, /^my question/);
  assert.deepEqual(forks, []); assert.deepEqual(sends, []);
});

test('first Send creates exactly one child, including concurrent submissions', async () => {
  const { state, forks, sends } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'question');
  const results = await Promise.all([state.sendSideChatPrompt(id), state.sendSideChatPrompt(id)]);
  assert.deepEqual(results, [true, true]);
  assert.equal(forks.length, 1); assert.equal(sends.length, 1);
  assert.deepEqual(forks[0].slice(0, 1), ['parent']); assert.equal(forks[0][2], 'a1');
  assert.equal(sends[0][2], 'child'); assert.equal(state.activeSessionId, 'parent');
  assert.equal(state.sideChats.child.draft, '');
  assert.equal(state.workPanelTabs[0].resource, 'child');
  assert.equal(state.sideChats[id], undefined);
  state.closeSideChat('child');
  assert.equal(state.sessions.length, 2);
});

test('fork failure preserves draft and allows retry', async () => {
  const { state } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'keep me');
  const original = api.forkSession;
  api.forkSession = async () => { throw new Error('fork failed'); };
  assert.equal(await state.sendSideChatPrompt(id), false);
  assert.equal(state.sideChats[id].draft, 'keep me');
  assert.equal(state.sideChats[id].sending, false);
  assert.equal(state.sessions.length, 1);
  api.forkSession = original;
  assert.equal(await state.sendSideChatPrompt(id), true);
});

test('failed prompt reuses the created child on retry and keeps newer draft text', async () => {
  const { state, forks } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'first');
  state.sendPrompt = async () => false;
  assert.equal(await state.sendSideChatPrompt(id), false);
  assert.equal(state.sideChats.child.draft, 'first');
  state.sendPrompt = async () => { state.updateSideChatDraft('child', 'newer'); return true; };
  await state.sendSideChatPrompt('child');
  assert.equal(forks.length, 1);
  assert.equal(state.sideChats.child.draft, 'newer');
});

test('switching parent during fork updates its retained tab without stealing focus', async () => {
  const { state } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'question');
  let finish;
  api.forkSession = () => new Promise(resolve => { finish = resolve; });
  const sending = state.sendSideChatPrompt(id);
  state.workPanelContexts.parent = { tabs: state.workPanelTabs, activeTabId: state.activeWorkPanelTabId };
  state.activeSessionId = 'other'; state.workPanelTabs = []; state.activeWorkPanelTabId = null;
  finish({ session: { id: 'child', title: 'Side', messages: [] } });
  await sending;
  assert.equal(state.activeSessionId, 'other'); assert.deepEqual(state.workPanelTabs, []);
  assert.equal(state.workPanelContexts.parent.tabs[0].resource, 'child');
});

test('closing during an authorized send never resurrects its panel', async () => {
  const { state } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'question');
  let finish;
  api.forkSession = () => new Promise(resolve => { finish = resolve; });
  const sending = state.sendSideChatPrompt(id);
  state.closeSideChat(id);
  finish({ session: { id: 'child', title: 'Side', messages: [] } });
  await sending;
  assert.deepEqual(state.sideChats, {}); assert.deepEqual(state.workPanelTabs, []);
  assert.equal(state.sessions.length, 2);
});


test('a parent that starts replying blocks first Send with feedback and recovers', async () => {
  const { state, forks, sends } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'keep question');
  state.runningSessions.parent = true;
  assert.equal(await state.sendSideChatPrompt(id), false);
  assert.equal(forks.length, 0); assert.equal(sends.length, 0);
  assert.equal(state.toasts.length, 1);
  assert.equal(state.sideChats[id].draft, 'keep question');
  state.runningSessions.parent = false;
  assert.equal(await state.sendSideChatPrompt(id), true);
  assert.equal(forks.length, 1);
});

test('read-only parents never create a child; recovery permits first Send', async () => {
  for (const reason of ['provider-unavailable', 'untrusted', 'externally-changed', 'busy']) {
    const { state, forks, sends } = fixture();
    const id = await state.openSideChat('a1');
    state.updateSideChatDraft(id, 'keep question');
    state.sessions[0].readOnlyReason = reason;
    assert.equal(await state.sendSideChatPrompt(id), false, reason);
    assert.equal(forks.length, 0); assert.equal(sends.length, 0);
    assert.equal(state.toasts.length, 1);
    assert.equal(state.sideChats[id].draft, 'keep question');
    delete state.sessions[0].readOnlyReason;
    assert.equal(await state.sendSideChatPrompt(id), true);
  }
});

test('a child that becomes unavailable during creation is not prompted and is reused', async () => {
  const { state, sends } = fixture();
  const id = await state.openSideChat('a1');
  state.updateSideChatDraft(id, 'keep question');
  api.forkSession = async () => ({session: {id: 'child', title: 'Side', readOnlyReason: 'provider-unavailable', messages: []}});
  assert.equal(await state.sendSideChatPrompt(id), false);
  assert.equal(sends.length, 0); assert.equal(state.toasts.length, 1);
  assert.equal(state.sideChats.child.draft, 'keep question');
  delete state.sessions.find(s => s.id === 'child').readOnlyReason;
  assert.equal(await state.sendSideChatPrompt('child'), true);
  assert.equal(state.sessions.length, 2);
});
