'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const PROVIDER = 'account:zai-start-plan';

function expand(value) {
  const text = String(value || '').trim();
  return text.startsWith('~/') || text.startsWith('~\\') ? path.join(os.homedir(), text.slice(2)) : text;
}
function dataRoot(settings) {
  return path.resolve(expand(settings.dataBaseDir) || process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'v2');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function directories(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } }
function versionCompare(a, b) {
  const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
function findProvider(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.providerId === PROVIDER && Array.isArray(value.config?.builtinModelIds)) return value.config;
  for (const child of Object.values(value)) {
    const found = findProvider(child);
    if (found) return found;
  }
  return null;
}
function readAccount(settings) {
  let stored;
  try { stored = readJson(path.join(dataRoot(settings), 'credentials.json')); }
  catch { throw new Error('找不到 ZCode 登录文件，请先在 ZCode 中登录'); }
  let username = 'unknown';
  try { username = os.userInfo().username; } catch {}
  const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${process.platform}:${os.homedir()}:${username}`;
  const key = crypto.createHash('sha256').update(secret).digest();
  function decode(value) {
    if (typeof value !== 'string') return '';
    if (!value.startsWith('enc:v1:')) return value;
    const parts = value.slice(7).split('.');
    if (parts.length !== 3) throw new Error('ZCode 凭据格式无法识别');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
    } catch { throw new Error('ZCode 凭据无法解密，请检查数据目录和当前系统用户'); }
  }
  const token = decode(stored.zcodejwttoken);
  if (!token) throw new Error('ZCode 尚未保存 Start Plan 登录凭据');
  let expiresAt = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
  } catch {}
  return { token, expiresAt, label: '本机 ZCode 登录', available: true };
}
function redact(value, token) {
  let text = String(value?.message || value || '');
  if (token) text = text.split(token).join('[凭据已隐藏]');
  return text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[凭据已隐藏]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|zcodejwttoken)\s*[=:]\s*)[^\s,;}]+/gi, '$1[已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]').slice(0, 600);
}
async function locateCli(settings) {
  const configured = expand(settings.cliPath);
  if (configured) return { found: isFile(configured), path: path.resolve(configured) };
  const candidates = [process.env.ZCODE_CLI_PATH];
  if (process.platform === 'win32') {
    try {
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'ZCode.exe'\" | Select-Object -ExpandProperty ExecutablePath -Unique"], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
      for (const exe of stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) candidates.push(path.join(path.dirname(exe), 'resources', 'glm', 'zcode.cjs'));
    } catch {}
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'zcode-app-cli', 'dist', 'zcode.cjs'));
    for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      candidates.push(`${drive}:\\ZCode\\resources\\glm\\zcode.cjs`, `${drive}:\\APPS\\ZCode\\resources\\glm\\zcode.cjs`);
    }
  } else {
    candidates.push('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', path.join(os.homedir(), 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'));
  }
  const found = candidates.find(file => file && isFile(file));
  return { found: Boolean(found), path: found || '' };
}
function builtinFor(settings, cliPath) {
  const platform = process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `${process.platform}-${process.arch}`;
  const root = path.join(dataRoot(settings), 'runtime', 'provider', platform);
  const versions = directories(root).filter(v => /^\d+\.\d+\.\d+/.test(v) && v !== '0.0.0-dev').sort((a, b) => versionCompare(b, a));
  const candidates = [];
  for (const version of versions) {
    for (const endpoint of directories(path.join(root, version))) candidates.push({ version, file: path.join(root, version, endpoint, 'zcode-builtin.json') });
  }
  if (cliPath) candidates.push({ version: '', file: path.resolve(path.dirname(cliPath), '../config/provider/zcode-builtin.json') }, { version: '', file: path.join(path.dirname(cliPath), 'provider/zcode-builtin.json') });
  for (const entry of candidates) {
    if (!isFile(entry.file)) continue;
    try {
      const release = readJson(entry.file);
      const provider = findProvider(release);
      if (provider?.api?.baseUrl !== 'https://zcode.z.ai/api/v1/zcode-plan/anthropic') continue;
      const ids = provider.builtinModelIds.filter(id => typeof id === 'string' && id.length < 160);
      if (!ids.length) continue;
      return { ...entry, ids, revision: `zcode-builtin:${release.revision}:${crypto.createHash('sha256').update(path.resolve(entry.file)).digest('hex')}` };
    } catch {}
  }
  return null;
}
async function inspectLocal(settings) {
  const client = await locateCli(settings);
  const builtin = builtinFor(settings, client.path);
  let account, error = '';
  try { const found = readAccount(settings); account = { available: found.available, label: found.label, expiresAt: found.expiresAt }; }
  catch (err) { account = { available: false, label: '尚未登录', expiresAt: null }; error = redact(err); }
  return { client: { ...client, version: builtin?.version || '' }, builtin, account, error };
}
function modelCatalog(created) {
  const entries = created?.settings?.model?.available;
  if (!Array.isArray(entries)) return [];
  return entries.filter(e => e?.ref?.providerId === PROVIDER).map(e => {
    const levels = (e.reasoning?.levels || []).map(x => typeof x === 'string' ? x : x.value).filter(x => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(x));
    return {
      id: e.ref.modelId, name: typeof e.label === 'string' ? e.label : e.ref.modelId,
      contextWindow: Number.isSafeInteger(e.contextWindow) && e.contextWindow > 0 ? e.contextWindow : 200000,
      maxTokens: Number.isSafeInteger(e.maxOutputTokens) && e.maxOutputTokens > 0 ? e.maxOutputTokens : 64000,
      thinkingLevels: levels.length ? levels : ['off'],
      defaultThinkingLevel: levels.includes('low') ? 'low' : levels.includes(e.reasoning?.defaultLevel) ? e.reasoning.defaultLevel : levels[0] || 'off',
    };
  });
}
module.exports = { PROVIDER, expand, dataRoot, readAccount, redact, inspectLocal, modelCatalog, runFile };
