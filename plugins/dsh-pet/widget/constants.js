/**
 * dsh-pet 桌宠（这是一个助手插件）—— 基础设施：常量 + 全局状态 + 宿主 widget 桥 + 桌面几何。
 *
 * 移植自上游 runtime/electron-helper/constants.js（MIT，见 ../README.md）。
 *
 * 与上游的差别（三处，都是环境差异而非行为差异）：
 *   1. 上游的窗口原语在独立的 Electron 主进程里（ipcRenderer → 主进程 setContentBounds /
 *      setIgnoreMouseEvents）。移植后由这是一个助手宿主的 widget API 直接提供：
 *      `window.pluginBridge.widget.invoke('getState' | 'setBounds' | 'setIgnoreMouse' | ...)`，
 *      本文件把入口、几何换算与穿透判定收口在这里。
 *   2. 上游的 CONFIG.scale（页面级 setZoomFactor）在 widget 里没有对应物——宿主用 DIP，
 *      页面 1 CSS px == 1 DIP，所以 toScreen/toLocal 退化成恒等函数（保留函数名与全部调用点，
 *      使 sprite.js / 纯逻辑的代码与上游逐行对应，便于比对）。
 *   3. 上游的桌面几何由主进程注入 URL query + pet:displays 推送；这里统一改成轮询
 *      widget 的 `getState`（返回显示器列表与光标位置），几何变化时重挂。
 *
 * 经典 script 全局共享（经 index.html 顺序加载，先于 sprite.js / events.js / renderer.js）。
 */
'use strict';

const S = window.PetShared;

/** widget 桥：宿主没提供时整个页面进入「不可用」状态，只显示红色错误条，绝假装能用 */
const WIDGET = (window.pluginBridge && window.pluginBridge.widget) || null;
const HAS_WIDGET_API = !!(WIDGET && typeof WIDGET.invoke === 'function');
function widgetInvoke(action, payload) {
  if (!HAS_WIDGET_API) return Promise.reject(new Error('宿主未提供 pluginBridge.widget'));
  return WIDGET.invoke(action, payload);
}

/** 面板桥（与插件主进程通信的通道）：pet.config / pet.sync / pet.settings.* … */
function panelInvoke(channel, payload) {
  if (!window.pluginBridge || typeof window.pluginBridge.invoke !== 'function') {
    return Promise.reject(new Error('宿主未提供 pluginBridge'));
  }
  return window.pluginBridge.invoke(channel, payload || {});
}

const params = new URLSearchParams(location.search);
const CONFIG = {
  /** 本窗口承载哪只宠物：`?pet=<id>`；根窗口（插件启动时由主进程打开）没有该参数 */
  petId: params.get('pet') || '',
  /** 设置屏：同一个 ui.panel 入口，query 决定渲染哪一屏 */
  settingsScreen: params.get('settings') === '1',
};

// ---------- 坐标系统一约定 ----------
// 全部几何都在 DIP / CSS 像素里：宿主 widget 的 getState/setBounds 都是 DIP，
// 页面没有页面级缩放，因此上游那层「物理像素 ↔ CSS 像素」换算在这里是恒等映射。
// 保留函数名与调用点，使 sprite.js 与上游逐行对应（移植时可 diff）。
function toScreen(v) {
  return v;
}
function toLocal(v) {
  return v;
}

/**
 * 视口 = 全部显示器工作区的外接矩形（多显示器时即整个桌面；窗口只是宠物的一块局部画布）。
 * 它只是**坐标系原点与比例换算基准**：位置比例（customPos）、漫游 ratio 都按它算。
 * 字段可变：分辨率/缩放变化、插拔屏、旋转时由 applyDeskGeometry 就地重挂。
 */
const VIEW = { x: 0, y: 0, w: 1920, h: 1080 };
/** 逐显示器工作区，**视口相对坐标**（= 屏幕坐标 − VIEW 原点）。抛掷/漫游/菜单夹取都走它们的并集 */
let AREAS = [];
/** 逐显示器**完整面板**（含任务栏区，视口相对坐标，与 AREAS 同序）：抛掷「越界侧有没有邻屏」的探测用它 */
let PANELS = [];
/** 主屏工作区（视口相对坐标）：角落定位与「回到初始位置」用它 */
let PRIMARY_AREA = null;

/** 把一个矩形列表整体平移到视口相对坐标 */
function translateRects(rects, dx, dy) {
  return rects.map((r) => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }));
}

/**
 * 把宿主 getState 的显示器列表挂到 VIEW / AREAS / PANELS。
 * 宿主给的是 DIP（与页面同一套单位），所以这里不做任何缩放。
 * primary 取 displays[0]：这是宿主 API 里唯一稳定的主屏线索，其余屏的顺序不影响判定
 * （角落锚点只需要「某一块真实的屏」，不是「外接矩形的角落」——外接矩形在不规则多屏下含空洞）。
 */
function applyDeskGeometry(displays) {
  const list = Array.isArray(displays)
    ? displays
        .map((d) => (d && d.workArea ? d.workArea : null))
        .filter((a) => a && a.width > 0 && a.height > 0)
    : [];
  if (!list.length) return false;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of list) {
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.width);
    y1 = Math.max(y1, a.y + a.height);
  }
  VIEW.x = x0;
  VIEW.y = y0;
  VIEW.w = x1 - x0;
  VIEW.h = y1 - y0;
  AREAS = translateRects(list, -VIEW.x, -VIEW.y);
  const panels = Array.isArray(displays)
    ? displays.map((d) => (d && d.bounds ? d.bounds : null)).filter((b) => b && b.width > 0)
    : [];
  PANELS = translateRects(panels.length === list.length ? panels : list, -VIEW.x, -VIEW.y);
  PRIMARY_AREA = AREAS[0];
  return true;
}

/** 几何签名：只有真的变了才重挂 + relayout（轮询 getState 时避免每 2s 白忙一次） */
function geometrySignature(displays) {
  if (!Array.isArray(displays)) return '';
  return displays
    .map((d) => {
      const b = d && d.bounds ? d.bounds : {};
      const w = d && d.workArea ? d.workArea : {};
      return [b.x, b.y, b.width, b.height, w.x, w.y, w.width, w.height, d && d.scaleFactor].join(',');
    })
    .join('|');
}

// ---------- 全局状态 ----------
const rootEl = document.getElementById('root');
const settingsRootEl = document.getElementById('settings-root');
const errorEl = document.getElementById('pet-error');
/** 本窗口在宿主里的 widget id（根宠物窗口 = `panel`，其余 = 宠物 id；设置窗口 = dsh-pet-settings）。
 *  关闭窗口必须用这个 id，不能用宠物 id——根窗口的 widget id 由宿主决定。 */
let ownWidgetId = '';
let config = null; // { pets: 拍平后的成品实例列表, refreshSec, physics }
let sprites = []; // PetSprite[]（本窗口只装一只宠物）
let workTick = 0; // 工作状态联动 tick：sync 下发的 ts 变化才递增
let bootTimer = null;
let loopsStarted = false;
/** 本次运行是否允许漫游（设置项，随 sync 下发） */
let roamingEnabled = true;
/** 本次运行是否跟随会话状态（设置项，随 sync 下发） */
let workStatusEnabled = true;
/** 窗口置顶（设置项） */
let alwaysOnTop = true;
/** 当前窗口矩形（宿主 getState 的最新值，DIP 屏幕坐标）——穿透判定与菜单夹取用 */
let winBounds = null;
/** sync 下发的宠物登记表与 leader 归属（多宠物窗口链） */
let petsTable = [];
let leaderId = '';
let rootPetId = '';
let closedIds = [];
let openIds = [];
let configStamp = 0;
/** 碎碎念：`{ts, text}` 或 null（pet.sync 下发，ts 变化才展示） */
let whisperFrame = null;
let prevWhisperTs = 0;
let whisperBaseline = false;

// ---------- 调试钩子 ----------
window.__dshPetDebug = {
  errors: [],
  configOk: false,
  spriteCount: 0,
  lastBubbleTitle: '',
  menuOpen: false,
  chatOpen: false,
  bootAt: Date.now(),
  widgetApi: HAS_WIDGET_API,
  sent: 0, // setBounds 实际发出的次数（去重后的真实移动量）
};
window.addEventListener('error', (event) => {
  window.__dshPetDebug.errors.push(String(event.message || event.error));
});

/** 配置/宿主错误：红底，显眼报错（不做静默兜底） */
function showError(message) {
  window.__dshPetDebug.configOk = false;
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove('is-info');
  errorEl.classList.add('visible');
}
/** 中性提示（预览模式等）：不是错误，用灰底而不是红底 */
function showInfo(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.add('is-info', 'visible');
}
function hideError() {
  if (!errorEl) return;
  errorEl.classList.remove('visible', 'is-info');
  errorEl.textContent = '';
}

// ---------- 点击穿透（上游 pointer-target.js 的同一套判定） ----------
/** 宠物身体命中区（画布坐标，与 src/shared/constants.ts 的 HIT_BOX 一致） */
const HIT_BOX = S.HIT_BOX;
const CANVAS_H = S.CANVAS_H;
const STAGE_W = 640;
/** 默认命中区（视频角色）：HIT_BOX 换成「占舞台的比例」，图集角色会覆盖它（素材包围盒更窄） */
const DEFAULT_HIT_SPEC = {
  x: HIT_BOX.x0 / STAGE_W,
  y: HIT_BOX.y0 / CANVAS_H,
  w: (HIT_BOX.x1 - HIT_BOX.x0) / STAGE_W,
  h: (HIT_BOX.y1 - HIT_BOX.y0) / CANVAS_H,
};
/** 本窗口宠物的命中区（舞台比例）：由 sprite 构造时按角色写入；非法值回落默认 */
let hitSpec = DEFAULT_HIT_SPEC;
function setHitSpec(spec) {
  hitSpec =
    spec && Number.isFinite(spec.x + spec.y + spec.w + spec.h) && spec.w > 0 && spec.h > 0
      ? spec
      : DEFAULT_HIT_SPEC;
}

/** 窗口矩形 → 宠物身体命中区的屏幕矩形（DIP），与上游 pointer-target.js 同源 */
function spriteHitRect(bounds) {
  const margin = Math.round(bounds.width / 4);
  const stageW = bounds.width - margin * 2;
  const stageH = (stageW * CANVAS_H) / STAGE_W;
  return {
    left: bounds.x + margin + hitSpec.x * stageW,
    top: bounds.y + margin + hitSpec.y * stageH,
    right: bounds.x + margin + (hitSpec.x + hitSpec.w) * stageW,
    bottom: bounds.y + margin + (hitSpec.y + hitSpec.h) * stageH,
  };
}

/**
 * 该不该让窗口保持穿透（= setIgnoreMouse 的 ignore 参数）。
 * 规则与上游完全一致：
 *  - 渲染端正拿着鼠标输入（拖拽中 / 菜单开着）→ 不穿透，最高优先级；
 *  - 光标在宠物身体上 → 不穿透（可交互）；
 *  - 光标在窗口内、宠物外 → 保持当前状态（否则自绘菜单/弹窗鼠标一移出身体就点不到）；
 *  - 光标在窗口外 → 恢复穿透。
 */
function decideWindowIgnore(bounds, point, ignoring, busy) {
  if (busy) return false;
  const inWindow =
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height;
  if (!inWindow) return true;
  const r = spriteHitRect(bounds);
  const inSprite = point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
  if (inSprite) return false;
  return ignoring;
}

/** 已上报的穿透状态（null = 还没上报过） */
let ignoreState = null;
/** 翻转整窗穿透的唯一出口：状态镜像与宿主调用永远一起更新 */
function setWindowIgnore(ignore) {
  const next = !!ignore;
  if (next === ignoreState) return;
  ignoreState = next;
  window.__dshPetDebug.ignore = next;
  widgetInvoke('setIgnoreMouse', { ignore: next }).catch(() => {
    /* 窗口正在关闭等：忽略 */
  });
}
