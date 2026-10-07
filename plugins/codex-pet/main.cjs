'use strict';

const { execFile } = require('node:child_process');
const { PetLibrary, fail } = require('./lib/pet-library.cjs');
const { QuickChat } = require('./lib/quick-chat.cjs');
const { ActivityMonitor } = require('./lib/activity.cjs');
const { importInstallLink } = require('./lib/install-link.cjs');

const SERVICE = 'codex-pet-activity';
const SHORTCUT = 'show-pet';
const DEFAULTS = { selectedPetId: null, visible: true, size: 96, alwaysOnTop: true, filter: 'pixelated', motion: 'system', frameRate: null, gaze: true, position: null, pollSeconds: 8, shortcut: process.platform === 'darwin' ? 'Alt+Space' : 'Super+Alt+P' };

function createPlugin(providedHost) {
  let host, library, chat, monitor, ready, unloaded = false;
  let settings = { ...DEFAULTS }, locale = 'zh-CN', models = [], commands = [], warnings = [];
  let shortcutRegistered = false, registeredCommands = [], serviceRegistered = false;
  let settingsQueue = Promise.resolve();
  let openTimer;
  const intent = { settings: 0, focus: 0 };
  function state() {
    return { locale, settings: { ...settings }, pets: library?.list() || [], activity: monitor?.getState() || { rows: [], state: null, stale: false, updatedAt: null, error: null }, models, commands, draft: chat?.getDraft() || { text: '', attachments: [], skills: [], modelKey: '' }, warnings: [...warnings], libraryErrors: library?.errors || [], intent: { ...intent } };
  }
  function localError(error) {
    if (locale === 'en' && error.enMessage) error.message = error.enMessage;
    return error;
  }
  async function setShortcut(accelerator) {
    if (shortcutRegistered) { await host.keyboard.unregisterGlobalShortcut(SHORTCUT); shortcutRegistered = false; }
    if (accelerator) {
      await host.keyboard.registerGlobalShortcut({ id: SHORTCUT, accelerator, command: 'codex-pet.show' });
      shortcutRegistered = true;
    }
  }
  async function saveSettings(patch = {}) {
    const run = settingsQueue.then(async () => {
      const next = { ...settings };
      for (const key of ['visible', 'alwaysOnTop', 'gaze']) if (typeof patch[key] === 'boolean') next[key] = patch[key];
      if (patch.selectedPetId === null || (typeof patch.selectedPetId === 'string' && library.list().some((pet) => pet.id === patch.selectedPetId))) next.selectedPetId = patch.selectedPetId;
      if (Number.isFinite(patch.size)) next.size = Math.round(Math.max(32, Math.min(256, patch.size)));
      if (Number.isFinite(patch.pollSeconds)) next.pollSeconds = Math.max(2, Math.min(60, patch.pollSeconds));
      if (patch.frameRate === null) next.frameRate = null;
      else if (Number.isFinite(patch.frameRate)) next.frameRate = Math.round(Math.max(1, Math.min(60, patch.frameRate)));
      if (['pixelated', 'smooth'].includes(patch.filter)) next.filter = patch.filter;
      if (['system', 'reduce', 'full'].includes(patch.motion)) next.motion = patch.motion;
      if (patch.position === null || (Number.isFinite(patch.position?.x) && Number.isFinite(patch.position?.y))) next.position = patch.position;
      if (typeof patch.shortcut === 'string') next.shortcut = patch.shortcut.trim();
      if (next.shortcut !== settings.shortcut) {
        try { await setShortcut(next.shortcut); } catch (error) {
          await setShortcut(settings.shortcut).catch(() => {});
          throw error;
        }
      }
      await host.plugin.setSettings(next);
      settings = next;
      monitor.setPollSeconds(settings.pollSeconds);
      return state();
    });
    settingsQueue = run.catch(() => {});
    return run;
  }
  async function show(focus = false) {
    await saveSettings({ visible: true });
    if (focus) intent.focus += 1;
    await host.ui.openPanel();
  }
  async function hide() { await saveSettings({ visible: false }); await host.ui.closePanel(); }
  async function refreshCatalog() {
    const result = await Promise.allSettled([host.models.list(), host.desktop.invoke({ operation: 'composer/commands', args: [{ temporaryWorkspacePath: null }] })]);
    if (result[0].status === 'fulfilled') models = result[0].value.map((model) => ({ key: model.key, label: model.alias || model.label || model.modelId, providerLabel: model.providerName || model.providerId }));
    if (result[1].status === 'fulfilled') commands = Array.isArray(result[1].value) ? result[1].value : result[1].value?.commands || [];
    for (const item of result) if (item.status === 'rejected') warnings.push(localError(item.reason).message);
  }
  async function init() {
    unloaded = false;
    host = providedHost || globalThis.pi;
    if (!host?.desktop?.getSessionSnapshot) fail('PET_HOST_VERSION', '请更新主程序后再使用宠物插件。', 'Update the desktop app before using this plugin.');
    locale = (await host.app.getLocale()) === 'en' ? 'en' : 'zh-CN';
    settings = { ...DEFAULTS, ...(await host.plugin.getSettings()) };
    const dataPath = await host.plugin.getDataPath();
    library = new PetLibrary(dataPath);
    chat = new QuickChat(host, dataPath);
    monitor = new ActivityMonitor(host, { pollSeconds: settings.pollSeconds });
    await Promise.all([library.init(), chat.init(), refreshCatalog()]);
    if (!library.list().some((pet) => pet.id === settings.selectedPetId)) settings.selectedPetId = null;
    for (const [id, title, run] of [
      ['pet', locale === 'en' ? 'Show or hide pet' : '显示或隐藏宠物', () => settings.visible ? hide() : show()],
      ['codex-pet.show', locale === 'en' ? 'Show pet' : '显示宠物', () => show(true)],
      ['codex-pet.hide', locale === 'en' ? 'Hide pet' : '隐藏宠物', hide],
      ['codex-pet.settings', locale === 'en' ? 'Pet settings' : '宠物设置', async () => { intent.settings += 1; await show(); }],
    ]) {
      await host.commands.register({ id, title, keywords: ['宠物', 'Codex', 'pet'], run });
      registeredCommands.push(id);
    }
    try { await setShortcut(settings.shortcut); } catch (error) { warnings.push(localError(error).message); }
    host.services.register({ id: SERVICE, start: () => monitor.start(), stop: () => monitor.stop() });
    serviceRegistered = true;
    await monitor.start();
    // 先完成插件加载再打开页面，避免页面 bootstrap 与 onLoad 互相等待。
    if (!unloaded && settings.visible) openTimer = setTimeout(() => { if (!unloaded) void host.ui.openPanel().catch((error) => warnings.push(localError(error).message)); }, 0);
  }
  async function onLoad() {
    if (!ready) ready = init();
    return ready;
  }
  async function onUnload() {
    unloaded = true;
    clearTimeout(openTimer);
    await ready?.catch(() => {});
    await monitor?.stop();
    if (serviceRegistered) { await host.services.unregister(SERVICE); serviceRegistered = false; }
    if (shortcutRegistered) await host.keyboard.unregisterGlobalShortcut(SHORTCUT);
    shortcutRegistered = false;
    await Promise.all(registeredCommands.map((id) => host.commands.unregister(id)));
    registeredCommands = [];
    await chat?.flush();
    await settingsQueue;
    ready = null;
  }
  async function selectAfterImport(ids) {
    if (ids.length) await saveSettings({ selectedPetId: ids[0] });
  }
  async function onPanelInvoke(channel, payload = {}) {
    if (unloaded) fail('PET_UNLOADED', '宠物插件已停止。', 'The pet plugin has stopped.');
    await onLoad();
    try {
      switch (channel) {
        case 'pet.state': locale = (await host.app.getLocale()) === 'en' ? 'en' : 'zh-CN'; return state();
        case 'pet.activity': return monitor.getState();
        case 'pet.asset': return await library.asset(payload.id);
        case 'pet.importDirectory': {
          const selected = await host.fs.requestDirectory();
          if (!selected) return { cancelled: true, imported: [], errors: [], state: state() };
          const result = await library.importDirectory(selected.path);
          await selectAfterImport(result.imported);
          return { ...result, state: state() };
        }
        case 'pet.importFiles': {
          const result = await library.importFiles(payload.files);
          await selectAfterImport(result.imported);
          return { ...result, state: state() };
        }
        case 'pet.importLink': {
          const id = await importInstallLink(library, payload.url);
          await selectAfterImport([id]);
          return { imported: [id], errors: [], state: state() };
        }
        case 'pet.create': { const id = await library.create(payload); await selectAfterImport([id]); return state(); }
        case 'pet.export': return await library.export(payload.id);
        case 'pet.remove': await library.remove(payload.id); if (settings.selectedPetId === payload.id) await saveSettings({ selectedPetId: null }); return state();
        case 'pet.select': return await saveSettings({ selectedPetId: payload.id });
        case 'pet.settings': return await saveSettings(payload.patch);
        case 'pet.position': return await saveSettings({ position: payload.position || { x: payload.x, y: payload.y } });
        case 'pet.resetPosition': return await saveSettings({ position: null });
        case 'pet.show': await show(); return state();
        case 'pet.hide': await hide(); return state();
        case 'pet.openSettings': intent.settings += 1; await show(); return state();
        case 'pet.focusComposer': intent.focus += 1; await show(); return state();
        case 'pet.refresh': await Promise.all([library.refresh(), monitor.refresh(), refreshCatalog()]); if (!library.list().some((pet) => pet.id === settings.selectedPetId)) await saveSettings({ selectedPetId: null }); return state();
        case 'pet.draft': await chat.saveDraft(payload); return state();
        case 'pet.commands': return commands;
        case 'pet.send': { const receipt = await chat.send(payload); await monitor.refresh(); return { ...receipt, state: state() }; }
        case 'pet.openSession': {
          if (typeof host.ui.showMainWindow !== 'function') fail('PET_HOST_VERSION', '请更新主程序以使用点击宠物唤起会话功能。', 'Update the desktop app to open the main window from the pet.');
          const activity = monitor.getState();
          const sessionId = payload.sessionId || activity.output?.sessionId || chat.getDraft().sessionId || activity.rows[0]?.sessionId;
          await host.ui.showMainWindow();
          if (sessionId) {
            await host.desktop.invoke({ operation: 'session/open', args: [sessionId] });
            await monitor.markRead(sessionId);
          }
          return state();
        }
        case 'pet.markRead': await monitor.markRead(payload.sessionId); return state();
        case 'pet.markAllRead': await monitor.markAllRead(); return state();
        case 'pet.revealLibrary': {
          const program = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
          await new Promise((resolve, reject) => execFile(program, [library.directory], (error) => error ? reject(error) : resolve()));
          return { ok: true };
        }
        default: fail('PET_ACTION_UNKNOWN', '未知宠物操作。', 'Unknown pet action.');
      }
    } catch (error) { throw localError(error); }
  }
  return { onLoad, onUnload, onPanelInvoke };
}

module.exports = { ...createPlugin(), createPlugin, DEFAULTS };
