var PetShared = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/shared/index.ts
  var index_exports = {};
  __export(index_exports, {
    ACCEL_GAIN_MAX: () => ACCEL_GAIN_MAX,
    ACCEL_REF: () => ACCEL_REF,
    ANIMATION_EXT: () => ANIMATION_EXT,
    CANVAS_H: () => CANVAS_H,
    DEAD_ZONE_SPEED: () => DEAD_ZONE_SPEED,
    DEFAULT_CHARACTER: () => DEFAULT_CHARACTER,
    DEFAULT_PHYSICS: () => DEFAULT_PHYSICS,
    DEFAULT_THROW_POWER: () => DEFAULT_THROW_POWER,
    DRAG_THRESHOLD: () => DRAG_THRESHOLD,
    FEET_Y: () => FEET_Y,
    GRAVITY: () => GRAVITY,
    GROUND_FRICTION: () => GROUND_FRICTION,
    HIT_BOX: () => HIT_BOX,
    MAX_STEP_DT: () => MAX_STEP_DT,
    MAX_THROW_SPEED: () => MAX_THROW_SPEED,
    MENU_CSS: () => MENU_CSS,
    MIN_SPAN_MS: () => MIN_SPAN_MS,
    PEAK_WEIGHT: () => PEAK_WEIGHT,
    PET_BOUNCE_E: () => PET_BOUNCE_E,
    PET_DISPLAYS: () => PET_DISPLAYS,
    PET_REF_WIDTH: () => PET_REF_WIDTH,
    RELEASE_STALE_MS: () => RELEASE_STALE_MS,
    RELEASE_WINDOW_MS: () => RELEASE_WINDOW_MS,
    RESTITUTION: () => RESTITUTION,
    REST_VX: () => REST_VX,
    REST_VY: () => REST_VY,
    SCORE_MIN_SPEED: () => SCORE_MIN_SPEED,
    SCORE_POPUP_CSS: () => SCORE_POPUP_CSS,
    SCORE_POPUP_DURATION_MS: () => SCORE_POPUP_DURATION_MS,
    SEG_MIN_DT_MS: () => SEG_MIN_DT_MS,
    SPRING_C: () => SPRING_C,
    SPRING_K: () => SPRING_K,
    SQ_DURATION_MS: () => SQ_DURATION_MS,
    SQ_HARD_SPEED: () => SQ_HARD_SPEED,
    SQ_MAX_SQUASH: () => SQ_MAX_SQUASH,
    SQ_SOFT_SPEED: () => SQ_SOFT_SPEED,
    SQ_SQUASH: () => SQ_SQUASH,
    TRAIL_KEEP_MS: () => TRAIL_KEEP_MS,
    WORK_STATUS_INDEX: () => WORK_STATUS_INDEX,
    WORK_STATUS_STATES: () => WORK_STATUS_STATES,
    anchorPixel: () => anchorPixel,
    bodyPixelBox: () => bodyPixelBox,
    boundingRect: () => boundingRect,
    buildMenuTree: () => buildMenuTree,
    characterProfileOf: () => characterProfileOf,
    clampPointInRect: () => clampPointInRect,
    clampPointToRegion: () => clampPointToRegion,
    clickScore: () => clickScore,
    collidePet: () => collidePet,
    distToRectSq: () => distToRectSq,
    estimateReleaseVelocity: () => estimateReleaseVelocity,
    flattenConfigPets: () => flattenConfigPets,
    indexAtPoint: () => indexAtPoint,
    isDesktopVisible: () => isDesktopVisible,
    isEventAnim: () => isEventAnim,
    isNoMirrorAnimation: () => isNoMirrorAnimation,
    isWebVisible: () => isWebVisible,
    landingSquash: () => landingSquash,
    mountContextMenu: () => mountContextMenu,
    mountScorePopup: () => mountScorePopup,
    nearestIndex: () => nearestIndex,
    nextWorkStatusAnim: () => nextWorkStatusAnim,
    normalizeWorkStatus: () => normalizeWorkStatus,
    pick: () => pick,
    pickCategoryAction: () => pickCategoryAction,
    pickSlot: () => pickSlot,
    pickWeightedCategory: () => pickWeightedCategory,
    planMove: () => planMove,
    pointInRect: () => pointInRect,
    poolIncludes: () => poolIncludes,
    randomBetween: () => randomBetween,
    rectAtPoint: () => rectAtPoint,
    rectBottom: () => rectBottom,
    rectRight: () => rectRight,
    rectsOverlap: () => rectsOverlap,
    regionArea: () => regionArea,
    regionHoleRatio: () => regionHoleRatio,
    resolveRect: () => resolveRect,
    rollKind: () => rollKind,
    screenOfBox: () => screenOfBox,
    slotIncludes: () => slotIncludes,
    spawnScoreBurst: () => spawnScoreBurst,
    springStep: () => springStep,
    squashScale: () => squashScale,
    throwBounds: () => throwBounds,
    throwBoundsIn: () => throwBoundsIn,
    throwSpace: () => throwSpace,
    throwStep: () => throwStep,
    throwStepRegion: () => throwStepRegion,
    translateRects: () => translateRects,
    trimTrail: () => trimTrail
  });

  // src/shared/constants.ts
  var CANVAS_H = 360;
  var FEET_Y = 330;
  var HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
  var DRAG_THRESHOLD = 5;
  var PET_REF_WIDTH = 462;
  var ANIMATION_EXT = ".webm";

  // src/shared/pickers.ts
  var pick = (pool, exclude) => {
    const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
    const src = entries.length ? entries : pool;
    return src[Math.floor(Math.random() * src.length)];
  };
  var pickSlot = (slot, exclude) => {
    if (typeof slot === "string") return slot;
    const entries = exclude === void 0 ? slot : slot.filter((n) => n !== exclude);
    const src = entries.length ? entries : slot;
    return src[Math.floor(Math.random() * src.length)];
  };
  var slotIncludes = (slot, anim) => typeof slot === "string" ? slot === anim : slot.includes(anim);
  var poolIncludes = (pool, anim) => pool.some((slot) => slotIncludes(slot, anim));
  var isEventAnim = (events, anim) => events ? Object.values(events).some((pool) => poolIncludes(pool, anim)) : false;
  var nextWorkStatusAnim = (pool, current) => {
    const idx = pool.findIndex((slot2) => slotIncludes(slot2, current));
    if (idx === -1) return null;
    const slot = pool[idx];
    if (!Array.isArray(slot) || slot.length <= 1) return null;
    return pickSlot(slot, current);
  };
  var randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
  var pickWeightedCategory = (categories, facing) => {
    const cats = categories.filter((c) => c.actions.length > 0);
    if (!cats.length) return null;
    const filtered = cats.filter((c) => !(c.noMirror && facing === "right"));
    const eligible = filtered.length ? filtered : cats;
    const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
    let t = Math.random() * totalW;
    for (const c of eligible) {
      t -= c.weight;
      if (t <= 0) return c;
    }
    return eligible[eligible.length - 1];
  };
  var rollKind = (roll, w) => {
    const topEnd = (w.idle + w.turn + w.move) / 100;
    if (roll < w.idle / 100) return "idle";
    if (roll < (w.idle + w.turn) / 100) return "turn";
    if (roll < topEnd) return "move";
    return "action";
  };
  var pickCategoryAction = (categories, idlePool, facing, current) => {
    const cat = pickWeightedCategory(categories, facing);
    if (!cat) return { id: "FALLBACK", name: pick(idlePool, current) };
    return { id: cat.id, name: pick(cat.actions, current) };
  };

  // src/shared/displays.ts
  var rectRight = (r) => r.x + r.width;
  var rectBottom = (r) => r.y + r.height;
  var boundingRect = (rects) => {
    if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, rectRight(r));
      y1 = Math.max(y1, rectBottom(r));
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  var pointInRect = (r, x, y) => x >= r.x && x < rectRight(r) && y >= r.y && y < rectBottom(r);
  var rectAtPoint = (rects, x, y) => {
    for (const r of rects) if (pointInRect(r, x, y)) return r;
    return null;
  };
  var indexAtPoint = (rects, x, y) => {
    for (let i = 0; i < rects.length; i++) if (pointInRect(rects[i], x, y)) return i;
    return -1;
  };
  var distToRectSq = (r, x, y) => {
    const dx = Math.max(r.x - x, 0, x - rectRight(r));
    const dy = Math.max(r.y - y, 0, y - rectBottom(r));
    return dx * dx + dy * dy;
  };
  var nearestIndex = (rects, x, y) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const d = distToRectSq(rects[i], x, y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  var resolveRect = (rects, x, y) => {
    const hit = rectAtPoint(rects, x, y);
    if (hit) return hit;
    const i = nearestIndex(rects, x, y);
    return i < 0 ? null : rects[i];
  };
  var clampPointInRect = (r, x, y) => ({
    x: Math.min(Math.max(x, r.x), rectRight(r) - 1),
    y: Math.min(Math.max(y, r.y), rectBottom(r) - 1)
  });
  var clampPointToRegion = (rects, x, y) => {
    if (rectAtPoint(rects, x, y)) return { x, y };
    const i = nearestIndex(rects, x, y);
    return i < 0 ? { x, y } : clampPointInRect(rects[i], x, y);
  };
  var regionArea = (rects) => rects.reduce((s, r) => s + r.width * r.height, 0);
  var regionHoleRatio = (rects) => {
    const hull = boundingRect(rects);
    const hullArea = hull.width * hull.height;
    if (hullArea <= 0) return 0;
    return Math.max(0, 1 - regionArea(rects) / hullArea);
  };
  var translateRects = (rects, dx, dy) => rects.map((r) => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }));

  // src/shared/motion.ts
  var planMove = (o) => {
    const side = o.sideAllow ?? 0;
    const distance = randomBetween(o.minDist, o.maxDist);
    const target = o.cx + o.dir * distance;
    if (o.areas && o.areas.length > 0) {
      const bodyHalf = o.halfW - side;
      if (!rectAtPoint(o.areas, target - bodyHalf - o.margin, o.cy)) return null;
      if (!rectAtPoint(o.areas, target + bodyHalf + o.margin, o.cy)) return null;
    } else {
      const leftBound = o.margin + o.halfW - side;
      const rightBound = o.W - o.margin - o.halfW + side;
      if (target < leftBound || target > rightBound) return null;
    }
    return {
      startRatio: o.cx / o.W,
      startYRatio: o.cy / o.H,
      targetRatio: target / o.W,
      totalRatio: Math.abs(target - o.cx) / o.W
    };
  };
  var anchorPixel = (o) => {
    const height = o.size * 9 / 16;
    const a = o.area ?? { x: 0, y: 0, width: o.W, height: o.H };
    const left = a.x + o.marginX;
    const top = a.y + o.marginY;
    const right = a.x + a.width - o.size - o.marginX;
    const bottom = a.y + a.height - height - o.marginY;
    switch (o.corner) {
      case "top-left":
        return { x: left, y: top };
      case "top-right":
        return { x: right, y: top };
      case "bottom-left":
        return { x: left, y: bottom };
      case "bottom-right":
        return { x: right, y: bottom };
    }
  };

  // src/shared/config.ts
  var PET_DISPLAYS = ["web", "desktop", "both", "none"];
  var isWebVisible = (display) => display === "web" || display === "both";
  var isDesktopVisible = (display) => display === "desktop" || display === "both";
  var DEFAULT_CHARACTER = "maid";
  function characterProfileOf(conf, character) {
    const id = typeof character === "string" && character ? character : DEFAULT_CHARACTER;
    if (id === DEFAULT_CHARACTER) return null;
    const table = conf?.characters;
    if (!table || typeof table !== "object") return null;
    const profile = table[id];
    return profile && typeof profile === "object" ? profile : null;
  }
  function flattenConfigPets(merged) {
    const out = [];
    for (const [entry, conf] of Object.entries(merged)) {
      const list = Array.isArray(conf?.pets) ? conf.pets : [];
      for (const p of list) {
        const profile = characterProfileOf(conf, p.character);
        out.push({
          ...p,
          animations: profile?.animations ?? conf.animations,
          animationWeights: profile?.animationWeights ?? conf.animationWeights,
          eventsRefreshSec: profile?.eventsRefreshSec ?? conf.eventsRefreshSec,
          physics: conf.physics,
          workStatusTexts: profile?.workStatusTexts ?? conf.workStatusTexts,
          characterSheet: profile?.sheet,
          assetRoot: entry,
          extra: entry !== "main"
        });
      }
    }
    return out;
  }

  // src/shared/menu.ts
  var EVENT_LABELS = {
    balance: "\u4F59\u989D\u52A8\u4F5C\uFF08\u539F\u7248\u4F59\u989D\u8054\u52A8\u672A\u79FB\u690D\uFF0C\u4EC5\u53EF\u70B9\u64AD\uFF09",
    whisper: "\u788E\u788E\u5FF5",
    workStatus: "\u5DE5\u4F5C\u72B6\u6001"
  };
  var leaf = (anim) => ({ label: anim, anim });
  function buildMenuTree(animations) {
    const groups = [];
    const pools = [
      ["\u5F85\u673A", animations.idle],
      ["\u8F6C\u5411", animations.turn],
      ["\u62D6\u62FD", animations.drag],
      ["\u70B9\u51FB\u56DE\u5E94", animations.clicks],
      ["\u79FB\u52A8", animations.moves.actions.map((m) => m.name)]
    ];
    for (const [label, pool] of pools) {
      if (pool.length) groups.push({ label, children: pool.map(leaf) });
    }
    const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
    for (const c of cats) {
      groups.push({ label: c.id, children: c.actions.map(leaf) });
    }
    const events = animations.events ?? {};
    for (const key of Object.keys(events)) {
      const pool = events[key] ?? [];
      const names = [];
      for (const slot of pool) {
        if (typeof slot === "string") names.push(slot);
        else names.push(...slot);
      }
      if (names.length) groups.push({ label: EVENT_LABELS[key] ?? key, children: names.map(leaf) });
    }
    if (!groups.length) return [];
    return [{ label: "\u52A8\u4F5C", children: groups }];
  }
  function isNoMirrorAnimation(categories, anim) {
    return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
  }
  var MENU_CSS = [
    ".dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;",
    "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
    ".dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}",
    ".dsh-pet-menu-column{position:absolute;min-width:150px;max-width:240px;padding:4px;",
    "background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;",
    "box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;",
    // 自定义滚动条：细圆角半透明条（Chromium 系 Chrome/Edge/Electron 走 ::-webkit-scrollbar；
    // Firefox 走 scrollbar-width/scrollbar-color）。thumb 用 border+background-clip 内缩 2px 留白，
    // 与菜单的圆角白底协调；hover 加深并与 item:hover 的蓝呼应。track 透明不抢视觉。
    "scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}",
    ".dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}",
    ".dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}",
    ".dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;",
    "border:2px solid transparent;background-clip:content-box}",
    ".dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);",
    "border:2px solid transparent;background-clip:content-box}",
    ".dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}",
    ".dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;",
    "gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}",
    ".dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}",
    ".dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}",
    ".dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}"
  ].join("");
  function isBranchNode(n) {
    return "children" in n && Array.isArray(n.children);
  }
  function mountContextMenu(opts) {
    const { tree, x, y, onAction, onClose, clamp } = opts;
    const c = clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h) ? clamp : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const root = document.createElement("div");
    root.className = "dsh-pet-menu";
    root.style.left = "0px";
    root.style.top = "0px";
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    let closed = false;
    const openChild = /* @__PURE__ */ new Map();
    let leaveTimer = null;
    const hideChain = (panel) => {
      panel.style.display = "none";
      const child = openChild.get(panel);
      if (child) {
        openChild.delete(panel);
        hideChain(child);
      }
    };
    const showPanel = (panel, item) => {
      const rect = item.getBoundingClientRect();
      panel.style.left = "";
      panel.style.top = "";
      panel.style.display = "block";
      let left = rect.right + 4;
      if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4;
      left = Math.max(c.x + 4, left);
      let top = rect.top;
      if (top + panel.offsetHeight > c.y + c.h - 4) top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    };
    const buildPanel = (nodes) => {
      const panel = document.createElement("div");
      panel.className = "dsh-pet-menu-column";
      panel.style.display = "none";
      if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + "px";
      root.appendChild(panel);
      for (const node of nodes) {
        const item = document.createElement("div");
        item.className = "dsh-pet-menu-item";
        if (isBranchNode(node)) {
          item.classList.add("dsh-pet-menu-branch");
          const label = document.createElement("span");
          label.textContent = node.label;
          const arrow = document.createElement("span");
          arrow.className = "dsh-pet-menu-arrow";
          arrow.textContent = "\u25B8";
          item.appendChild(label);
          item.appendChild(arrow);
          const childPanel = buildPanel(node.children);
          item.addEventListener("mouseenter", () => {
            const prev = openChild.get(panel);
            if (prev && prev !== childPanel) hideChain(prev);
            openChild.set(panel, childPanel);
            showPanel(childPanel, item);
          });
        } else {
          const label = document.createElement("span");
          label.textContent = node.label;
          item.appendChild(label);
          item.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            close();
            onAction(node);
          });
        }
        panel.appendChild(item);
      }
      return panel;
    };
    const rootPanel = buildPanel(tree);
    rootPanel.style.display = "block";
    document.body.appendChild(root);
    rootPanel.style.left = "";
    rootPanel.style.top = "";
    const rw = rootPanel.offsetWidth;
    const rh = rootPanel.offsetHeight;
    rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + "px";
    rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + "px";
    root.addEventListener("mouseleave", () => {
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        leaveTimer = null;
        close();
      }, 200);
    });
    root.addEventListener("mouseover", () => {
      if (leaveTimer !== null) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    });
    const onDocPointerDown = (e) => {
      if (closed) return;
      if (root.contains(e.target)) return;
      close();
    };
    const onDocKeyDown = (e) => {
      if (closed) return;
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    const close = () => {
      if (closed) return;
      closed = true;
      if (leaveTimer !== null) window.clearTimeout(leaveTimer);
      leaveTimer = null;
      document.removeEventListener("mousedown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown, true);
      root.remove();
      if (onClose) onClose();
    };
    return { el: root, close };
  }

  // src/shared/physics.ts
  var SPRING_K = 200;
  var SPRING_C = 30;
  var TRAIL_KEEP_MS = 200;
  var RELEASE_WINDOW_MS = 150;
  var RELEASE_STALE_MS = 150;
  var MIN_SPAN_MS = 20;
  var SEG_MIN_DT_MS = 8;
  var DEAD_ZONE_SPEED = 500;
  var MAX_THROW_SPEED = 3600;
  var PEAK_WEIGHT = 0.5;
  var ACCEL_REF = 8e3;
  var ACCEL_GAIN_MAX = 0.6;
  var GRAVITY = 1400;
  var RESTITUTION = 0.78;
  var GROUND_FRICTION = 2.5;
  var DEFAULT_PHYSICS = {
    gravity: GRAVITY,
    restitution: RESTITUTION,
    groundFriction: GROUND_FRICTION,
    ceilingBounce: true,
    throwPower: 1,
    petCollision: false
  };
  var DEFAULT_THROW_POWER = 1;
  var REST_VY = 40;
  var REST_VX = 15;
  var MAX_STEP_DT = 0.05;
  var SQ_SQUASH = 0.55;
  var SQ_DURATION_MS = 220;
  var SQ_SOFT_SPEED = 300;
  var SQ_HARD_SPEED = 1500;
  var SQ_MAX_SQUASH = 0.55;
  var landingSquash = (impactSpeed) => {
    const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
    return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH));
  };
  var squashScale = (u, squash = SQ_SQUASH) => {
    if (u < 0.45) {
      const p2 = u / 0.45;
      return 1 - (1 - squash) * p2 * p2;
    }
    const p = (u - 0.45) / 0.55;
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
  };
  var throwBounds = (o) => {
    const h = o.size * 9 / 16;
    return { minX: -o.sideAllow, minY: 0, maxX: o.W - o.size + o.sideAllow, maxY: o.H - h };
  };
  var throwBoundsIn = (area, size, sideAllow) => {
    const h = size * 9 / 16;
    return {
      minX: area.x - sideAllow,
      minY: area.y,
      maxX: rectRight(area) - size + sideAllow,
      maxY: rectBottom(area) - h
    };
  };
  var throwSpace = (o) => ({
    bounds: o.areas.map((a) => throwBoundsIn(a, o.size, o.sideAllow)),
    areas: o.areas,
    panels: o.panels && o.panels.length === o.areas.length ? o.panels : o.areas,
    // 面板缺失/不同序：退化用工作区（保持旧行为）
    size: o.size,
    sideAllow: o.sideAllow
  });
  var screenOfBox = (space, x, y) => {
    const cx = x + space.size / 2;
    const cy = y + space.size * 9 / 16 / 2;
    const hit = indexAtPoint(space.areas, cx, cy);
    return hit >= 0 ? hit : nearestIndex(space.areas, cx, cy);
  };
  var trimTrail = (trail, now) => {
    const cutoff = now - TRAIL_KEEP_MS;
    let i = 0;
    while (i < trail.length && trail[i].t < cutoff) i++;
    return i === 0 ? trail : trail.slice(i);
  };
  var springStep = (v, x, target, dt, power = DEFAULT_THROW_POWER) => v + ((target - x) * SPRING_K - v * SPRING_C) * power * dt;
  var softClampSpeed = (speed) => {
    if (speed <= 0) return 0;
    return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
  };
  var estimateReleaseVelocity = (trail, now, physics = DEFAULT_PHYSICS) => {
    if (trail.length === 0) return null;
    const last = trail[trail.length - 1];
    if (now - last.t > RELEASE_STALE_MS) return null;
    const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
    if (win.length < 2) return null;
    const t0 = win[0].t;
    const x0 = win[0].x;
    const y0 = win[0].y;
    const t1 = win[win.length - 1].t;
    const x1 = win[win.length - 1].x;
    const y1 = win[win.length - 1].y;
    const spanMs = t1 - t0;
    if (spanMs < MIN_SPAN_MS) return null;
    const baseVx = (x1 - x0) / spanMs * 1e3;
    const baseVy = (y1 - y0) / spanMs * 1e3;
    const baseSpeed = Math.hypot(baseVx, baseVy);
    if (baseSpeed < 1e-6) return null;
    const segSpeeds = [];
    let px = x0;
    let py = y0;
    let pt = t0;
    for (const s of win.slice(1)) {
      const dt = s.t - pt;
      if (dt >= SEG_MIN_DT_MS) {
        segSpeeds.push({ speed: Math.hypot(s.x - px, s.y - py) / dt * 1e3, tEnd: s.t });
        px = s.x;
        py = s.y;
        pt = s.t;
      }
    }
    const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
    let accel = 0;
    if (segSpeeds.length >= 2) {
      const lastSeg = segSpeeds[segSpeeds.length - 1];
      const firstSeg = segSpeeds[0];
      accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1e3, MIN_SPAN_MS / 1e3);
    }
    const speedBeforeClamp = ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) * (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
    const speed = softClampSpeed(speedBeforeClamp) * physics.throwPower;
    if (speed < DEAD_ZONE_SPEED) return null;
    return { vx: baseVx / baseSpeed * speed, vy: baseVy / baseSpeed * speed };
  };
  var throwStep = (s, dtRaw, b, physics = DEFAULT_PHYSICS) => {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
    let { x, y, vx, vy } = s;
    vy += physics.gravity * dt;
    x += vx * dt;
    y += vy * dt;
    let bounced = false;
    if (x < b.minX) {
      x = b.minX;
      vx = Math.abs(vx) * physics.restitution;
      bounced = true;
    } else if (x > b.maxX) {
      x = b.maxX;
      vx = -Math.abs(vx) * physics.restitution;
      bounced = true;
    }
    if (y < b.minY) {
      if (physics.ceilingBounce) {
        y = b.minY;
        vy = Math.abs(vy) * physics.restitution;
        bounced = true;
      }
    } else if (y >= b.maxY) {
      y = b.maxY;
      vx *= Math.max(0, 1 - physics.groundFriction * dt);
      if (Math.abs(vy) < REST_VY) vy = 0;
      else vy = -Math.abs(vy) * physics.restitution;
      bounced = true;
    }
    const speed = Math.hypot(vx, vy);
    const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
    return { x, y, vx, vy, bounced, atRest };
  };
  var throwStepRegion = (s, dtRaw, space, physics = DEFAULT_PHYSICS) => {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
    let { x, y, vx, vy } = s;
    vy += physics.gravity * dt;
    x += vx * dt;
    y += vy * dt;
    if (space.areas.length === 0) return { x, y, vx, vy, screen: -1, bounced: false, atRest: false };
    const h = space.size * 9 / 16;
    let bounced = false;
    let cur = screenOfBox(space, x, y);
    let b = space.bounds[cur];
    let a = space.areas[cur];
    const pa = space.panels[cur] || a;
    const cy = y + h / 2;
    if (x < b.minX) {
      if (indexAtPoint(space.panels, pa.x - 1, cy) < 0) {
        x = b.minX;
        vx = Math.abs(vx) * physics.restitution;
        bounced = true;
      }
    } else if (x > b.maxX) {
      if (indexAtPoint(space.panels, rectRight(pa), cy) < 0) {
        x = b.maxX;
        vx = -Math.abs(vx) * physics.restitution;
        bounced = true;
      }
    }
    cur = screenOfBox(space, x, y);
    b = space.bounds[cur];
    a = space.areas[cur];
    const pa2 = space.panels[cur] || a;
    const cx = x + space.size / 2;
    if (y < b.minY) {
      if (physics.ceilingBounce && indexAtPoint(space.panels, cx, pa2.y - 1) < 0) {
        y = b.minY;
        vy = Math.abs(vy) * physics.restitution;
        bounced = true;
      }
    } else if (y >= b.maxY) {
      if (indexAtPoint(space.panels, cx, rectBottom(pa2)) < 0) {
        y = b.maxY;
        vx *= Math.max(0, 1 - physics.groundFriction * dt);
        if (Math.abs(vy) < REST_VY) vy = 0;
        else vy = -Math.abs(vy) * physics.restitution;
        bounced = true;
      }
    }
    cur = screenOfBox(space, x, y);
    b = space.bounds[cur];
    const speed = Math.hypot(vx, vy);
    const atRest = y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX || bounced && speed < REST_VY && Math.abs(vy) < 1;
    return { x, y, vx, vy, screen: cur, bounced, atRest };
  };
  var PET_BOUNCE_E = 0.995;
  var bodyPixelBox = (o) => {
    const h = o.size * 9 / 16;
    return {
      left: o.x + HIT_BOX.x0 / 640 * o.size,
      top: o.y + o.bottomPad + HIT_BOX.y0 / 360 * h,
      right: o.x + HIT_BOX.x1 / 640 * o.size,
      bottom: o.y + o.bottomPad + HIT_BOX.y1 / 360 * h
    };
  };
  var rectsOverlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  var collidePet = (fly, hit) => {
    const hf = fly.size * 9 / 16 / 2;
    const hh = hit.size * 9 / 16 / 2;
    const cx = hit.x + hit.size / 2 - (fly.x + fly.size / 2);
    const cy = hit.y + hh - (fly.y + hf);
    const dist = Math.hypot(cx, cy);
    if (dist < 1e-6) return null;
    const nx = cx / dist;
    const ny = cy / dist;
    const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
    if (vrel <= 0) return null;
    const e = PET_BOUNCE_E;
    const m1 = fly.size * fly.size;
    const m2 = hit.size * hit.size;
    const v1n = fly.vx * nx + fly.vy * ny;
    const v2n = hit.vx * nx + hit.vy * ny;
    const v1n2 = ((m1 - e * m2) * v1n + (1 + e) * m2 * v2n) / (m1 + m2);
    const v2n2 = ((m2 - e * m1) * v2n + (1 + e) * m1 * v1n) / (m1 + m2);
    return {
      fvx: fly.vx - v1n * nx + v1n2 * nx,
      fvy: fly.vy - v1n * ny + v1n2 * ny,
      hvx: hit.vx - v2n * nx + v2n2 * nx,
      hvy: hit.vy - v2n * ny + v2n2 * ny
    };
  };

  // src/shared/score.ts
  var SCORE_MIN_SPEED = 400;
  var SCORE_SPEED_PER_POINT = 100;
  var clickScore = (speed, size) => {
    if (speed <= 0 || size <= 0) return 0;
    return Math.max(1, Math.round(speed / SCORE_SPEED_PER_POINT * (PET_REF_WIDTH / size)));
  };

  // src/shared/score-popup.ts
  var SCORE_POPUP_DURATION_MS = 2200;
  var SCORE_POPUP_CSS = [
    // 积分卡片：金色主值 + 灰色明细，居中，弹出动画
    ".dsh-pet-score{position:fixed;z-index:2147483002;min-width:120px;text-align:center;",
    "background:rgba(255,255,255,.97);border:1px solid rgba(255,179,0,.35);border-radius:12px;",
    "box-shadow:0 10px 32px rgba(0,0,0,.22);padding:8px 16px 9px;user-select:none;pointer-events:auto;",
    "font-family:'ShangshouSoftCandy','Yuanti SC','YouYuan','\u5E7C\u5706','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif;}",
    ".dsh-pet-score.is-in{animation:dshPetScorePop .28s ease}",
    ".dsh-pet-score-val{font-size:22px;line-height:1.25;font-weight:700;color:#ff8f00;font-variant-numeric:tabular-nums}",
    ".dsh-pet-score-sub{font-size:11px;line-height:1.4;color:rgba(43,43,43,.6);margin-top:2px;white-space:nowrap}",
    // 粒子层：整屏固定、不挡交互；粒子为绝对定位小圆点，位移/透明度由 rAF 直接写
    ".dsh-pet-score-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483002}",
    ".dsh-pet-score-particle{position:absolute;border-radius:50%;pointer-events:none}",
    "@keyframes dshPetScorePop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}"
  ].join("");
  var scoreCssInjected = false;
  function injectScoreCss() {
    if (scoreCssInjected || typeof document === "undefined") return;
    scoreCssInjected = true;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-pet";
    tag.dataset.pluginCss = "dsh-pet/score";
    tag.textContent = SCORE_POPUP_CSS;
    document.head.appendChild(tag);
  }
  var BURST_COUNT = 20;
  var BURST_SPEED_MIN = 120;
  var BURST_SPEED_MAX = 460;
  var BURST_GRAVITY = 700;
  var BURST_LIFE_MIN = 500;
  var BURST_LIFE_MAX = 900;
  var BURST_RADIUS_MIN = 3;
  var BURST_RADIUS_MAX = 7;
  var BURST_COLORS = ["#ffb300", "#ff8f00", "#ff7043", "#f4511e", "#ffc400", "#ffd54f", "#ef5350"];
  function spawnScoreBurst(x, y) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    injectScoreCss();
    const root = document.createElement("div");
    root.className = "dsh-pet-score-burst";
    document.body.appendChild(root);
    const parts = [];
    for (let i = 0; i < BURST_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
      const r = BURST_RADIUS_MIN + Math.random() * (BURST_RADIUS_MAX - BURST_RADIUS_MIN);
      const el = document.createElement("div");
      el.className = "dsh-pet-score-particle";
      el.style.left = x + "px";
      el.style.top = y + "px";
      el.style.width = r * 2 + "px";
      el.style.height = r * 2 + "px";
      el.style.background = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
      root.appendChild(el);
      parts.push({
        el,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        t0: performance.now(),
        life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN)
      });
    }
    const step = () => {
      const now = performance.now();
      let alive = false;
      for (const p of parts) {
        const tSec = (now - p.t0) / 1e3;
        const lifeRatio = (now - p.t0) / p.life;
        if (lifeRatio >= 1) continue;
        alive = true;
        p.el.style.transform = "translate(" + p.vx * tSec + "px," + (p.vy * tSec + 0.5 * BURST_GRAVITY * tSec * tSec) + "px)";
        p.el.style.opacity = String(Math.max(0, 1 - lifeRatio));
      }
      if (alive) requestAnimationFrame(step);
      else root.remove();
    };
    requestAnimationFrame(step);
  }
  function mountScorePopup(opts) {
    injectScoreCss();
    const x = opts.x;
    const y = opts.y;
    const root = document.createElement("div");
    root.className = "dsh-pet-score";
    const val = document.createElement("div");
    val.className = "dsh-pet-score-val";
    val.textContent = "+" + opts.score;
    const sub = document.createElement("div");
    sub.className = "dsh-pet-score-sub";
    sub.textContent = "\u901F\u5EA6 " + Math.round(opts.speed) + " \xB7 \u5927\u5C0F " + Math.round(opts.size);
    root.appendChild(val);
    root.appendChild(sub);
    document.body.appendChild(root);
    const rr = root.getBoundingClientRect();
    root.style.left = Math.max(4, Math.min(x - rr.width / 2, window.innerWidth - rr.width - 4)) + "px";
    root.style.top = Math.max(4, y - rr.height - 14) + "px";
    void root.offsetWidth;
    root.classList.add("is-in");
    let closed = false;
    let timer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      document.removeEventListener("mousedown", onDocPointerDown, true);
      document.removeEventListener("keydown", onDocKeyDown, true);
      root.remove();
      if (opts.onClose) opts.onClose();
    };
    const mountedAt = performance.now();
    let graceConsumed = false;
    const onDocPointerDown = (e) => {
      if (closed) return;
      if (!graceConsumed) {
        graceConsumed = true;
        if (e.timeStamp - mountedAt < 300) return;
      }
      if (root.contains(e.target)) return;
      close();
    };
    const onDocKeyDown = (e) => {
      if (closed) return;
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    timer = window.setTimeout(close, SCORE_POPUP_DURATION_MS);
    return { el: root, close };
  }

  // src/shared/work-status.ts
  var WORK_STATUS_STATES = ["thinking", "working", "result", "waiting", "success", "error"];
  var WORK_STATUS_INDEX = {
    thinking: 0,
    // turn/start → 思考
    working: 1,
    // tool/call → 工作
    result: 2,
    // tool/result → 整理
    waiting: 3,
    // approval/asked → 等待
    success: 4,
    // turn/end completed → 完成
    error: 5
    // turn/end error/max-tokens → 出错
  };
  function normalizeWorkStatus(raw) {
    const value = raw && typeof raw === "object" ? raw : {};
    const state = value.state;
    return {
      state: typeof state === "string" && WORK_STATUS_STATES.includes(state) ? state : null,
      task: typeof value.task === "string" && value.task ? value.task : null,
      ts: Number(value.ts) || 0
    };
  }
  return __toCommonJS(index_exports);
})();
