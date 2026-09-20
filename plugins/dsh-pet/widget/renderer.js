/**
 * dsh-pet 桌宠（这是一个助手插件）—— 启动入口。
 *
 * 移植自上游 runtime/electron-helper/renderer.js（MIT，见 ../README.md）。
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js → events.js → renderer.js。
 *
 * 上游这里做三件事：拉宿主成品配置、装配 sprite、注入素材与菜单样式。移植后：
 *   - 配置来自插件主进程的 `pet.config`（= config.jsonc 与用户设置的成品聚合），
 *     再经 shared 的 flattenConfigPets 拍平成渲染列表（与上游同一份拍平逻辑）；
 *   - 桌面几何来自宿主 widget 的 `getState`（2s 轮询 + 签名比对，变化才 relayout）；
 *   - 点击穿透由本文件的 60ms 兜底轮询按 decideWindowIgnore 统一翻转。
 *
 * 本窗口只承载一只宠物：`?pet=<id>`；根窗口（插件启动时由主进程打开、无该参数）
 * 领取宠物表里的第一只。多出来的宠物由 leader 窗口用 widget.open 开出去（见 events.js）。
 */
'use strict';

// ---------- 配置（大声报错；失败 5s 重试） ----------
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

async function loadConfig() {
  const res = await panelInvoke('pet.config', { widgetId: ownWidgetId, pet: assignedPetId });
  if (!res || !res.ok) {
    const message = res && res.error && res.error.message ? res.error.message : '插件主进程没有返回配置';
    throw new Error(message);
  }
  const merged = res.config;
  configStamp = Number(res.configStamp) || 0;
  openIds = Array.isArray(res.openIds) ? res.openIds : [];
  closedIds = Array.isArray(res.closedIds) ? res.closedIds : [];
  alwaysOnTop = res.alwaysOnTop !== false;
  return {
    // 唯一配置入口：主进程的成品聚合（已合并用户设置），一步拍平成渲染列表
    pets: S.flattenConfigPets(merged),
    refreshSec: (merged && merged.main && merged.main.eventsRefreshSec) || {},
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
  };
}

/** 每个窗口在首次启动时绑定一只宠物，配置更新不会把它变成另一只。 */
let assignedPetId = CONFIG.petId || '';
function pickPet(pets) {
  const visible = pets.filter((pet) => pet.enabled !== false && !closedIds.includes(pet.id));
  if (assignedPetId) return visible.find((pet) => pet.id === assignedPetId) || null;
  const pet = visible.find((pet) => !openIds.includes(pet.id)) || null;
  if (pet) assignedPetId = pet.id;
  return pet;
}

let booting = false;
/** 装配（重挂）：boot 的幂等入口，配置戳/尺寸变化都走这里 */
async function boot() {
  if (window.__dshPetDebug.petId === undefined) {
    window.__dshPetDebug.petId = CONFIG.petId || '(root)';
  }
  if (booting) return;
  booting = true;
  try {
    await refreshHostState();
    const cfg = await loadConfig();
    config = cfg;
    hideError();
    const pet = pickPet(cfg.pets.filter((p) => S.isDesktopVisible(p.display)));
    if (!pet) {
      for (const sprite of sprites) sprite.dispose();
      sprites = [];
      if (HAS_WIDGET_API) await widgetInvoke('close', {});
      else showInfo('当前没有启用的桌宠');
      return;
    }
    for (const sprite of sprites) sprite.dispose();
    sprites = [new PetSprite(pet)];
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const sprite of sprites) sprite.playIdle();
    applyAlwaysOnTop();
    startSyncLoop();
  } catch (error) {
    showError('dsh-pet 配置错误：' + ((error && error.message) || error));
    scheduleReboot();
  } finally {
    booting = false;
  }
}

/** 配置变化（设置里改了大小/宠物表）后就地重挂：先让旧 sprite 停住，再重建 */
async function rebootstrap() {
  for (const sprite of sprites) sprite.dispose();
  sprites = [];
  await boot();
}

// ---------- 宿主几何 + 点击穿透（两个轮询） ----------
let geometrySignatureCache = '';

/** 拉一次 widget 状态：挂显示器几何、记录窗口矩形、拿到光标（穿透判定用） */
async function refreshHostState() {
  let state = null;
  try {
    state = await widgetInvoke('getState');
  } catch (error) {
    window.__dshPetDebug.stateError = String((error && error.message) || error);
    return null;
  }
  if (!state || typeof state !== 'object') return null;
  winBounds = state.bounds && typeof state.bounds === 'object' ? state.bounds : null;
  ownWidgetId = typeof state.id === 'string' ? state.id : ownWidgetId;
  window.__dshPetDebug.windowId = ownWidgetId;
  const signature = geometrySignature(state.displays);
  if (signature && signature !== geometrySignatureCache) {
    geometrySignatureCache = signature;
    if (applyDeskGeometry(state.displays)) {
      for (const sprite of sprites) sprite.relayout();
    }
  }
  return state;
}

/** 显示器/分辨率变化：2s 一次签名比对（变化才重挂，不打断动画） */
async function pollGeometry() {
  await refreshHostState();
  setTimeout(() => void pollGeometry(), 2000);
}

/** 点击穿透兜底：60ms 按真实光标位置决定要不要翻转（与上游同一条通道的同一套判定） */
async function pollPointer() {
  if (!CONFIG.settingsScreen && sprites.length && winBounds && ignoreState !== null) {
    const state = await refreshHostState();
    const cursor = state && state.cursor && Number.isFinite(Number(state.cursor.x)) ? state.cursor : null;
    // 空闲鼠标关注：把全局光标交给宠物体（图集角色用它选视线格；视频角色内部直接忽略）
    sprites[0].onCursor(cursor);
    if (cursor && winBounds) {
      const busy = sprites[0].inputBusy();
      const next = decideWindowIgnore(winBounds, cursor, ignoreState, busy);
      if (next !== ignoreState) setWindowIgnore(next);
    }
  }
  setTimeout(() => void pollPointer(), 60);
}

function applyAlwaysOnTop() {
  widgetInvoke('setAlwaysOnTop', { value: alwaysOnTop }).catch(() => {});
}

// ---------- 设置屏（?settings=1）：同一个 ui.panel 入口的另一屏 ----------
function makeSettingsMovable(host) {
  const handle = host.querySelector('[data-pet-drag-handle]');
  if (!handle) return;
  let dragging = false;
  let start = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    if (!winBounds) return;
    dragging = true;
    start = { x: event.screenX, y: event.screenY, bx: winBounds.x, by: winBounds.y };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging || !start) return;
    const x = start.bx + (event.screenX - start.x);
    const y = start.by + (event.screenY - start.y);
    winBounds = { ...(winBounds || {}), x, y };
    widgetInvoke('setBounds', {
      x,
      y,
      width: winBounds.width,
      height: winBounds.height,
    }).catch(() => {});
  });
  const stop = () => {
    dragging = false;
    start = null;
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
}

function bootSettingsScreen() {
  document.documentElement.dataset.petScreen = 'settings';
  if (!window.PetSettings || typeof window.PetSettings.mount !== 'function') {
    showError('设置界面脚本没有加载成功（views/settings.js）');
    return;
  }
  setWindowIgnore(false); // 设置窗口整窗可交互：没有点击穿透
  window.PetSettings.mount(settingsRootEl, {
    movable: true,
    onClose: () => {
      widgetInvoke('close', { id: 'dsh-pet-settings' }).catch((error) => {
        showError('关闭设置失败：' + ((error && error.message) || error));
      });
    },
  });
  makeSettingsMovable(settingsRootEl);
}

// ---------- 启动 ----------
// 原生右键菜单：一律由页面自绘菜单接管（宠物是自绘菜单，设置屏没有菜单但也不该弹原生菜单）
window.addEventListener(
  'contextmenu',
  (event) => {
    event.preventDefault();
  },
  true,
);

window.addEventListener('resize', () => {
  for (const sprite of sprites) {
    if (sprite.dragState.active || sprite.throwRef !== null || sprite.moveRef !== null) continue;
    sprite.position();
  }
});

// 宿主广播的窗口开合：兄弟窗口被关掉（宿主的 widget 菜单 / 我们的「收起这只宠物」）时
// 立刻通知插件主进程记账，不必等 6s 心跳超时——否则 leader 会在这段时间里反复把它开出来。
if (window.pluginBridge && typeof window.pluginBridge.on === 'function') {
  window.pluginBridge.on('widget:closed', (payload) => {
    const id = payload && typeof payload.id === 'string' ? payload.id : '';
    if (!id) return;
    panelInvoke('pet.closePet', { pet: id }).catch(() => {});
  });
}

if (!HAS_WIDGET_API) {
  // 预览 / 降级：宿主没有 widget API（例如直接用浏览器打开这个页面，或旧版宿主）。
  // 仍然把宠物渲染出来——几何退化成「页面本身就是那块屏」，动画/拖拽/甩抛/漫游照跑，
  // 只是没有真实的透明小窗、点击穿透与多宠物。右侧工作面板的「桌面宠物设置」视图也可能读不到设置，
  // 会在状态栏里报错而不是静默假装成功。
  showInfo('预览模式：未检测到宿主 widget API，宠物只在页面内渲染（无透明窗口 / 点击穿透）');
  applyDeskGeometry([
    {
      bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      workArea: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
      scaleFactor: 1,
    },
  ]);
  window.addEventListener('resize', () => {
    applyDeskGeometry([
      {
        bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        workArea: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        scaleFactor: 1,
      },
    ]);
    for (const sprite of sprites) sprite.relayout();
  });
  if (CONFIG.settingsScreen) bootSettingsScreen();
  else void boot();
} else {
  // 默认整窗穿透：透明像素不挡下层应用（宠物身体命中区由轮询翻转）
  setWindowIgnore(true);
  void refreshHostState().then(() => {
    if (CONFIG.settingsScreen) {
      bootSettingsScreen();
      void pollGeometry();
      return;
    }
    void boot();
    void pollGeometry();
    void pollPointer();
  });
}
