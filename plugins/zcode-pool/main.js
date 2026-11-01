'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectLocal, redact } = require('./lib/local');
const { ZcodeRuntime } = require('./lib/runtime');
const { createGateway, ENDPOINT, usageOf } = require('./lib/gateway');
const SERVICE = 'zcode-host';
const PROVIDER_ID = 'zcode-start-plan';
const defaults = { enabled: false, cliPath: '', nodePath: 'node', dataBaseDir: '', allowTools: false, disabledModels: [] };
let settings = { ...defaults }, dataPath = '', phase = 'stopped', lastError = '';
let local = { client: { found: false, path: '', version: '' }, account: { available: false, label: '尚未检查', expiresAt: null } };
let models = [], runtime = null, gateway = null, starting = null, stopping = null;
let generation = 0, unloaded = false, controlTail = Promise.resolve(), hostDeclaration = '', requiresReload = false;
let startIntent = 0, persistence = Promise.resolve();
const logs = [], requests = new Set();
const stats = { requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
function normalize(value = {}) {
  const next = { ...defaults };
  next.enabled = value.enabled === true;
  next.allowTools = value.allowTools === true;
  for (const key of ['cliPath', 'nodePath', 'dataBaseDir']) next[key] = typeof value[key] === 'string' ? value[key].trim() : defaults[key];
  next.nodePath ||= 'node';
  next.disabledModels = Array.isArray(value.disabledModels) ? [...new Set(value.disabledModels.filter(id => typeof id === 'string'))] : [];
  return next;
}
function log(level, value) {
  logs.push({ at: Date.now(), level, message: redact(value) });
  if (logs.length > 100) logs.splice(0, logs.length - 100);
}
function listedModels() { return models.map(model => ({ ...model, enabled: !settings.disabledModels.includes(model.id) })); }
function snapshot() {
  return { phase, enabled: settings.enabled, endpoint: ENDPOINT, client: local.client, account: local.account,
    models: listedModels(), activeRequests: requests.size, stats: { ...stats }, lastError, logs: [...logs],
    settings: { cliPath: settings.cliPath, nodePath: settings.nodePath, dataBaseDir: settings.dataBaseDir, allowTools: settings.allowTools }, requiresReload };
}
function save(patch) {
  const operation = persistence.catch(() => {}).then(async () => {
    const previous = settings;
    const next = normalize({ ...settings, ...patch });
    settings = next;
    try { await pi.plugin.setSettings(patch); }
    catch (error) { if (settings === next) settings = previous; throw error; }
  });
  persistence = operation.catch(() => {});
  return operation;
}
function controlled(operation) {
  const next = controlTail.catch(() => {}).then(() => { if (unloaded) throw new Error('插件已停用'); return operation(); });
  controlTail = next.catch(() => {});
  return next;
}
async function refreshLocal() {
  const current = generation;
  const result = await inspectLocal(settings);
  if (!unloaded && current === generation) {
    local = result;
    if (phase === 'stopped') lastError = result.error || '';
  }
  return result;
}
function publishModels() {
  if (!models.length || unloaded) return;
  fs.writeFileSync(path.join(dataPath, 'model-catalog.json'), JSON.stringify(models, null, 2) + '\n', 'utf8');
  const manifestPath = path.join(__dirname, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const enabled = listedModels().filter(model => model.enabled);
  const providers = enabled.length ? [{ id: PROVIDER_ID, name: 'ZCode Pool · Start Plan', baseUrl: ENDPOINT, apiStyle: 'chat_completions', authKind: 'none',
    models: enabled.map(model => ({ id: model.id, name: `${model.id} · ZCode`, contextWindow: model.contextWindow, maxTokens: model.maxTokens, supportsImages: false,
      thinkingLevels: model.thinkingLevels, defaultThinkingLevel: model.defaultThinkingLevel || model.thinkingLevels[0] || 'off' })) }] : [];
  const declaration = JSON.stringify(providers);
  requiresReload = declaration !== hostDeclaration;
  if (JSON.stringify(manifest.contributes.providers || []) === declaration) return;
  manifest.contributes.providers = providers;
  const temporary = manifestPath + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, manifestPath);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  log('info', '模型声明已更新，重载插件后同步到模型选择器');
}
async function execute(input) {
  if (phase !== 'ready' || !runtime || runtime.closed) throw new Error('请先启动 ZCode 桥接');
  if (!listedModels().some(model => model.id === input.model && model.enabled)) throw new Error('模型不存在或已关闭');
  const currentRuntime = runtime;
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  requests.add(controller);
  stats.requests++;
  try {
    const result = await currentRuntime.execute({ ...input, signal: controller.signal });
    const usage = usageOf(result.usage);
    stats.successes++;
    stats.inputTokens += usage.prompt_tokens;
    stats.outputTokens += usage.completion_tokens;
    log('info', `${input.model} 完成 · 输入 ${usage.prompt_tokens} / 输出 ${usage.completion_tokens}`);
    return result;
  } catch (error) {
    stats.failures++;
    const safe = currentRuntime.safe(error);
    log(error.name === 'AbortError' ? 'info' : 'error', safe);
    if (error.name !== 'AbortError') lastError = safe;
    throw new Error(safe);
  } finally {
    requests.delete(controller);
    input.signal?.removeEventListener('abort', abort);
  }
}
async function startService(intent = startIntent) {
  if (unloaded || intent !== startIntent || !settings.enabled) return;
  if (stopping) await stopping;
  if (unloaded || intent !== startIntent || !settings.enabled) return;
  if (phase === 'ready' && runtime && !runtime.closed) return;
  if (starting) return starting;
  const current = ++generation;
  phase = 'starting';
  lastError = '';
  const operation = (async () => {
    let mine, listener;
    try {
      if (runtime) await runtime.stop();
      if (gateway) await gateway.close();
      runtime = null; gateway = null;
      const inspected = await inspectLocal(settings);
      if (unloaded || current !== generation) return;
      local = inspected;
      listener = await createGateway({ ready: () => phase === 'ready' && !runtime?.closed, models: listedModels, execute,
        onError: error => { lastError = error; log('error', error); } });
      if (unloaded || current !== generation) { await listener.close(); return; }
      gateway = listener;
      mine = new ZcodeRuntime(settings, local, dataPath, log, error => {
        if (current !== generation || unloaded || phase === 'stopping') return;
        lastError = mine.safe(error); phase = 'error'; log('error', lastError);
      });
      runtime = mine;
      await mine.start();
      if (unloaded || current !== generation) { await mine.stop(); await listener.close(); return; }
      if (mine.closed) throw new Error('客户端在启动完成前已退出');
      models = mine.models;
      phase = 'ready';
      publishModels();
    } catch (error) {
      const safe = mine ? mine.safe(error) : redact(error);
      if (mine) await mine.stop();
      if (listener) await listener.close();
      if (current === generation && !unloaded) {
        runtime = null; gateway = null; phase = 'error'; lastError = safe; log('error', safe);
      }
      throw new Error(safe);
    }
  })();
  starting = operation;
  try { await operation; }
  finally { if (starting === operation) starting = null; }
}
async function stopService() {
  if (stopping) return stopping;
  ++generation;
  phase = 'stopping';
  for (const request of requests) request.abort();
  const mine = runtime, listener = gateway, pendingStart = starting;
  runtime = null; gateway = null;
  const operation = (async () => {
    await Promise.allSettled([mine?.stop(), listener?.close()]);
    if (pendingStart) await pendingStart.catch(() => {});
    phase = 'stopped';
    log('info', '桥接服务已停止');
  })();
  stopping = operation;
  try { await operation; }
  finally { if (stopping === operation) stopping = null; }
}
async function changedSettings() {
  const intent = startIntent;
  await persistence;
  const next = normalize(await pi.plugin.getSettings());
  if (unloaded || intent !== startIntent || JSON.stringify(next) === JSON.stringify(settings)) return;
  await stopService();
  if (unloaded || intent !== startIntent) return;
  settings = next;
  await refreshLocal();
  if (settings.enabled) await startService(intent);
  else publishModels();
}
async function onLoad() {
  unloaded = false;
  settings = normalize(await pi.plugin.getSettings());
  dataPath = await pi.plugin.getDataPath();
  fs.mkdirSync(dataPath, { recursive: true });
  const manifest = pi.plugin.getManifest();
  hostDeclaration = JSON.stringify(manifest.contributes?.providers || []);
  models = (manifest.contributes?.providers || []).find(provider => provider.id === PROVIDER_ID)?.models || [];
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(dataPath, 'model-catalog.json'), 'utf8'));
    if (Array.isArray(cached) && cached.every(model => typeof model.id === 'string' && Array.isArray(model.thinkingLevels) && Number.isSafeInteger(model.contextWindow) && Number.isSafeInteger(model.maxTokens))) models = cached;
  } catch {}
  pi.events?.on('plugin:settingsChanged', settingsHandler);
  pi.services.register({ id: SERVICE, start: async () => { if (settings.enabled) await startService(); }, stop: () => { startIntent++; return stopService(); } });
  refreshLocal().catch(error => { lastError = redact(error); });
}
function settingsHandler() { controlled(changedSettings).catch(error => log('error', error)); }
async function onUnload() {
  unloaded = true;
  startIntent++;
  pi.events?.off('plugin:settingsChanged', settingsHandler);
  await stopService();
}
async function onPanelInvoke(channel, payload = {}) {
  if (unloaded) throw new Error('插件已停用');
  if (channel === 'zc.status') return snapshot();
  if (channel === 'zc.stop') {
    startIntent++;
    const stopped = stopService();
    await Promise.all([save({ enabled: false }), stopped]);
    return snapshot();
  }
  if (channel === 'zc.test') {
    const model = String(payload?.model || '');
    const began = Date.now();
    try {
      const result = await execute({ model, messages: [{ role: 'user', content: 'Reply with exactly OK. Do not use tools.' }], reasoning: 'low' });
      const usage = usageOf(result.usage);
      return { ok: true, text: result.text, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, elapsedMs: Date.now() - began };
    } catch (error) { return { ok: false, text: '', inputTokens: 0, outputTokens: 0, elapsedMs: Date.now() - began, error: redact(error) }; }
  }
  const intent = startIntent;
  return controlled(async () => {
    if (channel === 'zc.start') {
      if (intent !== startIntent) return snapshot();
      await save({ enabled: true });
      await startService(intent);
    }
    else if (channel === 'zc.refresh') {
      if (requests.size) throw new Error('请等待当前请求结束后再刷新');
      if (phase === 'ready' || phase === 'error') { await stopService(); if (settings.enabled && intent === startIntent) await startService(intent); }
      await refreshLocal();
    } else if (channel === 'zc.settings') {
      if (phase === 'ready' || phase === 'starting' || phase === 'stopping') throw new Error('请先停止桥接，再修改路径或工具执行设置');
      const patch = {};
      for (const key of ['cliPath', 'nodePath', 'dataBaseDir']) if (typeof payload[key] === 'string') patch[key] = payload[key].trim();
      if (typeof payload.allowTools === 'boolean') patch.allowTools = payload.allowTools;
      await save(patch); await refreshLocal();
    } else if (channel === 'zc.model') {
      if (requests.size) throw new Error('请等待当前请求结束后再修改模型');
      if (!models.some(model => model.id === payload.id) || typeof payload.enabled !== 'boolean') throw new Error('无效的模型设置');
      const disabled = new Set(settings.disabledModels);
      payload.enabled ? disabled.delete(payload.id) : disabled.add(payload.id);
      await save({ disabledModels: [...disabled] }); publishModels();
    } else if (channel === 'zc.logs.clear') logs.length = 0;
    else throw new Error('未知的面板操作');
    return snapshot();
  });
}
module.exports = { onLoad, onUnload, onPanelInvoke };
