/**
 * dsh-pet 桌宠（这是一个助手插件）—— 事件联动（工作状态 / 碎碎念 / 跨窗状态同步）。
 *
 * 移植自上游 runtime/electron-helper/events.js（MIT，见 ../README.md）。
 * 上游靠三条 HTTP 轮询（/work-status、/whisper、/broadcast）+ 主进程 IPC 广播；
 * 移植后收敛成**一条** `pet.sync` 轮询（见 startSyncLoop）：
 *   → 上行：自己的包围盒 / 尺寸 / 速度 / 是否飞行中；
 *   ← 下行：其它宠物状态（跨窗碰撞）、被撞动量、工作状态快照、碎碎念、配置戳、宠物登记表。
 * 轮询频率随状态变化：飞行/拖拽中 60ms（碰撞检测要跟得上），空闲 1.2s（省电、也够状态联动）。
 *
 * 依赖 constants.js / sprite.js（运行时可解析，顺序无碍）。
 */
'use strict';

const SYNC_FAST_MS = 60;
const SYNC_IDLE_MS = 1200;
const BUBBLE_DURATION_MS = 10 * 1000;

// ---- 工作状态联动（这是一个助手的会话状态 → 档位动画 + 气泡）----
// 气泡驻留语义与上游一致：thinking/working/result/waiting（"事情还没完"）常驻到状态切走；
// success/error（"这事结束了"）10s 自动收起；state=null（空闲）收起并回待机。
// 动画循环语义：进行中档位循环播（once=false，多候选档位播完由 handleEnded 轮换）；
// 终态档位播一遍回 idle 链。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled || !workStatusEnabled) return;
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state;
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events && this.animations.events.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim);
  this.stopMove();
  // 气泡文本：会话状态自带的详情优先，否则从条目级 workStatusTexts[档位] 随机抽一句
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick 不重新点亮已自动收起的终态气泡
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null;
  }
  this.renderBubble();
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false);
};

/** 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 气泡 10s；文本由插件主进程生成 */
PetSprite.prototype.showWhisper = function showWhisper(text) {
  if (!text) return;
  const pool = this.animations.events && this.animations.events.whisper;
  this.stopMove();
  this.bubbleOn = true;
  this.bubbleText = String(text);
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  if (pool && pool.length) {
    const slot = S.pick(pool, this.anim);
    this.playOnce(S.pickSlot(slot, this.anim));
  }
};

/** 通用提示气泡（错误/说明）：只弹文字，不抢动画前台 */
PetSprite.prototype.showNotice = function showNotice(text) {
  if (!text) return;
  this.bubbleOn = true;
  this.bubbleText = String(text);
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// ---- 与插件主进程的单条轮询（状态上行 / 状态与事件下行）----
let syncTimer = null;
let syncInFlight = false;

function spriteSyncPayload(sprite) {
  const fly = sprite && sprite.throwState;
  return {
    pet: sprite ? sprite.pet.id : CONFIG.petId || 'main',
    widgetId: ownWidgetId,
    box: sprite ? { x: sprite.pos.x, y: sprite.pos.y } : { x: 0, y: 0 },
    size: sprite ? sprite.size : 0,
    bottomPad: sprite ? sprite.bottomPad : 0,
    vx: fly ? fly.vx : 0,
    vy: fly ? fly.vy : 0,
    flying: !!(sprite && sprite.throwState),
  };
}

function syncInterval() {
  const sprite = sprites[0];
  if (!sprite) return SYNC_IDLE_MS;
  return sprite.throwState || sprite.dragState.active ? SYNC_FAST_MS : SYNC_IDLE_MS;
}

function scheduleSync() {
  if (syncTimer !== null) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => void runSync(), syncInterval());
}

async function runSync() {
  syncTimer = null;
  const sprite = sprites[0];
  if (!sprite || syncInFlight) {
    scheduleSync();
    return;
  }
  syncInFlight = true;
  try {
    const res = await panelInvoke('pet.sync', spriteSyncPayload(sprite));
    if (res && res.ok) await applySyncResponse(res, sprite);
  } catch (error) {
    // 轮询失败（宿主重启、窗口关闭中）：不打断本地动画，下个周期再试
    window.__dshPetDebug.syncError = String((error && error.message) || error);
  } finally {
    syncInFlight = false;
    scheduleSync();
  }
}

/** 应用一次 sync 应答：跨窗状态、被撞动量、工作状态、碎碎念、配置戳、宠物登记表 */
async function applySyncResponse(res, sprite) {
  // 跨窗碰撞：其它宠物的最新状态（碰撞检测用）
  if (res.others && typeof res.others === 'object') {
    sprite.others = res.others;
  } else {
    sprite.others = {};
  }
  // 被撞动量：由插件主进程从飞行方转发过来 → 用新初速把自己抛出去
  if (Array.isArray(res.hits)) {
    for (const hit of res.hits) {
      const vx = Number(hit && hit.vx);
      const vy = Number(hit && hit.vy);
      if (Number.isFinite(vx) && Number.isFinite(vy)) sprite.onDeskHit(vx, vy);
    }
  }
  // 工作状态联动：ts 变化才递增 tick（与上游 /work-status 轮询同一判定）
  roamingEnabled = res.roaming !== false;
  workStatusEnabled = res.workStatusEnabled !== false;
  const pin = res.alwaysOnTop !== false;
  if (alwaysOnTop !== pin) {
    alwaysOnTop = pin;
    applyAlwaysOnTop();
  }
  const snapshot = S.normalizeWorkStatus(res.workStatus);
  if (snapshot.ts !== 0 && snapshot.ts !== sprite.prevWorkTs) {
    sprite.prevWorkTs = snapshot.ts;
    workTick += 1;
    sprite.onWorkTick(snapshot, workTick);
  } else if (snapshot.ts === 0 && sprite.prevWorkTs !== 0) {
    sprite.prevWorkTs = 0;
    workTick += 1;
    sprite.onWorkTick(snapshot, workTick);
  }
  // 碎碎念：ts 变化才展示（首帧仅记基线，避免重放历史）
  const whisper = res.whisper && typeof res.whisper === 'object' ? res.whisper : null;
  if (whisper) {
    if (!whisperBaseline) {
      whisperBaseline = true;
      prevWhisperTs = Number(whisper.ts) || 0;
    } else if (Number(whisper.ts) !== prevWhisperTs) {
      prevWhisperTs = Number(whisper.ts) || 0;
      sprite.showWhisper(whisper.text);
    }
  }
  // 多宠物登记表：leader 负责把兄弟窗口对齐到这张表
  petsTable = Array.isArray(res.pets) ? res.pets : [];
  leaderId = typeof res.leaderId === 'string' ? res.leaderId : '';
  rootPetId = typeof res.rootPetId === 'string' ? res.rootPetId : '';
  closedIds = Array.isArray(res.closedIds) ? res.closedIds : [];
  openIds = Array.isArray(res.openIds) ? res.openIds : [];
  if (!(await reconcilePetWindows())) return;
  // 配置变化（设置改了大小/宠物表）：重挂本窗口
  const stamp = Number(res.configStamp) || 0;
  if (stamp && stamp !== configStamp) {
    configStamp = stamp;
    void rebootstrap();
  }
  if (Array.isArray(res.errors) && res.errors.length && !res.errors.__shown) {
    const first = res.errors[0];
    if (first && first.message) showError('插件状态异常：' + first.message);
  }
}

// ---- 菜单动作（右键菜单的工具根项；动作实现放这里，sprite.js 只派发）----
function runSpriteAction(action, sprite) {
  switch (action) {
    case 'whisper':
      void requestWhisper(sprite);
      return;
    case 'toggle-pin':
      void toggleAlwaysOnTop();
      return;
    case 'open-settings':
      void openSettingsWindow();
      return;
    case 'close-pet':
      void closeThisPet(sprite);
      return;
    case 'hide-all':
      void hideAllPets();
      return;
    default:
      return;
  }
}

async function requestWhisper(sprite) {
  try {
    const res = await panelInvoke('pet.whisper', { pet: sprite.pet.id });
    if (res && res.ok && res.text) {
      sprite.showWhisper(res.text);
      prevWhisperTs = Date.now();
      whisperBaseline = true;
      return;
    }
    const message =
      res && res.error && res.error.message ? res.error.message : '碎碎念生成失败（没有返回原因）';
    console.warn('[dsh-pet] ' + message);
    sprite.showNotice('碎碎念没生成出来：' + message);
  } catch (error) {
    sprite.showNotice('碎碎念没生成出来：' + ((error && error.message) || error));
  }
}

async function toggleAlwaysOnTop() {
  const next = !alwaysOnTop;
  try {
    await widgetInvoke('setAlwaysOnTop', { value: next });
    alwaysOnTop = next;
    await panelInvoke('pet.settings.set', { alwaysOnTop: next });
  } catch (error) {
    console.warn('[dsh-pet] 切换置顶失败：', error);
  }
}

/** 收起这只宠物：先让主进程记账（本次运行不再自动打开），再关自己的窗口 */
async function closeThisPet(sprite) {
  try {
    await panelInvoke('pet.closePet', { pet: sprite.pet.id });
  } catch {
    /* 记账失败也要关窗：否则用户点不动 */
  }
  try {
    // 关窗要用**本窗口的 widget id**（根宠物窗口的 id 是宿主给的 `panel`，不等于宠物 id）
    await widgetInvoke('close', ownWidgetId ? { id: ownWidgetId } : {});
  } catch (error) {
    console.warn('[dsh-pet] 关闭窗口失败：', error);
  }
}

async function hideAllPets() {
  try {
    const result = await panelInvoke('pet.hideAll', {});
    if (result && !result.ok) throw new Error(result.error?.message || '无法收起宠物');
  } catch (error) {
    if (sprites[0]) sprites[0].showNotice(String(error.message || error));
  }
}

/** 打开设置窗口：同一个 ui.panel 入口，query 决定渲染哪一屏（宿主按 id 复用同一窗口） */
async function openSettingsWindow() {
  const size = sprites[0] ? sprites[0].size : 320;
  try {
    await widgetInvoke('open', {
      id: 'dsh-pet-settings',
      query: { settings: '1' },
      width: 460,
      height: 620,
    });
  } catch (error) {
    console.warn('[dsh-pet] 打开设置窗口失败：', error);
    if (sprites[0]) {
      sprites[0].showNotice('设置窗口打不开，可在右侧工作面板打开「桌面宠物设置」');
    }
    void size;
  }
}

/**
 * 多宠物窗口对齐（leader 唯一负责）：
 * 目标 = 宠物表里 enabled 且不在 closedIds 的宠物；差异用 widget.open / widget.close 补齐。
 * 每个宠物窗口尺寸 = 2×size × (winH + size)，与 sprite.js 的坐标约定一致。
 */
let lastReconcileAt = 0;
async function reconcilePetWindows() {
  const own = sprites[0];
  if (!own) return false;
  const wanted = petsTable.filter((pet) => pet && pet.enabled !== false && !closedIds.includes(pet.id));
  const ownWanted = wanted.some((pet) => pet.id === own.pet.id);
  const now = Date.now();
  if (own.pet.id === leaderId && (!ownWanted || now - lastReconcileAt >= 500)) {
    lastReconcileAt = now;
    for (const pet of wanted) {
      if (openIds.includes(pet.id) || pet.id === own.pet.id) continue;
      const size = Math.max(120, Number(pet.size) || 320);
      try {
        await widgetInvoke('open', {
          id: pet.id,
          query: { pet: pet.id },
          width: Math.round(size * 2),
          height: Math.max(120, Math.round(size * 1.609375)),
        });
      } catch (error) {
        console.warn('[dsh-pet] 打开宠物窗口失败：', pet.id, error);
      }
    }
  }
  if (!ownWanted) {
    await closeThisPet(own);
    return false;
  }
  return true;
}

// ---- 启动/停止 ----
function startSyncLoop() {
  if (loopsStarted) return;
  loopsStarted = true;
  scheduleSync();
}
