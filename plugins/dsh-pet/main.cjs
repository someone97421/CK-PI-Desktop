/**
 * dsh-pet 桌面宠物 —— 这是一个助手（PI-Desktop）插件主进程。
 *
 * 移植自 https://github.com/PC2005-cloud/dsh-pet （MIT，见 LICENSE / README）。
 * 上游的「桌面核心」原本是一个独立的 Electron helper（runtime/electron-helper/main.js）：
 * 它自己开透明置顶小窗、逐帧 setContentBounds 让窗口跟随宠物、用 setIgnoreMouseEvents
 * 做点击穿透、并用 stdout JSON 行 + 本地 HTTP 回调把渲染端请求转给 DSH 宿主。
 *
 * 移植后这些职责被拆成两半：
 *   1. 窗口原语（几何 / 位置 / 点击穿透 / 多 widget）由 PI-Desktop 宿主提供，
 *      渲染端直接调 window.pluginBridge.widget.invoke(...)。本文件不再需要任何 Electron。
 *   2. 本文件承担上游 helper 的「聚合与仲裁」部分：成品配置、宠物登记表、
 *      跨窗碰撞 broker、会话工作状态、碎碎念生成、设置持久化。
 *
 * 通道分两类：
 *   - 宠物窗口 / 设置页 → 本文件：onPanelInvoke（`pet.*`，见 PANEL_CHANNELS）。
 *   - 本文件 → 这是一个助手宿主：全局 `pi`（desktop.subscribe / session.list / agent.complete 等）。
 *
 * 不伪造任何结果：拿不到会话状态就报空闲，拿不到模型就明确返回失败原因，绝不编造文字。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ID = 'local.dsh-pet';
const PLUGIN_DIR = __dirname;
const CONFIG_PATH = path.join(PLUGIN_DIR, 'assets', 'config.jsonc');
const WEBM_DIR = path.join(PLUGIN_DIR, 'assets', 'webm');

const SERVICE_ID = 'dsh-pet-state';
const COMMAND_SHOW = 'dsh-pet.show';
const COMMAND_HIDE = 'dsh-pet.hide';
const COMMAND_SETTINGS = 'dsh-pet.settings';

/** 宠物窗口 / 设置页可以调用的通道（其他一律拒绝）。 */
const PANEL_CHANNELS = Object.freeze([
  'pet.config',
  'pet.sync',
  'pet.hit',
  'pet.closePet',
  'pet.hideAll',
  'pet.reopenAll',
  'pet.whisper',
  'pet.settings.get',
  'pet.settings.set',
  'pet.animations',
  'pet.models',
  'pet.show',
  'pet.log',
]);

/** 宠物尺寸范围（DIP）：窗口宽 = 2×size（左右各半只宠物的外扩余量），
 *  宿主的 widget 最小 120 → size 下限也取 120 就够（2×120=240 > 120）。 */
const MIN_PET_SIZE = 120;
const MAX_PET_SIZE = 600;

/** 宠物角色：'maid' = 内置女仆（assets/webm 透明 webm）；
 *  其余 id 来自 assets/config.jsonc 的 characters 段（当前只有 Codex v2 图集角色 xiao-dino）。 */
const DEFAULT_CHARACTER = 'maid';
/** 宠物存活判定：超过它没有 pet.sync 就认为该窗口已被用户关掉 */
const PEER_TIMEOUT_MS = 6000;
/** 会话状态轮询：重新对齐订阅集合的间隔 */
const SUBSCRIPTION_REFRESH_MS = 60_000;
/** 最多同时订阅几个最近会话（宿主上限 16） */
const MAX_SESSION_SUBSCRIPTIONS = 6;
/** 工作状态推进的节流：同一档位内的重复事件不刷新 ts（避免气泡反复重弹） */

const LOG_RING = 60;

let loaded = false;
let shuttingDown = false;
/** 原始配置（assets/config.jsonc 解析结果；只读） */
let baseConfig = null;
let baseConfigError = null;
/** 运行期合并后的成品配置（= baseConfig + 用户设置），随 pet.config 下发 */
let mergedConfig = null;
let configStamp = 1;
let settings = {};
let settingsError = null;
let settingsLoadedAt = 0;
const SETTINGS_CACHE_MS = 3000;

const logs = [];

// ---------------------------------------------------------------------------
// 极小的 JSONC 解析：剥掉 // 与 /* */ 注释（字符串内不动），再交给 JSON.parse。
// assets/config.jsonc 是从上游原样搬过来的（带大量中文注释），所以必须支持注释。
// ---------------------------------------------------------------------------
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function readBaseConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { value: JSON.parse(stripJsonComments(raw)), error: null };
  } catch (error) {
    return { value: null, error: error && error.message ? String(error.message) : String(error) };
  }
}

/** 可用的动画名（assets/webm 下的文件名）——设置页的动作点播列表用它 */
function listAnimationNames() {
  try {
    return fs
      .readdirSync(WEBM_DIR)
      .filter((name) => name.toLowerCase().endsWith('.webm'))
      .map((name) => name.replace(/\.webm$/i, ''))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 日志（宿主 audit + 设置页可见；环形缓冲，不落盘）
// ---------------------------------------------------------------------------
function recordLog(level, message) {
  const entry = { at: new Date().toISOString(), level, message: String(message).slice(0, 500) };
  logs.push(entry);
  if (logs.length > LOG_RING) logs.shift();
  try {
    if (level === 'error') console.error(`[dsh-pet] ${entry.message}`);
    else console.log(`[dsh-pet] ${entry.message}`);
  } catch {
    /* 管道关闭等：日志不是致命路径 */
  }
}

// ---------------------------------------------------------------------------
// 设置：宿主持久化（pi.plugin.getSettings / setSettings），本进程缓存。
// ---------------------------------------------------------------------------
const FALLBACK_SETTINGS = Object.freeze({
  showOnStartup: true,
  roaming: true,
  workStatus: true,
  whisper: false,
  whisperIntervalSec: 600,
  modelKey: '',
  petCollision: false,
  alwaysOnTop: true,
  size: 462,
  pets: null,
  physics: null,
});

function clampSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return FALLBACK_SETTINGS.size;
  return Math.min(MAX_PET_SIZE, Math.max(MIN_PET_SIZE, Math.round(n)));
}

/**
 * 宠物 id 同时是宿主 widget 的窗口 id（每只宠物一个 widget），必须满足宿主的 id 约定：
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，且不能占用宿主保留的 `panel`（那是插件默认窗口）。
 * 非法字符替换为 `-`，首字符非法就加 `pet-` 前缀，重名由调用方去重。
 */
function sanitizePetId(raw, fallback) {
  let id = typeof raw === 'string' ? raw.trim() : '';
  id = id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  if (!/^[A-Za-z0-9]/.test(id)) id = `pet-${id}`.slice(0, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id === 'panel') id = fallback;
  return id;
}

/** 角色 id 白名单：默认女仆 + config.jsonc 里声明过的角色（配置读失败时只剩默认角色，
 *  已存的图集角色会回落女仆并写一条告警——不静默渲染成别的角色）。 */
function characterIds() {
  const declared = baseConfig && baseConfig.characters && typeof baseConfig.characters === 'object'
    ? Object.keys(baseConfig.characters)
    : [];
  return [DEFAULT_CHARACTER, ...declared.filter((id) => id && id !== DEFAULT_CHARACTER)];
}

/** 校验角色 id：非法/缺失 → 默认女仆 */
function pickCharacter(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  return characterIds().includes(id) ? id : DEFAULT_CHARACTER;
}

/** 角色档里的图集文件是否真的在包里（缺失就不在设置页提供该角色，不做「选了才报错」） */
function characterSheetPath(characterId) {
  const profile = baseConfig && baseConfig.characters ? baseConfig.characters[characterId] : null;
  const sheet = profile && typeof profile.sheet === 'string' ? profile.sheet : '';
  if (!sheet) return null;
  const rel = sheet.replace(/^[\\/]+/, '');
  if (rel.split(/[\\/]/).includes('..')) return null;
  return path.join(PLUGIN_DIR, 'assets', rel);
}

/** 设置页可选角色（带 kind：video = 逐段视频，atlas = 精灵图集） */
function availableCharacters() {
  const out = [{ id: DEFAULT_CHARACTER, label: '蓝发女仆（106 段透明动画）', kind: 'video', available: true }];
  if (!baseConfig || !baseConfig.characters || typeof baseConfig.characters !== 'object') return out;
  for (const id of Object.keys(baseConfig.characters)) {
    if (!id || id === DEFAULT_CHARACTER) continue;
    const sheetPath = characterSheetPath(id);
    let available = false;
    if (sheetPath) {
      try {
        available = fs.statSync(sheetPath).isFile();
      } catch {
        available = false;
      }
    }
    if (!available) {
      recordLog('warn', `角色 ${id} 的图集文件缺失，本次运行不提供该角色：${sheetPath || '(未配置 sheet)'}`);
      continue;
    }
    const profile = baseConfig.characters[id];
    out.push({
      id,
      label: typeof profile.label === 'string' && profile.label ? profile.label : id,
      kind: 'atlas',
      available: true,
    });
  }
  return out;
}

/** config.jsonc 的 pets[] → 运行期宠物条目（补上 enabled 与默认值） */
function basePets() {
  const raw = Array.isArray(baseConfig && baseConfig.pets) ? baseConfig.pets : [];
  const list = [];
  for (let i = 0; i < raw.length; i += 1) {
    const pet = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
    const id = sanitizePetId(pet.id, `pet-${i + 1}`);
    const position = pet.position && typeof pet.position === 'object' ? pet.position : {};
    list.push({
      id,
      name: typeof pet.name === 'string' && pet.name ? pet.name : id,
      size: clampSize(pet.size),
      balanceEnabled: pet.balanceEnabled === true,
      whisperEnabled: pet.whisperEnabled === true,
      workStatusEnabled: pet.workStatusEnabled !== false,
      corner: typeof position.corner === 'string' ? position.corner : 'bottom-right',
      marginX: Number.isFinite(Number(position.marginX)) ? Number(position.marginX) : 24,
      marginY: Number.isFinite(Number(position.marginY)) ? Number(position.marginY) : 24,
      display: typeof pet.display === 'string' ? pet.display : 'both',
      character: pickCharacter(pet.character),
      enabled: true,
    });
  }
  if (!list.length) {
    list.push({
      id: 'main',
      name: 'dsh-pet',
      size: clampSize(FALLBACK_SETTINGS.size),
      balanceEnabled: false,
      whisperEnabled: false,
      workStatusEnabled: true,
      corner: 'bottom-right',
      marginX: 24,
      marginY: 24,
      display: 'both',
      enabled: true,
      character: DEFAULT_CHARACTER,
    });
  }
  return list;
}

/** 规范化持久设置里的 pets[]（写坏一样能跑：非法条目丢掉，列表空则回落配置模板） */
function normalizePets(input) {
  if (!Array.isArray(input) || !input.length) return basePets();
  const seen = new Set();
  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const pet = input[i] && typeof input[i] === 'object' ? input[i] : null;
    if (!pet) continue;
    let id = sanitizePetId(pet.id, `pet-${i + 1}`);
    // 重名（含被 sanitize 折叠到一起的）加后缀，保证 widget id 唯一
    if (seen.has(id)) {
      let suffix = 2;
      while (seen.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    seen.add(id);
    out.push({
      id,
      name: typeof pet.name === 'string' && pet.name.trim() ? pet.name.trim() : id,
      size: clampSize(pet.size),
      balanceEnabled: pet.balanceEnabled === true,
      whisperEnabled: pet.whisperEnabled === true,
      workStatusEnabled: pet.workStatusEnabled !== false,
      corner:
        pet.corner === 'top-left' || pet.corner === 'top-right' || pet.corner === 'bottom-left' || pet.corner === 'bottom-right'
          ? pet.corner
          : 'bottom-right',
      marginX: Number.isFinite(Number(pet.marginX)) ? Number(pet.marginX) : 24,
      marginY: Number.isFinite(Number(pet.marginY)) ? Number(pet.marginY) : 24,
      display: typeof pet.display === 'string' ? pet.display : 'both',
      character: pickCharacter(pet.character),
      enabled: pet.enabled !== false,
    });
  }
  return out.length ? out : basePets();
}

function physicsFrom(base, override, collisionDefault) {
  const src = {
    gravity: 1400,
    restitution: 0.78,
    groundFriction: 2.5,
    ceilingBounce: true,
    throwPower: 1,
    petCollision: false,
    ...(base && typeof base === 'object' ? base : {}),
    ...(override && typeof override === 'object' ? override : {}),
  };
  // petCollision 既可由 config.jsonc 给，也可由设置项覆盖（设置默认来自 FALLBACK）
  if (typeof override?.petCollision === 'boolean') src.petCollision = override.petCollision;
  else if (typeof collisionDefault === 'boolean') src.petCollision = collisionDefault;
  for (const key of ['gravity', 'restitution', 'groundFriction', 'throwPower']) {
    if (!Number.isFinite(Number(src[key]))) src[key] = key === 'throwPower' ? 1 : src[key];
  }
  return src;
}

/** 合并配置：config.jsonc 的动画池/文案/物理 + 设置里的宠物表与开关 */
function rebuildConfig() {
  if (!baseConfig) return null;
  const pets = normalizePets(settings.pets);
  const resolvedPets = pets.map((pet, index) => ({
    id: pet.id,
    name: pet.name,
    size: index === 0 && Number.isFinite(Number(settings.size)) ? clampSize(settings.size) : pet.size,
    balanceEnabled: false, // 原版余额联动依赖 DSH 服务商接口，未移植
    whisperEnabled: pet.whisperEnabled === true && settings.whisper !== false,
    workStatusEnabled: pet.workStatusEnabled !== false && settings.workStatus !== false,
    display: pet.display,
    character: pet.character,
    position: { corner: pet.corner, marginX: pet.marginX, marginY: pet.marginY },
    enabled: pet.enabled !== false,
  }));
  const next = {
    main: {
      ...baseConfig,
      pets: resolvedPets,
      physics: physicsFrom(baseConfig.physics, settings.physics, settings.petCollision === true),
      workStatusTexts: Array.isArray(baseConfig.workStatusTexts) ? baseConfig.workStatusTexts : undefined,
      eventsRefreshSec: {
        whisper: Number(settings.whisperIntervalSec) > 0 ? Number(settings.whisperIntervalSec) : 600,
        ...(baseConfig.eventsRefreshSec && typeof baseConfig.eventsRefreshSec === 'object'
          ? baseConfig.eventsRefreshSec
          : {}),
      },
    },
  };
  // 配置戳只在**真的变了**的时候递增：设置会定期重读，若每次都递增，
  // 所有宠物窗口就会无脑重挂（动画被打断、窗口抖动）。
  if (JSON.stringify(next) !== JSON.stringify(mergedConfig)) {
    mergedConfig = next;
    configStamp += 1;
  }
  return mergedConfig;
}

async function refreshSettings(force = false) {
  const now = Date.now();
  if (!force && now - settingsLoadedAt < SETTINGS_CACHE_MS) return settings;
  settingsLoadedAt = now;
  try {
    const stored = await pi.plugin.getSettings();
    settings = { ...FALLBACK_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
    settingsError = null;
  } catch (error) {
    settingsError = error && error.message ? String(error.message) : String(error);
    recordLog('warn', `读取插件设置失败：${settingsError}`);
    settings = { ...FALLBACK_SETTINGS, ...settings };
  }
  try {
    rebuildConfig();
  } catch (error) {
    recordLog('error', `合并配置失败：${error && error.message ? error.message : error}`);
  }
  return settings;
}

async function persistSettings(patch) {
  const next = { ...settings, ...(patch && typeof patch === 'object' ? patch : {}) };
  try {
    await pi.plugin.setSettings(next);
    settings = next;
    settingsLoadedAt = Date.now();
    rebuildConfig();
    rescheduleWhisper();
    return { ok: true };
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    recordLog('error', `保存设置失败：${message}`);
    return { ok: false, error: { code: 'SETTINGS_WRITE_FAILED', message } };
  }
}

// ---------------------------------------------------------------------------
// 宠物登记表 + 跨窗碰撞 broker
//
// 上游是 Electron 主进程用 ipcMain 汇聚后广播；这里没有推送通道，
// 改成「每个宠物窗口按时轮询 pet.sync」——请求带上自己的最新状态，
// 应答里带回其它宠物的状态与被撞动量（滞后 ≤ 一个轮询周期，与上游「滞后 ≤ 1 帧」同量级）。
// ---------------------------------------------------------------------------
/** petId -> { box:{x,y}, size, bottomPad, vx, vy, flying, aliveAt } */
const peers = new Map();
/** petId -> [{vx,vy}]（等目标窗口下次 sync 时取走） */
const pendingHits = new Map();
/** 本轮用户显式收起的宠物 id（不再被 leader 自动打开） */
let closedPets = new Set();
/** 本会话里已打开的宠物 id（由 sync 心跳维护），leader 据此决定要不要补开 */
let openPets = new Set();
/** 最早出现的存活宠物 = leader（由它负责对齐兄弟窗口） */
let leaderId = null;
let rootWindowPetId = '';

function prunePeers() {
  const now = Date.now();
  for (const [id, entry] of [...peers.entries()]) {
    if (now - entry.aliveAt > PEER_TIMEOUT_MS) {
      peers.delete(id);
      openPets.delete(id);
      pendingHits.delete(id);
      if (leaderId === id) {
        leaderId = null;
      }
      // 窗口不是通过「收起这只宠物」关掉的（比如宿主的右键菜单直接关了窗口）：
      // 记为会话内已收起，否则 leader 会立刻把它再开出来，形成关不掉的循环。
      if (!closedPets.has(id)) {
        closedPets.add(id);
        recordLog('info', `宠物窗口 ${id} 已关闭（心跳超时），本次运行不再自动打开`);
      }
    }
  }
}

function recordSync(petId, payload) {
  const now = Date.now();
  if (payload && payload.widgetId === 'panel') rootWindowPetId = petId;
  if (!peers.has(petId)) {
    peers.set(petId, { box: { x: 0, y: 0 }, size: 0, bottomPad: 0, vx: 0, vy: 0, flying: false, aliveAt: now });
  }
  const entry = peers.get(petId);
  entry.aliveAt = now;
  const box = payload && typeof payload.box === 'object' ? payload.box : null;
  if (box && Number.isFinite(Number(box.x)) && Number.isFinite(Number(box.y))) {
    entry.box = { x: Number(box.x), y: Number(box.y) };
  }
  for (const key of ['size', 'bottomPad', 'vx', 'vy']) {
    const value = Number(payload && payload[key]);
    if (Number.isFinite(value)) entry[key] = value;
  }
  entry.flying = payload && payload.flying === true;
  openPets.add(petId);
  // leader 语义：第一个注册的存活窗口当 leader（由它对齐兄弟窗口的开/关）。
  // leader 消失时 prunePeers 会清空它，下一个 sync 的窗口自然接手。
  if (!leaderId) {
    leaderId = petId;
  }
  return entry;
}

function othersOf(petId) {
  const out = {};
  for (const [id, entry] of peers.entries()) {
    if (id === petId) continue;
    if (!entry.size) continue; // 尺寸还没上报：跨窗碰撞跳过它（与上游 `!o.size` 同一判定）
    out[id] = { x: entry.box.x, y: entry.box.y, vx: entry.vx, vy: entry.vy, size: entry.size, bottomPad: entry.bottomPad };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 会话工作状态（对齐上游 src/host/work-status.ts 的 6 档压缩）
//
// 数据来源两条，都用上了：
//   1. pi.events.on('session:turnEnded') —— 宿主向所有插件进程广播，无需订阅；
//   2. pi.desktop.subscribe({sessionId}) → desktop:event：
//        kind='agent.event'      载荷 = AgentEvent 信封（agent_start / tool_start / tool_end …）
//        kind='agent.turnEnded'  回合终态（含 reason）
//        kind='session.changed'  审批/提问被处理 → 重新取快照对齐
//      订阅还需要 sessionId，插件不知道「用户当前看的是哪个会话」，所以取
//      pi.session.list() 里最近更新的若干个会话（最多 6 个）并定期重对齐。
// ---------------------------------------------------------------------------
/** sessionId -> { state, task, ts, updatedAt } */
const sessionStates = new Map();
let workStatus = { state: null, task: null, ts: 0 };
let lastWorkPushAt = 0;
/** sessionId -> subscriptionId */
const subscriptions = new Map();

/** 优先取「越靠后越需要展示」的档位：等待确认 > 干活 > 整理 > 思考 > 出错 > 完成 */
const WORK_PRIORITY = { waiting: 6, working: 5, result: 4, thinking: 3, error: 2, success: 1 };

function recomputeWorkStatus() {
  let best = null;
  for (const entry of sessionStates.values()) {
    if (!entry.state) continue;
    if (!best) {
      best = entry;
      continue;
    }
    const p = WORK_PRIORITY[entry.state] || 0;
    const bp = WORK_PRIORITY[best.state] || 0;
    if (p > bp) best = entry;
    else if (p === bp && entry.updatedAt > best.updatedAt) best = entry;
  }
  const state = best ? best.state : null;
  const task = best ? best.task ?? null : null;
  // ts 只在档位/文案真的变了才推进：渲染端按 ts 变化触发一次动画与气泡，
  // 同档位内的重复事件（同一工具被调多次）不该把已经收起的终态气泡反复弹回来
  // （上游 Bug 2 的同一处护栏）。
  if (state !== workStatus.state || task !== workStatus.task) {
    lastWorkPushAt = Date.now();
    workStatus = { state, task, ts: state ? lastWorkPushAt : 0 };
  }
  return workStatus;
}

function setSessionState(sessionId, state, task) {
  if (!sessionId) return;
  const prev = sessionStates.get(sessionId) || { state: null, task: null, updatedAt: 0 };
  // 状态不变且文案不变：只推进 updatedAt 会污染 ts 判定，故直接返回
  if (prev.state === state && (prev.task ?? null) === (task ?? null)) return;
  sessionStates.set(sessionId, { state, task: task ?? null, updatedAt: Date.now() });
  recomputeWorkStatus();
}

/** 事件信封 → 档位（对齐上游 reduceWorkStatus：turn/start、tool/call、tool/result …） */
function reduceAgentEvent(type, event) {
  switch (type) {
    case 'agent_start':
    case 'message_start':
      return 'thinking';
    case 'tool_start':
    case 'tool_call':
      return 'working';
    case 'tool_end':
    case 'tool_result':
      return 'result';
    case 'asktool_request':
    case 'tool_permission_request':
      return 'waiting';
    case 'agent_end':
      return 'result';
    default:
      return null;
  }
}

function taskFromEvent(event) {
  const value = event && typeof event === 'object' ? event : {};
  const name = typeof value.toolName === 'string' ? value.toolName : typeof value.name === 'string' ? value.name : '';
  const summary = typeof value.summary === 'string' ? value.summary : '';
  return summary || (name ? `正在执行 ${name}` : null);
}

/** 会话快照（RacpSessionSnapshot）→ 档位：订阅建立、审批被处理、轮询重对齐时用它兜底 */
function reduceSnapshot(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const session = snap.session && typeof snap.session === 'object' ? snap.session : {};
  const turn = snap.activeTurn && typeof snap.activeTurn === 'object' ? snap.activeTurn : null;
  const approvals = Array.isArray(snap.pendingApprovals) ? snap.pendingApprovals : [];
  const inputs = Array.isArray(snap.pendingInputs) ? snap.pendingInputs : [];
  if (session.status === 'error') return { state: 'error', task: null };
  if (approvals.length || inputs.length) return { state: 'waiting', task: null };
  if (turn && (turn.status === 'waiting_approval' || turn.status === 'waiting_input')) {
    return { state: 'waiting', task: null };
  }
  if (session.status === 'running' || (turn && turn.status === 'running')) {
    const items = Array.isArray(snap.activeItems) ? snap.activeItems : [];
    const tool = items.find((item) => item && typeof item.itemType === 'string' && item.itemType.startsWith('tool'));
    if (tool && tool.status === 'streaming') return { state: 'working', task: null };
    if (tool) return { state: 'result', task: null };
    return { state: 'thinking', task: null };
  }
  // idle / aborted / 没有活动回合：这一路会话回到空闲（绝不残留上一档）
  return { state: null, task: null };
}

async function refreshSubscriptions() {
  let listed;
  try {
    listed = await pi.session.list({ limit: MAX_SESSION_SUBSCRIPTIONS + 4 });
  } catch (error) {
    recordLog('warn', `列举会话失败：${error && error.message ? error.message : error}`);
    return;
  }
  const items = Array.isArray(listed && listed.items) ? listed.items : [];
  const wanted = items
    .slice()
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, MAX_SESSION_SUBSCRIPTIONS)
    .map((item) => item && item.sessionId)
    .filter((id) => typeof id === 'string' && id);

  for (const [sessionId, subscriptionId] of [...subscriptions.entries()]) {
    if (wanted.includes(sessionId)) continue;
    subscriptions.delete(sessionId);
    sessionStates.delete(sessionId);
    try {
      await pi.desktop.unsubscribe(subscriptionId);
    } catch {
      /* 退订失败（插件进程重启等）不影响后续 */
    }
  }

  for (const sessionId of wanted) {
    if (subscriptions.has(sessionId)) continue;
    try {
      const result = await pi.desktop.subscribe({ sessionId });
      subscriptions.set(sessionId, result.subscriptionId);
      const reduced = reduceSnapshot(result.snapshot);
      sessionStates.set(sessionId, { state: reduced.state, task: reduced.task, updatedAt: Date.now() });
    } catch (error) {
      recordLog('warn', `订阅会话 ${sessionId} 失败：${error && error.message ? error.message : error}`);
    }
  }
  recomputeWorkStatus();
}

function onDesktopEvent(frame) {
  const payload = frame && typeof frame === 'object' ? frame.payload : null;
  const sessionId = frame && typeof frame.sessionId === 'string' ? frame.sessionId : '';
  const kind = frame && typeof frame.kind === 'string' ? frame.kind : '';
  if (kind === 'agent.event') {
    const event = payload && typeof payload.event === 'object' ? payload.event : null;
    const type = event && typeof event.type === 'string' ? event.type : '';
    const state = reduceAgentEvent(type, event);
    if (state) setSessionState(sessionId, state, taskFromEvent(event));
    return;
  }
  if (kind === 'agent.turnEnded') {
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    if (reason === 'completed') setSessionState(sessionId, 'success', null);
    else if (reason === 'error') setSessionState(sessionId, 'error', null);
    else sessionStates.set(sessionId, { state: null, task: null, updatedAt: Date.now() });
    recomputeWorkStatus();
    return;
  }
  if (kind === 'session.changed' || kind === 'agent.queueChanged') {
    // 审批/提问被处理、队列变化：重新取快照对齐（快照是权威状态）
    if (sessionId) void realignSession(sessionId);
    else for (const id of subscriptions.keys()) void realignSession(id);
  }
}

async function realignSession(sessionId) {
  if (!sessionId || !subscriptions.has(sessionId)) return;
  try {
    const snapshot = await pi.desktop.getSessionSnapshot({ sessionId });
    const reduced = reduceSnapshot(snapshot);
    setSessionState(sessionId, reduced.state, reduced.task);
  } catch {
    /* 快照读失败：保持现有状态，等下一个事件 */
  }
}

// ---------------------------------------------------------------------------
// 碎碎念（原版经 DSH 当前模型生成一句）：移植后走 pi.agent.complete。
// 默认关闭；开启后按 eventsRefreshSec.whisper 周期生成，也可以在右键菜单里手动点一次。
// 拿不到模型就明确失败（reason=no-model），绝不编造文案。
// ---------------------------------------------------------------------------
/** petId -> { ts, text } */
const whispers = new Map();
let whisperTimer = null;
let whisperInFlight = false;

function rescheduleWhisper() {
  if (whisperTimer) {
    clearTimeout(whisperTimer);
    whisperTimer = null;
  }
  scheduleWhisper();
}

async function resolveModelKey() {
  const configured = typeof settings.modelKey === 'string' ? settings.modelKey.trim() : '';
  if (configured) return configured;
  try {
    const context = await pi.session.getLlmContext();
    if (context && typeof context.modelKey === 'string' && context.modelKey) return context.modelKey;
  } catch {
    /* 没有前台会话时拿不到：继续往下找 */
  }
  try {
    const models = await pi.models.list();
    if (Array.isArray(models) && models.length) {
      const preferred = models.find((model) => model && model.isDefault) || models[0];
      if (preferred && typeof preferred.key === 'string') return preferred.key;
    }
  } catch {
    /* 模型目录不可用：按失败处理 */
  }
  return null;
}

async function generateWhisper() {
  if (whisperInFlight) return { ok: false, error: { code: 'BUSY', message: '上一次生成还没结束' } };
  if (shuttingDown) return { ok: false, error: { code: 'SHUTTING_DOWN', message: '插件正在卸载' } };
  whisperInFlight = true;
  try {
    const modelKey = await resolveModelKey();
    if (!modelKey) {
      return {
        ok: false,
        error: { code: 'NO_MODEL', message: '没有可用模型：请在设置里选择模型，或先打开一个会话' },
      };
    }
    const system =
      (baseConfig && typeof baseConfig.whisperPrompt === 'string' && baseConfig.whisperPrompt) ||
      '你是主人桌面上的Q版小女仆，会时不时碎碎念一句。说话要自然随意、短短一句（20字以内）。';
    const result = await pi.agent.complete({
      modelKey,
      system,
      messages: [{ role: 'user', content: '说一句碎碎念。' }],
    });
    const text = result && typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) {
      return { ok: false, error: { code: 'EMPTY_COMPLETION', message: '模型没有返回文字' } };
    }
    return { ok: true, text, modelKey };
  } catch (error) {
    return {
      ok: false,
      error: { code: 'COMPLETE_FAILED', message: error && error.message ? String(error.message) : String(error) },
    };
  } finally {
    whisperInFlight = false;
  }
}

function scheduleWhisper() {
  if (shuttingDown || !loaded) return;
  if (!settings.whisper) return;
  const pets = mergedConfig && mergedConfig.main ? mergedConfig.main.pets : [];
  const targets = (pets || []).filter((pet) => pet.whisperEnabled);
  if (!targets.length) return;
  const seconds = Number(settings.whisperIntervalSec) > 0 ? Number(settings.whisperIntervalSec) : 600;
  const delay = Math.max(30_000, seconds * 1000);
  whisperTimer = setTimeout(() => {
    whisperTimer = null;
    void tickWhisper(targets);
  }, delay);
  if (whisperTimer.unref) whisperTimer.unref();
}

async function tickWhisper(targets) {
  for (const pet of targets) {
    const result = await generateWhisper();
    if (!result.ok) {
      recordLog('warn', `碎碎念生成失败（${result.error.code}）：${result.error.message}`);
      break;
    }
    whispers.set(pet.id, { ts: Date.now(), text: result.text });
  }
  scheduleWhisper();
}

// ---------------------------------------------------------------------------
// panel 通道
// ---------------------------------------------------------------------------
function petsPayload() {
  const pets = mergedConfig && mergedConfig.main ? mergedConfig.main.pets : [];
  const preferences = new Map(normalizePets(settings.pets).map((pet) => [pet.id, pet]));
  return (pets || []).map((pet) => ({
    id: pet.id,
    name: pet.name,
    size: pet.size,
    corner: pet.position ? pet.position.corner : 'bottom-right',
    marginX: pet.position ? pet.position.marginX : 24,
    marginY: pet.position ? pet.position.marginY : 24,
    character: pickCharacter(pet.character),
    enabled: pet.enabled !== false,
    whisperEnabled: preferences.get(pet.id)?.whisperEnabled === true,
    workStatusEnabled: preferences.get(pet.id)?.workStatusEnabled !== false,
  }));
}

function syncResponse(petId) {
  prunePeers();
  const hits = pendingHits.get(petId) || [];
  pendingHits.delete(petId);
  const pets = petsPayload();
  const whisper = whispers.get(petId) || null;
  return {
    ok: true,
    configStamp,
    pets,
    leaderId: leaderId || petId,
    rootPetId: rootWindowPetId,
    closedIds: [...closedPets],
    openIds: [...openPets],
    roaming: settings.roaming !== false,
    alwaysOnTop: settings.alwaysOnTop !== false,
    workStatusEnabled: settings.workStatus !== false,
    whisperEnabled: settings.whisper === true,
    workStatus,
    others: othersOf(petId),
    hits,
    whisper,
    errors: settingsError ? [{ scope: 'settings', message: settingsError }] : [],
  };
}

function settingsPayload() {
  const pets = petsPayload();
  const animations = listAnimationNames();
  return {
    ok: true,
    settings: {
      showOnStartup: settings.showOnStartup !== false,
      roaming: settings.roaming !== false,
      workStatus: settings.workStatus !== false,
      whisper: settings.whisper === true,
      whisperIntervalSec: Number(settings.whisperIntervalSec) > 0 ? Number(settings.whisperIntervalSec) : 600,
      whisperPrompt:
        (baseConfig && typeof baseConfig.whisperPrompt === 'string' && baseConfig.whisperPrompt) || '',
      modelKey: typeof settings.modelKey === 'string' ? settings.modelKey : '',
      petCollision: settings.petCollision === true,
      alwaysOnTop: settings.alwaysOnTop !== false,
      size: clampSize(settings.size),
      pets,
    },
    limits: { minSize: MIN_PET_SIZE, maxSize: MAX_PET_SIZE, maxPets: 8 },
    characters: availableCharacters(),
    animations,
    workStatus,
    logs: logs.slice(-20),
    configError: baseConfigError,
  };
}

/** 校验设置页提交的表单；不合法就整条拒绝，不做静默修正 */
function sanitizeSettingsPatch(input) {
  const patch = {};
  const raw = input && typeof input === 'object' ? input : {};
  for (const key of ['showOnStartup', 'roaming', 'workStatus', 'whisper', 'petCollision', 'alwaysOnTop']) {
    if (typeof raw[key] === 'boolean') patch[key] = raw[key];
  }
  if (raw.size !== undefined) patch.size = clampSize(raw.size);
  if (raw.whisperIntervalSec !== undefined) {
    const seconds = Number(raw.whisperIntervalSec);
    patch.whisperIntervalSec = Number.isFinite(seconds) ? Math.max(60, Math.min(24 * 3600, Math.round(seconds))) : 600;
  }
  if (typeof raw.modelKey === 'string') patch.modelKey = raw.modelKey.slice(0, 200);
  if (raw.physics !== undefined) {
    const physics = raw.physics && typeof raw.physics === 'object' ? raw.physics : {};
    const out = {};
    for (const key of ['gravity', 'restitution', 'groundFriction', 'throwPower']) {
      const value = Number(physics[key]);
      if (Number.isFinite(value)) out[key] = value;
    }
    if (typeof physics.ceilingBounce === 'boolean') out.ceilingBounce = physics.ceilingBounce;
    if (Object.keys(out).length) patch.physics = out;
  }
  if (Array.isArray(raw.pets)) {
    patch.pets = raw.pets.slice(0, 8).map((pet, index) => {
      const value = pet && typeof pet === 'object' ? pet : {};
      return {
        id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `pet-${index + 1}`,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined,
        size: clampSize(value.size),
        corner: value.corner,
        marginX: Number.isFinite(Number(value.marginX)) ? Number(value.marginX) : 24,
        marginY: Number.isFinite(Number(value.marginY)) ? Number(value.marginY) : 24,
        whisperEnabled: value.whisperEnabled === true,
        workStatusEnabled: value.workStatusEnabled !== false,
        character: pickCharacter(value.character),
        enabled: value.enabled !== false,
      };
    });
  }
  if (raw.reopenAll === true) {
    closedPets = new Set();
    leadersReset();
  }
  if (typeof raw.closePets === 'string' && raw.closePets) closedPets.add(raw.closePets);
  return patch;
}

function leadersReset() {
  leaderId = null;
}

async function handlePanelInvoke(channel, payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  switch (channel) {
    case 'pet.config': {
      await refreshSettings();
      prunePeers();
      if (input.widgetId === 'panel' && !input.pet) rootWindowPetId = '';
      if (!mergedConfig) return { ok: false, error: { code: 'CONFIG_UNAVAILABLE', message: baseConfigError || '配置不可用' } };
      return { ok: true, config: mergedConfig, configStamp, physics: mergedConfig.main.physics,
        openIds: [...openPets], closedIds: [...closedPets], alwaysOnTop: settings.alwaysOnTop !== false };
    }
    case 'pet.sync': {
      const petId = typeof input.pet === 'string' && input.pet ? input.pet : 'main';
      recordSync(petId, input);
      await refreshSettings();
      return syncResponse(petId);
    }
    case 'pet.hit': {
      const target = typeof input.targetId === 'string' ? input.targetId : '';
      const vx = Number(input.vx);
      const vy = Number(input.vy);
      if (!target || !Number.isFinite(vx) || !Number.isFinite(vy)) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'pet.hit 需要 targetId/vx/vy' } };
      }
      const queue = pendingHits.get(target) || [];
      queue.push({ vx, vy });
      pendingHits.set(target, queue.slice(-4));
      return { ok: true };
    }
    case 'pet.closePet': {
      // 默认窗口以实际心跳绑定的宠物为准，不跟随配置列表顺序变化。
      let petId = typeof input.pet === 'string' ? input.pet : '';
      if (petId === 'panel') {
        petId = rootWindowPetId;
      }
      if (petId) {
        const configured = petsPayload().find((pet) => pet.id === petId);
        if (configured && configured.enabled) closedPets.add(petId);
        peers.delete(petId);
        openPets.delete(petId);
        if (leaderId === petId) leadersReset();
      }
      return { ok: true, closedIds: [...closedPets] };
    }
    case 'pet.hideAll': {
      for (const pet of petsPayload()) closedPets.add(pet.id);
      peers.clear();
      openPets.clear();
      leadersReset();
      await pi.ui.closePanel();
      return { ok: true };
    }
    case 'pet.reopenAll': {
      closedPets = new Set();
      leadersReset();
      return { ok: true };
    }
    case 'pet.whisper': {
      const result = await generateWhisper();
      const petId = typeof input.pet === 'string' && input.pet ? input.pet : 'main';
      if (result.ok) whispers.set(petId, { ts: Date.now(), text: result.text });
      return result;
    }
    case 'pet.settings.get':
      await refreshSettings(true);
      return settingsPayload();
    case 'pet.settings.set': {
      const patch = sanitizeSettingsPatch(input.patch ?? input);
      const saved = await persistSettings(patch);
      if (!saved.ok) return saved;
      prunePeers();
      const wanted = petsPayload().filter((pet) => pet.enabled && !closedPets.has(pet.id));
      if (wanted.length && !wanted.some((pet) => openPets.has(pet.id))) await openPetWindow();
      return settingsPayload();
    }
    case 'pet.animations':
      return { ok: true, animations: listAnimationNames() };
    case 'pet.models': {
      // 设置页的模型下拉：只在用户开了碎碎念时才有意义，失败就返回空表（不报错刷屏）
      try {
        const listed = await pi.models.list();
        return {
          ok: true,
          models: (Array.isArray(listed) ? listed : []).map((model) => ({
            key: model && model.key ? String(model.key) : '',
            label: model && (model.alias || model.label || model.modelId) ? String(model.alias || model.label || model.modelId) : '',
            provider: model && model.providerName ? String(model.providerName) : '',
          })).filter((model) => model.key),
        };
      } catch (error) {
        return { ok: true, models: [], error: { code: 'MODELS_UNAVAILABLE', message: error && error.message ? String(error.message) : String(error) } };
      }
    }
    case 'pet.show':
      closedPets.clear();
      leadersReset();
      if (!(await openPetWindow())) throw new Error('无法打开宠物窗口');
      return { ok: true };
    case 'pet.log':
      return { ok: true, logs: logs.slice(-40) };
    default:
      return { ok: false, error: { code: 'UNSUPPORTED', message: `unsupported panel channel: ${channel}` } };
  }
}

async function onPanelInvoke(channel, payload) {
  try {
    return await handlePanelInvoke(channel, payload);
  } catch (error) {
    const message = error && error.message ? String(error.message) : String(error);
    recordLog('error', `panel 通道 ${channel} 失败：${message}`);
    return { ok: false, error: { code: 'PANEL_ERROR', message } };
  }
}

// ---------------------------------------------------------------------------
// 命令 / 服务 / 生命周期
// ---------------------------------------------------------------------------
let registeredCommands = [];
let serviceRegistered = false;

async function openPetWindow() {
  try {
    await pi.ui.openPanel();
    return true;
  } catch (error) {
    recordLog('warn', `打开宠物窗口失败：${error && error.message ? error.message : error}`);
    return false;
  }
}

async function registerCommands(manifest) {
  const declared = Array.isArray(manifest && manifest.contributes && manifest.contributes.commands)
    ? manifest.contributes.commands
    : [];
  const titles = new Map(declared.map((command) => [command.id, command.title]));
  const wanted = [
    {
      id: COMMAND_SHOW,
      title: titles.get(COMMAND_SHOW) || '桌面宠物：显示宠物',
      run: async () => {
        closedPets = new Set();
        leadersReset();
        await refreshSettings(true);
        await openPetWindow();
        try {
          await pi.ui.showToast('桌面宠物已唤出');
        } catch {
          /* toast 不是关键路径 */
        }
      },
    },
    {
      id: COMMAND_HIDE,
      title: titles.get(COMMAND_HIDE) || '桌面宠物：收起宠物',
      run: async () => {
        for (const id of openPets) closedPets.add(id);
        peers.clear();
        openPets.clear();
        leadersReset();
        try {
          await pi.ui.closePanel();
        } catch (error) {
          recordLog('warn', `收起窗口失败：${error && error.message ? error.message : error}`);
        }
      },
    },
    {
      id: COMMAND_SETTINGS,
      title: titles.get(COMMAND_SETTINGS) || '桌面宠物：设置',
      // 宿主没有「打开插件视图」的 API：设置统一走插件自己的设置窗口
      // （同一个 ui.panel 入口，query 决定渲染哪一屏），命令只负责保证它可见。
      run: async () => {
        await openPetWindow();
        try {
          await pi.ui.showToast('设置在本插件的设置窗口 / 右侧工作面板「桌面宠物设置」里');
        } catch {
          /* 同上 */
        }
      },
    },
  ];
  for (const entry of wanted) {
    try {
      await pi.commands.register({
        id: entry.id,
        title: entry.title,
        keywords: ['桌宠', '宠物', 'pet', 'dsh-pet'],
        run: entry.run,
      });
      registeredCommands.push(entry.id);
    } catch (error) {
      recordLog('warn', `注册命令 ${entry.id} 失败：${error && error.message ? error.message : error}`);
    }
  }
}

async function unregisterCommands() {
  const ids = registeredCommands;
  registeredCommands = [];
  for (const id of ids) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* 卸载路径忽略 */
    }
  }
}

function registerService() {
  if (serviceRegistered || !pi.services || typeof pi.services.register !== 'function') return;
  pi.services.register({
    id: SERVICE_ID,
    start: () => {
      startStateTracking();
      recordLog('info', '会话状态跟踪已启动');
    },
    stop: () => {
      stopStateTracking();
    },
  });
  serviceRegistered = true;
}

let subscriptionTimer = null;

function startStateTracking() {
  if (subscriptionTimer) return;
  void refreshSubscriptions();
  subscriptionTimer = setInterval(() => {
    void refreshSubscriptions();
  }, SUBSCRIPTION_REFRESH_MS);
  if (subscriptionTimer.unref) subscriptionTimer.unref();
}

function stopStateTracking() {
  if (subscriptionTimer) {
    clearInterval(subscriptionTimer);
    subscriptionTimer = null;
  }
  for (const [, subscriptionId] of subscriptions.entries()) {
    try {
      void pi.desktop.unsubscribe(subscriptionId);
    } catch {
      /* 卸载路径忽略 */
    }
  }
  subscriptions.clear();
  sessionStates.clear();
}

async function onLoad() {
  loaded = true;
  shuttingDown = false;
  const loadedConfig = readBaseConfig();
  baseConfig = loadedConfig.value;
  baseConfigError = loadedConfig.error;
  if (baseConfigError) recordLog('error', `读取 assets/config.jsonc 失败：${baseConfigError}`);
  closedPets = new Set();
  peers.clear();
  openPets.clear();
  leadersReset();

  await refreshSettings(true);

  // 宿主事件（都在全局 pi.events 上，不需要额外权限）：
  //   session:turnEnded —— 向所有插件进程广播的回合终态；
  //   desktop:event    —— desktop.subscribe 建立的会话级事件流（载荷含 kind/payload）。
  try {
    pi.events.on('session:turnEnded', (...args) => onHostEvent('session:turnEnded', args));
    pi.events.on('desktop:event', (frame) => onDesktopEvent(frame));
  } catch (error) {
    recordLog('warn', `注册宿主事件失败：${error && error.message ? error.message : error}`);
  }

  registerService();
  await registerCommands(pi.manifest || {});
  scheduleWhisper();

  if (settings.showOnStartup !== false) {
    await openPetWindow();
  }
  recordLog(
    'info',
    `dsh-pet 已加载：宠物 ${petsPayload().length} 只，动画 ${listAnimationNames().length} 段` +
      (baseConfigError ? `（配置读取失败：${baseConfigError}）` : ''),
  );
}

async function onUnload() {
  loaded = false;
  shuttingDown = true;
  if (whisperTimer) {
    clearTimeout(whisperTimer);
    whisperTimer = null;
  }
  stopStateTracking();
  peers.clear();
  pendingHits.clear();
  await unregisterCommands();
  recordLog('info', 'dsh-pet 已卸载');
}

/** 宠物窗口向本进程推来的桌面事件（宿主广播）：目前只有回合终态一条。 */
function onHostEvent(event, args) {
  if (event !== 'session:turnEnded') return;
  const payload = Array.isArray(args) ? args[0] : null;
  const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
  const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
  if (reason === 'completed') setSessionState(sessionId, 'success', null);
  else if (reason === 'error') setSessionState(sessionId, 'error', null);
  else if (sessionId) sessionStates.set(sessionId, { state: null, task: null, updatedAt: Date.now() });
  recomputeWorkStatus();
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  onHostEvent,
  onDesktopEvent,
  PANEL_CHANNELS,
  SERVICE_ID,
  COMMAND_SHOW,
  COMMAND_HIDE,
  COMMAND_SETTINGS,
  PLUGIN_ID,
  // 导出内部函数便于宿主/调试一次性读取（不影响正常路径）
  _internal: {
    stripJsonComments,
    reduceSnapshot,
    reduceAgentEvent,
    syncResponse,
    settingsPayload,
    // 角色/宠物表往返（纯函数，可在无宿主环境下检查持久化兼容）
    pickCharacter,
    availableCharacters,
    basePets,
    normalizePets,
    sanitizeSettingsPatch,
  },
};
