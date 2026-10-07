'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { createPlugin, DEFAULTS } = require('../main.cjs');

function png() {
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1536); header.writeUInt32BE(1872, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc((1536 * 4 + 1) * 1872))), chunk('IEND', Buffer.alloc(0))]);
}
const sheet = png();
const files = (id) => [{ name: 'pet.json', dataBase64: Buffer.from(JSON.stringify({ id, displayName: id, spritesheetPath: 'sheet.png' })).toString('base64') }, { name: 'sheet.png', dataBase64: sheet.toString('base64') }];
async function fixture(t, settings = {}) {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须位于 PI_SCRATCH_DIR');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'pet-plugin-test-'));
  const data = { settings, commands: new Map(), services: new Map(), shortcuts: new Map(), shortcutCalls: [], calls: [], prompts: [], notes: [], saved: [], opened: 0, closed: 0, mainOpened: 0, conflict: null };
  const pi = {
    app: { getLocale: async () => 'zh-CN' },
    plugin: { getSettings: async () => data.settings, getDataPath: async () => root, setSettings: async (value) => { data.settings = { ...value }; data.saved.push({ ...value }); } },
    models: { list: async () => [{ key: 'provider/model', providerId: 'provider', modelId: 'model', label: '测试模型', isDefault: true }] },
    events: new EventEmitter(),
    commands: { register: async (command) => { assert.ok(!data.commands.has(command.id)); data.commands.set(command.id, command); }, unregister: async (id) => { data.commands.delete(id); } },
    keyboard: {
      registerGlobalShortcut: async (shortcut) => { data.shortcutCalls.push(shortcut); if (shortcut.accelerator === data.conflict) throw new Error('快捷键冲突'); data.shortcuts.set(shortcut.id, shortcut); },
      unregisterGlobalShortcut: async (id) => { data.shortcuts.delete(id); },
    },
    services: { register: (service) => { data.services.set(service.id, service); }, unregister: async (id) => { data.services.delete(id); } },
    ui: { openPanel: async () => { data.opened++; }, closePanel: async () => { data.closed++; }, showMainWindow: async () => { data.mainOpened++; } },
    fs: { requestDirectory: async () => null },
    desktop: { getSessionSnapshot: async () => { throw new Error('空列表不应读取快照'); }, invoke: async ({ operation, args }) => {
      data.calls.push({ operation, args });
      switch (operation) {
        case 'composer/commands': return [{ id: 'skill:review', label: '审查' }];
        case 'session/list': return { sessions: [] };
        case 'notification/list': return { notifications: data.notes.map((note) => ({ ...note })) };
        case 'settings/get': return { defaultMode: 'agent' };
        case 'session/create': return { session: { id: 'pet-session' } };
        case 'agent/prompt': data.prompts.push(args[0]); return { accepted: true };
        case 'session/open': return { ok: true };
        case 'notification/markRead': data.notes.find((note) => note.id === args[0].id).readAt = '2026-10-06T01:00:00.000Z'; return { ok: true };
        default: throw new Error(`未允许的调用 ${operation}`);
      }
    } },
  };
  const plugin = createPlugin(pi);
  t.after(async () => { await plugin.onUnload(); await fs.rm(root, { recursive: true, force: true }); });
  return { plugin, pi, data, root };
}

test('createPlugin 加载只注册一次，命令可执行，卸载停止全部 timer/listener 并释放注册', async (t) => {
  const handles = new Set(), cleared = new Set();
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => { const timer = originalTimeout(callback, ms, ...args); handles.add(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', (timer) => { cleared.add(timer); return originalClear(timer); });
  const { plugin, pi, data } = await fixture(t);
  await Promise.all([plugin.onLoad(), plugin.onLoad()]);
  await new Promise((resolve) => originalTimeout(resolve, 0));
  assert.deepEqual([...data.commands.keys()], ['pet', 'codex-pet.show', 'codex-pet.hide', 'codex-pet.settings']);
  assert.equal(data.shortcutCalls.length, 1); assert.equal(data.shortcuts.get('show-pet').accelerator, DEFAULTS.shortcut);
  assert.equal(data.services.size, 1); assert.equal(pi.events.listenerCount('desktop:event'), 1); assert.equal(data.opened, 1);
  await data.commands.get('codex-pet.hide').run(); assert.equal((await plugin.onPanelInvoke('pet.state')).settings.visible, false); assert.equal(data.closed, 1);
  await data.commands.get('pet').run(); assert.equal((await plugin.onPanelInvoke('pet.state')).settings.visible, true);
  await data.commands.get('codex-pet.show').run(); assert.equal((await plugin.onPanelInvoke('pet.state')).intent.focus, 1);
  await data.commands.get('codex-pet.settings').run(); assert.equal((await plugin.onPanelInvoke('pet.state')).intent.settings, 1);
  pi.events.emit('desktop:event', { kind: 'session.changed' });
  assert.ok(handles.size >= 2, '同时覆盖轮询 timer 和事件 hint timer');
  await plugin.onUnload();
  assert.equal(pi.events.listenerCount('desktop:event'), 0); assert.equal(data.commands.size, 0); assert.equal(data.shortcuts.size, 0); assert.equal(data.services.size, 0);
  assert.ok([...handles].every((timer) => cleared.has(timer)), '卸载必须取消全部已创建 timer');
  const calls = data.calls.length; pi.events.emit('desktop:event', { kind: 'session.changed' }); await new Promise((resolve) => setImmediate(resolve)); assert.equal(data.calls.length, calls);
});

test('shortcut 初始冲突提示 warning，更换冲突恢复原注册且不保存失败设置', async (t) => {
  const { plugin, data } = await fixture(t);
  data.conflict = DEFAULTS.shortcut; await plugin.onLoad();
  assert.deepEqual((await plugin.onPanelInvoke('pet.state')).warnings, ['快捷键冲突']); assert.equal(data.shortcuts.size, 0);
  data.conflict = null; await plugin.onPanelInvoke('pet.settings', { patch: { shortcut: 'Alt+Shift+P' } });
  data.conflict = 'Alt+Shift+Q'; const saves = data.saved.length;
  await assert.rejects(plugin.onPanelInvoke('pet.settings', { patch: { shortcut: data.conflict } }), /快捷键冲突/);
  assert.equal(data.saved.length, saves); assert.equal(data.shortcuts.get('show-pet').accelerator, 'Alt+Shift+P');
  assert.equal((await plugin.onPanelInvoke('pet.state')).settings.shortcut, 'Alt+Shift+P');
});

test('pet 状态读取、导入自动选择、切换和移除，卸载重开保留库与草稿', async (t) => {
  const { plugin } = await fixture(t, { selectedPetId: '不存在的旧宠物' }); await plugin.onLoad();
  const initial = await plugin.onPanelInvoke('pet.state'); assert.deepEqual(initial.pets, []); assert.equal(initial.settings.selectedPetId, null); assert.equal(initial.models[0].key, 'provider/model');
  const first = await plugin.onPanelInvoke('pet.importFiles', { files: files('first') }); assert.deepEqual(first.imported, ['first']); assert.equal(first.state.settings.selectedPetId, 'first');
  await plugin.onPanelInvoke('pet.importFiles', { files: files('second') });
  assert.equal((await plugin.onPanelInvoke('pet.select', { id: 'first' })).settings.selectedPetId, 'first');
  assert.equal((await plugin.onPanelInvoke('pet.asset', { id: 'first' })).manifest.id, 'first');
  assert.deepEqual((await plugin.onPanelInvoke('pet.export', { id: 'first' })).files.map((file) => file.name), ['pet.json', 'sheet.png']);
  const removed = await plugin.onPanelInvoke('pet.remove', { id: 'first' }); assert.equal(removed.settings.selectedPetId, null); assert.deepEqual(removed.pets.map((pet) => pet.id), ['second']);
  await plugin.onPanelInvoke('pet.draft', { text: '重开后继续', modelKey: 'provider/model' });
  await plugin.onUnload(); await plugin.onLoad();
  const reopened = await plugin.onPanelInvoke('pet.state'); assert.equal(reopened.draft.text, '重开后继续'); assert.deepEqual(reopened.pets.map((pet) => pet.id), ['second']);
});

test('pet.send 返回原 session，打开该会话并持久化通知已读', async (t) => {
  const { plugin, data } = await fixture(t); await plugin.onLoad();
  const receipt = await plugin.onPanelInvoke('pet.send', { text: '从宠物发出', requestId: 'pet-send' });
  assert.equal(receipt.sessionId, 'pet-session'); assert.equal(data.prompts.length, 1); assert.equal(data.prompts[0].sessionId, receipt.sessionId);
  data.notes.push({ id: 'pet-note', sessionId: receipt.sessionId, kind: 'task.completed', createdAt: '2026-10-06T00:00:00.000Z', readAt: null }, { id: 'other-note', sessionId: 'other-session', kind: 'task.completed', createdAt: '2026-10-06T00:00:00.000Z', readAt: null });
  const refreshed = await plugin.onPanelInvoke('pet.refresh'); assert.ok(refreshed.activity.rows.some((row) => row.sessionId === receipt.sessionId));
  const opened = await plugin.onPanelInvoke('pet.openSession', { sessionId: receipt.sessionId });
  assert.deepEqual(data.calls.find((call) => call.operation === 'session/open').args, [receipt.sessionId]);
  assert.ok(data.notes[0].readAt); assert.equal(data.notes[1].readAt, null);
  assert.ok(!opened.activity.rows.some((row) => row.sessionId === receipt.sessionId));
});

test('点击无关联宠物只唤起主窗口，发送后点击沿用关联会话', async (t) => {
  const { plugin, data } = await fixture(t); await plugin.onLoad();
  await plugin.onPanelInvoke('pet.openSession');
  assert.equal(data.mainOpened, 1);
  assert.ok(!data.calls.some((call) => ['session/create', 'session/open'].includes(call.operation)));
  await plugin.onPanelInvoke('pet.send', { text: '关联会话', requestId: 'linked' });
  await plugin.onPanelInvoke('pet.openSession');
  assert.equal(data.mainOpened, 2);
  assert.deepEqual(data.calls.find((call) => call.operation === 'session/open').args, ['pet-session']);
});

test('FPS 设置持久化且可恢复素材节奏；轻量活动接口不回传聊天草稿', async (t) => {
  const { plugin, data } = await fixture(t); await plugin.onLoad();
  const original = await plugin.onPanelInvoke('pet.state'); assert.equal(original.settings.frameRate, null);
  const fast = await plugin.onPanelInvoke('pet.settings', { patch: { frameRate: 24 } }); assert.equal(fast.settings.frameRate, 24);
  assert.equal(data.settings.frameRate, 24);
  await plugin.onUnload(); await plugin.onLoad();
  assert.equal((await plugin.onPanelInvoke('pet.state')).settings.frameRate, 24);
  assert.equal((await plugin.onPanelInvoke('pet.settings', { patch: { frameRate: null } })).settings.frameRate, null);
  const activity = await plugin.onPanelInvoke('pet.activity'); assert.ok(Array.isArray(activity.rows)); assert.equal(activity.draft, undefined);
});
