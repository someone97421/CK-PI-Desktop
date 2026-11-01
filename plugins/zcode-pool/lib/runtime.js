'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID, createHash } = require('node:crypto');
const { PROVIDER, dataRoot, expand, readAccount, redact, modelCatalog, runFile } = require('./local');

function abortError() { const error = new Error('请求已取消'); error.name = 'AbortError'; return error; }
function checked(signal) { if (signal?.aborted) throw abortError(); }
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('消息内容必须是文本');
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    throw new Error('当前桥接仅支持文本消息，请移除图片、音频或文件内容块');
  }).join('\n');
}
function conversation(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages 不能为空');
  const roles = { system: '系统', developer: '开发者', user: '用户', assistant: '助手', tool: '工具结果' };
  return messages.map(message => {
    if (!message || !roles[message.role]) throw new Error('不支持的消息角色');
    const parts = [textOf(message.content)];
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) parts.push(JSON.stringify({ tool: call.function?.name, arguments: call.function?.arguments, id: call.id }));
    }
    return `【${roles[message.role]}${message.tool_call_id ? ` ${message.tool_call_id}` : ''}】\n${parts.filter(Boolean).join('\n')}`;
  }).join('\n\n');
}
function childEnvironment(settings, local) {
  const env = {};
  const base = /^(path|pathext|systemroot|systemdrive|windir|comspec|homedrive|homepath|userprofile|home|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|temp|tmp|tmpdir|lang|lc_all|lc_ctype|username|userdomain|computername|processor_architecture|node_extra_ca_certs|https?_proxy|all_proxy|no_proxy)$/i;
  for (const [key, value] of Object.entries(process.env)) if (base.test(key) && value !== undefined) env[key] = value;
  if (process.env.ZCODE_CREDENTIAL_SECRET) env.ZCODE_CREDENTIAL_SECRET = process.env.ZCODE_CREDENTIAL_SECRET;
  env.ZCODE_SERVICE_AUTHORITY_MODE = 'desktop-local';
  env.ZCODE_BASE_URL = 'https://zcode.z.ai';
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = local.builtin.file;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(dataRoot(settings), 'provider_config.json');
  env.ZCODE_DATA_BASE_DIR = path.dirname(path.dirname(dataRoot(settings)));
  if (local.builtin.version) env.ZCODE_APP_VERSION = local.builtin.version;
  return env;
}
class ZcodeRuntime {
  constructor(settings, local, dataPath, onLog, onExit) {
    this.settings = { ...settings };
    this.local = local;
    this.dataPath = dataPath;
    this.log = onLog;
    this.onExit = onExit;
    this.child = null;
    this.closed = false;
    this.pending = new Map();
    this.turns = new Map();
    this.sessions = new Set();
    this.counter = 1;
    this.models = [];
    this.secrets = new Set();
  }
  safe(error) {
    let text = String(error?.message || error || '');
    for (const secret of this.secrets) text = text.split(secret).join('[凭据已隐藏]');
    return redact(text);
  }
  rememberAccount() {
    const account = readAccount(this.settings);
    this.secrets.add(account.token);
    return account;
  }
  async start() {
    if (!this.local.client.found) throw new Error('未找到 ZCode 客户端，请填写 zcode.cjs 路径');
    if (!this.local.builtin) throw new Error('未找到包含 Start Plan 的客户端配置，请先启动最新版 ZCode');
    this.rememberAccount();
    const node = expand(this.settings.nodePath) || 'node';
    const { stdout } = await runFile(node, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    if (Number(stdout.trim().replace(/^v/, '').split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本');
    if (this.closed) throw abortError();
    this.workspace = path.join(this.dataPath, 'workspace');
    fs.mkdirSync(this.workspace, { recursive: true });
    const child = spawn(node, [this.local.client.path, 'app-server', '--surface', 'terminal', '--no-color'], {
      cwd: this.workspace, env: childEnvironment(this.settings, this.local), windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', text => { stderr = (stderr + this.safe(text)).slice(-1200); });
    createInterface({ input: child.stdout }).on('line', line => this.receive(line));
    const died = error => {
      const reason = new Error(this.safe(error));
      for (const entry of this.pending.values()) entry.reject(reason);
      this.pending.clear();
      for (const turn of this.turns.values()) turn.reject(reason);
      if (!this.closed) { this.closed = true; this.onExit?.(reason); }
    };
    child.on('error', error => died(error));
    child.on('exit', (code, signal) => died(new Error(`ZCode 已退出（${code ?? signal}）${stderr ? `：${stderr}` : ''}`)));
    await this.rpc('provider/updateAccountConfig', {
      revision: `zcode-pool:${randomUUID()}`,
      basedOnZCodeBuiltinRevision: this.local.builtin.revision,
      providers: { [PROVIDER]: { access: { type: 'zhipu-account', entitled: true }, builtinModelIds: this.local.builtin.ids } },
      states: { [PROVIDER]: { availability: 'available', entitled: true, current: true } },
    });
    // 账号声明接收与 registry 发布分离；只重试目录读取，不重试模型调用。
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.closed) throw abortError();
      const session = await this.createSession();
      try { this.models = modelCatalog(session); }
      finally { await this.closeSession(session.session.sessionId); }
      if (this.closed) throw new Error('读取目录时客户端已停止');
      if (this.models.length) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!this.models.length) throw new Error('客户端未发布 Start Plan 模型，未启用其他来源');
    this.log('info', `已连接 ZCode ${this.local.client.version || ''}，目录中有 ${this.models.length} 个 Start Plan 模型`);
  }
  write(message) {
    if (this.closed || !this.child || this.child.stdin.destroyed) throw new Error('ZCode 进程未运行');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  rpc(method, params, timeout = 35000, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    const id = this.counter++;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
        this.pending.delete(id);
      };
      const cancelled = () => { cleanup(); reject(abortError()); };
      timer = setTimeout(() => { cleanup(); reject(new Error(`${method} 超时`)); }, timeout);
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', cancelled, { once: true });
      try { checked(signal); this.write({ id, method, params }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(this.safe(message.error.message || 'ZCode RPC 失败')));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      try { this.write({ id: message.id, result: this.reply(message.method, message.params) }); }
      catch (error) { this.log('warn', this.safe(error)); }
      return;
    }
    if (message.method !== 'session/event') return;
    const params = message.params || {};
    const turn = this.turns.get(params.sessionId);
    if (!turn) return;
    const payload = params.payload || {};
    try {
      if (params.type === 'model.streaming' && !payload.done) {
        if (payload.kind === 'text_delta' || payload.kind === 'reasoning_delta') turn.delta(payload.kind, String(payload.delta || ''));
      } else if (params.type === 'turn.completed') {
        if (payload.resultType !== 'success') turn.reject(new Error('ZCode 未成功完成本轮请求'));
        else turn.resolve({ text: String(payload.response || ''), usage: payload.usage || {} });
      } else if (params.type === 'turn.failed') turn.reject(new Error(this.safe(payload.error?.message || payload.error?.code || 'ZCode 请求失败')));
    } catch (error) { turn.reject(error); }
  }
  reply(method, params) {
    if (method === 'session/requestRuntimePreferences') return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' };
    if (/permission|approval/i.test(method)) {
      const known = method === 'interaction/requestPermission' && (!params?.approvalMode || params.approvalMode === 'user-once');
      return { decision: known && this.settings.allowTools ? 'allow' : 'deny' };
    }
    if (method === 'interaction/browserList') return { browsers: [] };
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      if (params?.providerId && params.providerId !== PROVIDER) return { headersApplied: false, errorMessage: '仅提供 Start Plan 鉴权' };
      try {
        const auth = this.rememberAccount();
        const version = this.local.client.version;
        return { headersApplied: true, requestAuth: { apiKey: auth.token, headers: {
          'http-referer': 'https://zcode.z.ai', 'x-title': 'Z Code@cli',
          ...(version ? { 'user-agent': `ZCode/${version}`, 'x-zcode-app-version': version } : {}),
        } } };
      } catch (error) { return { headersApplied: false, errorMessage: this.safe(error) }; }
    }
    return {};
  }
  async createSession(workspacePath = this.workspace, sessionId = 'panel') {
    if (!path.isAbsolute(workspacePath) || !fs.statSync(workspacePath).isDirectory()) throw new Error('会话工作目录不存在或不是绝对目录');
    const directory = fs.realpathSync(workspacePath);
    const workspaceKey = `local.zcode-pool:${createHash('sha256').update(JSON.stringify([sessionId, directory])).digest('hex')}`;
    const session = await this.rpc('session/create', { workspace: { workspacePath: directory, workspaceKey } });
    const id = session?.session?.sessionId;
    if (typeof id !== 'string' || !id) throw new Error('客户端没有返回会话 ID');
    this.sessions.add(id);
    return session;
  }
  async closeSession(id) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    if (this.closed) return;
    try { await this.rpc('session/close', { sessionId: id }, 5000); }
    catch (error) {
      const failure = new Error(`会话关闭失败，客户端已停止：${this.safe(error)}`);
      if (!this.closed) this.onExit?.(failure);
      await this.stop();
    }
  }
  async execute({ model, messages, reasoning, signal, onDelta, workspacePath, sessionId }) {
    checked(signal);
    const content = conversation(messages);
    const route = this.models.find(entry => entry.id === model);
    if (!route) throw new Error('所选模型不在当前 Start Plan 目录中');
    this.rememberAccount();
    const session = await this.createSession(workspacePath, sessionId);
    const id = session.session.sessionId;
    let timer, rejectTurn, sending = false;
    const cancel = () => rejectTurn?.(abortError());
    try {
      checked(signal);
      await this.rpc('session/subscribe', { sessionId: id, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true }, 35000, signal);
      checked(signal);
      await this.rpc('session/setMode', { sessionId: id, mode: 'build' }, 35000, signal);
      const level = route.thinkingLevels.includes(reasoning) ? reasoning : route.defaultThinkingLevel;
      await this.rpc('session/setModel', { sessionId: id, model: { providerId: PROVIDER, modelId: model, options: { reasoningLevel: level } } }, 35000, signal);
      checked(signal);
      const completed = new Promise((resolve, reject) => {
        rejectTurn = reject;
        this.turns.set(id, { resolve, reject, delta: (kind, text) => { checked(signal); onDelta?.(kind, text); } });
        timer = setTimeout(() => reject(new Error('ZCode 请求超过 15 分钟，已停止')), 900000);
      });
      completed.catch(() => {});
      signal?.addEventListener('abort', cancel, { once: true });
      checked(signal);
      sending = true;
      await this.rpc('session/send', { sessionId: id, content }, 35000, signal);
      return await completed;
    } catch (error) {
      if (sending && !this.closed) await this.rpc('session/stop', { sessionId: id }, 5000).catch(() => this.stop());
      throw error.name === 'AbortError' ? error : new Error(this.safe(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.turns.delete(id);
      await this.closeSession(id);
    }
  }
  async stop() {
    this.closed = true;
    const error = abortError();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const turn of this.turns.values()) turn.reject(error);
    this.sessions.clear();
    const child = this.child;
    if (child && child.exitCode === null && child.pid) {
      if (process.platform === 'win32') {
        await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 7000, maxBuffer: 65536 }).catch(() => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
    }
    this.child = null;
    this.secrets.clear();
  }
}
module.exports = { ZcodeRuntime, conversation };
