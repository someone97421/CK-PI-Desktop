'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { QuickChat } = require('../lib/quick-chat.cjs');

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function fixture(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须位于 PI_SCRATCH_DIR');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'quick-chat-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = { calls: [], created: [], sessions: new Map(), prompts: [], messages: [], failure: null, lookupError: null, gate: null,
    settings: { defaultProviderId: 'default', defaultModelId: 'chat', defaultMode: 'plan', defaultThinkingLevel: 'high' },
    models: [{ key: 'default/chat', providerId: 'default', modelId: 'chat', thinkingLevels: ['high'] }, { key: 'explicit/chat', providerId: 'explicit', modelId: 'chat', thinkingLevels: ['low'] }] };
  const pi = { models: { list: async () => data.models }, desktop: { invoke: async ({ operation, args }) => {
    data.calls.push({ operation, args });
    switch (operation) {
      case 'settings/get': return data.settings;
      case 'session/create': { const id = `session-${data.created.length + 1}`; data.created.push({ id, input: args[0] }); const session = { id, ...args[0] }; data.sessions.set(id, session); return { session }; }
      case 'session/getScratchPath': return { path: path.join(root, 'session-scratch', args[0].sessionId) };
      case 'session/get':
        if (data.lookupError) throw data.lookupError;
        return { session: data.sessions.get(args[0].id) || null, messages: data.messages.filter((message) => message.sessionId === args[0].id).map((message) => ({ ...message })) };
      case 'agent/prompt':
        data.prompts.push(args[0]);
        if (data.gate) { data.gate.started.resolve(); await data.gate.promise; }
        if (data.failure === 'reject') return { accepted: false };
        data.messages.push({ id: args[0].messageId, sessionId: args[0].sessionId, role: 'user' });
        if (data.failure === 'lost-receipt') throw new Error('宿主回执丢失');
        return { accepted: true };
      default: throw new Error(`未允许的调用 ${operation}`);
    }
  } } };
  const chat = new QuickChat(pi, path.join(root, 'data')); await chat.init();
  return { chat, pi, data, root };
}

test('快捷聊天继承默认模型和模式，显式模型覆盖默认且仅使用支持的思考级别', async (t) => {
  const { chat, data } = await fixture(t);
  assert.deepEqual(await chat.send({ text: '默认模型消息', requestId: 'default' }), { sessionId: 'session-1' });
  assert.deepEqual(data.created[0].input, { title: '默认模型消息', mode: 'plan', providerId: 'default', modelId: 'chat', thinkingLevel: 'high' });
  await chat.send({ text: '显式模型消息', modelKey: 'explicit/chat', requestId: 'explicit' });
  assert.deepEqual(data.created[1].input, { title: '显式模型消息', mode: 'plan', providerId: 'explicit', modelId: 'chat' });
});

test('Enter 重复提交同 nonce 时合并正在发送的请求，成功回执可复用', async (t) => {
  const { chat, data } = await fixture(t);
  data.gate = { ...deferred(), started: deferred() };
  const input = { text: '只发送一次', requestId: 'enter-nonce' };
  const first = chat.send(input); await data.gate.started.promise;
  const second = chat.send(input); data.gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ sessionId: 'session-1' }, { sessionId: 'session-1' }]);
  assert.deepEqual(await chat.send(input), { sessionId: 'session-1' });
  assert.equal(data.created.length, 1); assert.equal(data.prompts.length, 1);
  assert.equal(chat.getDraft().text, '');
});

test('发送拒绝保留草稿及已有 session，重开恢复草稿并向同一会话重试', async (t) => {
  const { chat, pi, data, root } = await fixture(t);
  data.failure = 'reject';
  const input = { text: '失败后继续编辑', skills: ['skill:review'], modelKey: 'explicit/chat', requestId: 'retry' };
  await assert.rejects(chat.send(input), { code: 'PET_SEND_REJECTED' });
  assert.equal(chat.getDraft().text, input.text); assert.equal(chat.getDraft().sessionId, 'session-1'); assert.ok(chat.getDraft().sendError);
  assert.equal(chat.pending.attempted, false);
  const reopened = new QuickChat(pi, path.join(root, 'data')); await reopened.init();
  assert.deepEqual(reopened.getDraft(), chat.getDraft());
  data.failure = null;
  assert.deepEqual(await reopened.send(input), { sessionId: 'session-1' });
  assert.equal(data.created.length, 1); assert.equal(data.prompts.length, 2);
  assert.equal(data.prompts[1].messageId, data.prompts[0].messageId);
  assert.equal(data.prompts[1].content, '$review\n失败后继续编辑');
});

test('宿主已接收但回执丢失，重开先查询用户 messageId，避免重复投递', async (t) => {
  const { chat, pi, data, root } = await fixture(t);
  data.failure = 'lost-receipt';
  const input = { text: '回执丢失仍保留消息', requestId: 'lost' };
  await assert.rejects(chat.send(input), /宿主回执丢失/);
  assert.equal(chat.pending.attempted, true); assert.equal(chat.getDraft().text, input.text);
  const messageId = data.prompts[0].messageId;
  const reopened = new QuickChat(pi, path.join(root, 'data')); await reopened.init();
  data.failure = null;
  assert.deepEqual(await reopened.send({ ...input, requestId: 'recover' }), { sessionId: 'session-1' });
  const lookup = data.calls.find((call) => call.operation === 'session/get');
  assert.equal(lookup.args[0].id, 'session-1'); assert.equal(data.messages[0].id, messageId);
  assert.equal(data.created.length, 1); assert.equal(data.prompts.length, 1);
  assert.equal(reopened.getDraft().text, ''); assert.equal(reopened.pending, null);
  assert.deepEqual(await reopened.send(input), { sessionId: 'session-1' });
  assert.equal(data.prompts.length, 1);
});

test('附件写入所属 session scratch，技能与附件元数据一并传给宿主，重开恢复未发送草稿', async (t) => {
  const { chat, pi, data, root } = await fixture(t);
  await chat.send({ text: '建立关联会话', modelKey: '', requestId: 'seed-attachments' });
  const attachments = [{ name: '图像.png', mimeType: 'image/png', dataBase64: Buffer.from('测试附件').toString('base64') }, { name: 'notes.txt', mimeType: 'text/plain', dataBase64: Buffer.from('notes').toString('base64') }];
  const draft = { text: '带附件', attachments, skills: [{ skillId: 'skill:analyze' }], modelKey: '', sessionId: 'session-1' };
  await chat.saveDraft(draft);
  const reopened = new QuickChat(pi, path.join(root, 'data')); await reopened.init(); assert.deepEqual(reopened.getDraft(), draft);
  await reopened.send({ requestId: 'attachments' });
  const prompt = data.prompts[1]; assert.equal(prompt.content, '$analyze\n带附件');
  assert.equal(data.created.length, 1); assert.equal(prompt.sessionId, 'session-1');
  const expectedDirectory = path.join(root, 'session-scratch', 'session-1', 'pet-attachments', prompt.messageId);
  assert.equal(prompt.attachments.length, 2);
  for (const [i, attachment] of prompt.attachments.entries()) {
    assert.equal(path.dirname(attachment.path), expectedDirectory);
    assert.deepEqual(await fs.readFile(attachment.path), Buffer.from(attachments[i].dataBase64, 'base64'));
    assert.equal(attachment.kind, i === 0 ? 'image' : 'file'); assert.equal(attachment.name, attachments[i].name);
    assert.equal(attachment.size, Buffer.from(attachments[i].dataBase64, 'base64').length);
  }
  assert.equal(data.calls.find((call) => call.operation === 'session/getScratchPath').args[0].sessionId, 'session-1');
  assert.equal(prompt.viewingSessionId, null); assert.deepEqual(reopened.getDraft().attachments, []);
});

test('空模型连续发送沿用关联会话，重开后仍保留用户修改的模型与模式', async (t) => {
  const { chat, pi, data, root } = await fixture(t);
  await chat.send({ text: '首次默认模型', modelKey: '', requestId: 'seed' });
  const session = data.sessions.get('session-1');
  Object.assign(session, { providerId: 'explicit', modelId: 'changed', mode: 'goal', thinkingLevel: 'low' });
  const reopened = new QuickChat(pi, path.join(root, 'data')); await reopened.init();
  assert.deepEqual(await reopened.send({ text: '沿用修改后的会话', modelKey: '', requestId: 'next' }), { sessionId: 'session-1' });
  assert.deepEqual(await reopened.send({ text: '再次发送', modelKey: '', requestId: 'third' }), { sessionId: 'session-1' });
  assert.equal(data.created.length, 1);
  assert.equal(data.calls.filter((call) => call.operation === 'settings/get').length, 1);
  assert.deepEqual(data.prompts.map((prompt) => prompt.sessionId), ['session-1', 'session-1', 'session-1']);
  assert.equal(new Set(data.prompts.map((prompt) => prompt.messageId)).size, 3);
  for (const prompt of data.prompts) {
    for (const key of ['providerId', 'modelId', 'mode', 'thinkingLevel']) assert.equal(Object.hasOwn(prompt, key), false);
  }
  assert.deepEqual(session, { id: 'session-1', title: '首次默认模型', providerId: 'explicit', modelId: 'changed', mode: 'goal', thinkingLevel: 'low' });
});

test('关联会话发送失败重试保持 messageId，回执丢失后重开不重复投递', async (t) => {
  const { chat, pi, data, root } = await fixture(t);
  await chat.send({ text: '首次消息', modelKey: '', requestId: 'seed' });
  const input = { text: '关联会话重试', modelKey: '', requestId: 'reject' };
  data.failure = 'reject';
  await assert.rejects(chat.send(input), { code: 'PET_SEND_REJECTED' });
  const messageId = data.prompts[1].messageId;
  data.failure = 'lost-receipt';
  await assert.rejects(chat.send({ ...input, requestId: 'retry' }), /宿主回执丢失/);
  assert.equal(data.prompts[2].messageId, messageId);
  const reopened = new QuickChat(pi, path.join(root, 'data')); await reopened.init();
  data.failure = null;
  assert.deepEqual(await reopened.send({ ...input, requestId: 'recover' }), { sessionId: 'session-1' });
  assert.deepEqual(await reopened.send(input), { sessionId: 'session-1' });
  assert.equal(data.created.length, 1); assert.equal(data.prompts.length, 3);
  assert.ok(data.prompts.every((prompt) => prompt.sessionId === 'session-1'));
  assert.equal(data.messages.filter((message) => message.id === messageId).length, 1);
  assert.equal(reopened.pending, null); assert.equal(reopened.getDraft().text, '');
});

test('关联会话删除或查询失败时明确报错，保留原草稿且不新建会话', async (t) => {
  for (const missing of [true, false]) {
    await t.test(missing ? '会话已删除' : '会话查询不可用', async (t) => {
      const { chat, pi, data, root } = await fixture(t);
      await chat.send({ text: '建立关联', modelKey: '', requestId: 'seed' });
      const attachments = [{ name: 'draft.txt', dataBase64: Buffer.from('草稿').toString('base64') }];
      const input = { text: '保留这条消息', modelKey: '', attachments, skills: ['skill:review'], requestId: 'unavailable' };
      await chat.saveDraft(input);
      const original = chat.getDraft();
      if (missing) data.sessions.delete('session-1');
      else data.lookupError = Object.assign(new Error('关联会话查询不可用'), { code: 'HOST_UNAVAILABLE' });
      await assert.rejects(chat.send(input), { code: missing ? 'PET_SESSION_MISSING' : 'HOST_UNAVAILABLE' });
      const reopened = new QuickChat(pi, path.join(root, 'data')); await reopened.init();
      const { sendError, ...saved } = reopened.getDraft();
      assert.match(sendError, /关联会话/); assert.deepEqual(saved, original);
      assert.equal(reopened.pending, null);
      assert.equal(data.created.length, 1); assert.equal(data.prompts.length, 1);
      assert.equal(data.calls.filter((call) => call.operation === 'session/getScratchPath').length, 0);
    });
  }
});
