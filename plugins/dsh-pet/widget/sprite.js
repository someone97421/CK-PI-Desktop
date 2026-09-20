/**
 * dsh-pet 桌宠（这是一个助手插件）—— 宠物本体（PetSprite 类）。
 *
 * 移植自上游 runtime/electron-helper/sprite.js（MIT，见 ../README.md）：
 * 双缓冲透明 webm 播放 / 拖拽甩抛 / 跨窗碰撞 / 点击穿透 / 右键菜单 / 气泡渲染，
 * 行为曲线与常量全部来自 src/shared（shared-core.js，与上游同一份源码）。
 *
 * 与上游的差别（只有交互通道，没有任何行为差异）：
 *   - 窗口跟随：`window.petBridge.setBounds(...)` → 宿主 widget `setBounds`（DIP，带天然去重）；
 *   - 点击穿透：`petBridge.setInteractive(busy)` → 本文件只记 busy 标记，
 *     真实翻转由 constants.js 的轮询按 decideWindowIgnore 统一出口执行（同上游的兜底通道语义）；
 *   - 跨窗碰撞：上游由主进程 broker 推送 others/被撞事件；这里由 events.js 的 sync 轮询
 *     把 others 填进 this.others、把被撞动量喂给 onDeskHit（滞后 ≤ 一个轮询周期）；
 *   - 余额动作 / 对话弹窗：上游依赖 DSH 服务商接口与会话对话 API，未移植（见 README 移植矩阵）。
 */
'use strict';

class PetSprite {
  constructor(pet) {
    this.pet = pet; // 这只宠物的配置段（拍平后的成品实例，条目级字段已吹入：动画池/权重/周期）
    this.size = pet.size;
    this.height = (this.size * 9) / 16;
    this.halfW = this.size / 2;
    this.halfH = this.height / 2;
    this.bottomPad = (this.size * (9 / 16) * (S.CANVAS_H - S.FEET_Y)) / S.CANVAS_H;
    // 窗口高 = 舞台高 + 脚底垫高（stage 被 translateY(bottomPad) 下移的余量）
    this.winH = this.height + this.bottomPad;
    // 角色：maid（默认）= assets/webm 的透明 webm 双缓冲；图集角色（Codex v2）= canvas 逐帧，
    // 行规格在 widget/atlas.js，动作池在 assets/config.jsonc 的 characters.<id>。
    this.characterId = typeof pet.character === 'string' && pet.character ? pet.character : 'maid';
    this.atlas = null;
    if (this.characterId !== 'maid') {
      const spec = petAtlasSpec(this.characterId);
      const sheet = typeof pet.characterSheet === 'string' ? pet.characterSheet : '';
      if (!spec) {
        showError('角色 ' + this.characterId + ' 没有对应的图集实现（widget/atlas.js）');
      } else if (!sheet) {
        showError('角色 ' + this.characterId + ' 缺少图集文件配置（assets/config.jsonc 的 characters 段）');
      } else {
        this.atlas = new PetAtlasRenderer(spec, this, '../assets/' + sheet);
      }
    }
    // 身体命中区（sprite 坐标）：视频角色 = 640×360 舞台坐标的 HIT_BOX；
    // 图集角色 = 素材非透明像素的并集包围盒（等比换算到舞台）
    this.hitRect = this.atlas
      ? this.atlas.hitRect()
      : {
          x: (S.HIT_BOX.x0 / 640) * this.size,
          y: this.bottomPad + (S.HIT_BOX.y0 / 360) * this.height,
          w: ((S.HIT_BOX.x1 - S.HIT_BOX.x0) / 640) * this.size,
          h: ((S.HIT_BOX.y1 - S.HIT_BOX.y0) / 360) * this.height,
        };
    window.__dshPetDebug.hitRect = this.hitRect;
    window.__dshPetDebug.character = this.characterId;
    // 左右透明边余量：边界按「身体」贴边（宠物能走到屏幕边缘，但身体永不越界）。
    // hitRect.x = 身体左缘到 sprite 左缘的距离，正是「身体贴边」需要的位移量
    // （视频角色的 hitRect.x 就是原来的 HIT_BOX.x0/640×size，图集角色按素材包围盒自动变窄）。
    this.sideAllow = this.hitRect.x;
    // 窗口四周外扩（= 0.5 × 宠物尺寸）：气泡与自绘菜单显示在余量里；余量透明且点击穿透
    const m = this.size * 0.5;
    this.margin = { t: m, r: m, b: m, l: m };
    window.__dshPetDebug.winMargin = this.margin;
    /** 宠物包围盒左上角在【视口】坐标系里的位置 */
    this.pos = { x: 0, y: 0 };

    this.animations = pet.animations || (config && config.animations);
    this.weights = pet.animationWeights || (config && config.animationWeights);
    this.physics = pet.physics || (config && config.physics) || S.DEFAULT_PHYSICS;
    /** 素材根：插件包内 assets/webm/（file:// 相对路径，中文名按 URL 编码） */
    this.assetBase = '../assets/webm/';
    this.front = 0; // 0 = A, 1 = B
    this.pending = null;
    this.gen = 0;
    this.anim = this.animations.idle[0] ?? '';
    this.once = true;
    this.facing = 'left';

    this.dragState = { active: false, dragging: false, sx: 0, sy: 0, petX: 0, petY: 0 };
    this.justDragged = false;
    this._interactive = null;
    this._inputBusy = null;
    this.dragTrail = [];
    this.dragTarget = null;
    this.dragVel = { vx: 0, vy: 0 };
    this.dragFollow = null;
    this.dragFollowToken = 0;
    this.throwRef = null;
    this.throwToken = 0;
    this.space = null;
    this.squashRef = null;
    this.squashToken = 0;
    this.pendingSquash = false;
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    /** 拖拽/飞行后的会话内位置（中心比例）；goHome / restart 清空 */
    this.customPos = null;
    this.menuOpen = false;
    this.menuClose = null;
    this.bubbleOn = false;
    this.bubbleTimer = null;
    this.bubbleText = null;
    this.workOn = false;
    this.workTimer = null;
    this.workText = null;
    this.workState = null;
    this.prevWorkState = null;
    this.prevWorkTick = 0;
    /** 其它宠物的最新状态（跨窗碰撞用，由 sync 轮询填） */
    this.others = {};
    this.throwState = null;
    this.pressScoreFired = false;
    this.lastFlightReport = 0;

    // DOM：sprite 钉在窗口内 (margin.l, margin.t)；窗口随余量外扩
    this.el = document.createElement('div');
    this.el.className = 'pet-sprite';
    this.el.style.left = this.margin.l + 'px';
    this.el.style.top = this.margin.t + 'px';
    this.el.style.setProperty('--pet-size', this.size + 'px');
    const stage = document.createElement('div');
    stage.className = 'pet-stage';
    stage.style.transform = 'translateY(' + this.bottomPad + 'px)';
    this.stage = stage;
    this.videoA = null;
    this.videoB = null;
    if (!this.atlas) {
      this.videoA = document.createElement('video');
      this.videoA.className = 'pet-video is-front';
      this.videoB = document.createElement('video');
      this.videoB.className = 'pet-video';
      for (const v of [this.videoA, this.videoB]) {
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        v.title = this.pet.name;
      }
    }
    this.hit = document.createElement('div');
    this.hit.className = 'pet-hit';
    // 命中区样式：命中矩形在 sprite 坐标（含 bottomPad 位移），减掉它才是舞台内坐标
    this.hit.style.left = (this.hitRect.x / this.size) * 100 + '%';
    this.hit.style.top = ((this.hitRect.y - this.bottomPad) / this.height) * 100 + '%';
    this.hit.style.width = (this.hitRect.w / this.size) * 100 + '%';
    this.hit.style.height = (this.hitRect.h / this.height) * 100 + '%';
    this.hit.title = this.pet.name;
    this.bubble = document.createElement('div');
    this.bubble.className = 'pet-bubble';

    if (this.atlas) {
      stage.appendChild(this.atlas.el);
    } else {
      stage.appendChild(this.videoA);
      stage.appendChild(this.videoB);
    }
    stage.appendChild(this.hit);
    // 宿主点击穿透轮询按这份比例算命中区（图集角色按自己的包围盒，视频角色 = 默认 HIT_BOX）
    setHitSpec(this.atlas ? this.atlas.hitSpec() : null);
    this.el.appendChild(this.bubble);
    this.el.appendChild(stage);
    rootEl.appendChild(this.el);
    this.position();

    const ac = new AbortController();
    this.ac = ac;
    this.hit.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal: ac.signal });
    this.hit.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal: ac.signal });
    this.hit.addEventListener('click', () => this.onClick(), { signal: ac.signal });
    this.hit.addEventListener('contextmenu', (e) => this.onContextMenu(e), { signal: ac.signal });
    window.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal: ac.signal });
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e), { signal: ac.signal });
    this.hit.addEventListener('lostpointercapture', (e) => this.onPointerUp(e), { signal: ac.signal });
    // 点击穿透：宿主默认整窗穿透时 mousemove 仍可能被转发进来（forward）；命中区外的
    // 翻转由 constants.js 的 60ms 兜底轮询完成，两条通道共享同一份状态。
    window.addEventListener('mousemove', (e) => this.onMouseMove(e), { signal: ac.signal });
    window.addEventListener(
      'mouseleave',
      () => {
        this.closeMenu();
      },
      { signal: ac.signal },
    );
  }

  dispose() {
    this.ac.abort();
    if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.closeMenu();
    this.stopThrow();
    this.stopDragFollow();
    this.stopSquash();
    this.stopMove();
    if (this.atlas) {
      this.atlas.dispose();
      this.atlas = null;
    }
    this.el.remove();
  }

  /**
   * 目标包围盒左上角（视口相对坐标）→ 移动窗口：窗口 = sprite + 四周外扩余量。
   * 宿主 setBounds 收 DIP 屏幕坐标，所以先加 VIEW.x/y，再按 1:1 送出（无页面缩放）。
   * 位置去重按上一次**请求**的值比较：宿主回读值可能被取整，拿回读值比会永远失效。
   */
  sendBounds(px, py) {
    this.pos = { x: Math.round(px), y: Math.round(py) };
    window.__dshPetDebug.dragPos = { x: this.pos.x, y: this.pos.y };
    const rect = {
      x: this.pos.x - this.margin.l + VIEW.x,
      y: this.pos.y - this.margin.t + VIEW.y,
      width: this.size + this.margin.l + this.margin.r,
      height: this.winH + this.margin.t + this.margin.b,
    };
    // 预览/降级模式（宿主没有 widget API，或页面被直接打开）：窗口不会动，
    // 改为在页面内平移 sprite —— 动画、拖拽、甩抛、漫游照跑，只是没有真实的透明小窗。
    if (!HAS_WIDGET_API) {
      this.el.style.left = rect.x + 'px';
      this.el.style.top = rect.y + 'px';
      window.__dshPetDebug.sent += 1;
      return;
    }
    const key = [rect.x, rect.y, rect.width, rect.height].join(',');
    if (this.lastBoundsKey === key) return;
    this.lastBoundsKey = key;
    window.__dshPetDebug.sent += 1;
    widgetInvoke('setBounds', rect).catch(() => {
      /* 窗口正在关闭：忽略 */
    });
  }

  /** 角落/边距 → 窗口位置；拖拽后按会话内位置（比例）还原（松手无边界夹取） */
  position() {
    const W = VIEW.w;
    const H = VIEW.h;
    let x;
    let y;
    if (this.customPos) {
      x = this.customPos.rx * W - this.halfW;
      y = this.customPos.ry * H - this.halfH;
    } else {
      // 角落取主屏工作区而不是外接矩形：不规则多屏下单屏角落才一定真实存在
      const anchor = S.anchorPixel({
        corner: this.pet.position.corner,
        marginX: this.pet.position.marginX,
        marginY: this.pet.position.marginY,
        size: this.size,
        W,
        H,
        area: PRIMARY_AREA || undefined,
      });
      x = anchor.x;
      y = anchor.y;
    }
    this.sendBounds(x, y);
  }

  /** 抛掷空间（逐屏 AABB）。AREAS/PANELS 变化时由 relayout() 置空重建 */
  throwSpaceOf() {
    if (!this.space || this.space.areas !== AREAS || this.space.panels !== PANELS) {
      this.space = S.throwSpace({ areas: AREAS, panels: PANELS, size: this.size, sideAllow: this.sideAllow });
    }
    return this.space;
  }

  /** 显示器几何变化后就地重挂：抛掷空间作废，并把宠物从可能变成空洞的位置拉回可见区 */
  relayout() {
    this.space = null;
    if (this.dragState.active || this.throwRef !== null) return;
    this.stopMove();
    const cx = this.pos.x + this.halfW;
    const cy = this.pos.y + this.halfH;
    const p = S.clampPointToRegion(AREAS, cx, cy);
    if (p.x !== cx || p.y !== cy) {
      this.customPos = { rx: p.x / VIEW.w, ry: p.y / VIEW.h };
    }
    this.position();
  }

  currentCenterX() {
    if (this.customPos) return this.customPos.rx * VIEW.w;
    return this.pos.x + this.halfW;
  }
  currentCenterY() {
    if (this.customPos) return this.customPos.ry * VIEW.h;
    return this.pos.y + this.halfH;
  }

  /** 当前前台的媒体元素：图集 = 画布，视频 = 前台缓冲（Q 弹/结束回调共用） */
  frontEl() {
    if (this.atlas) return this.atlas.el;
    return this.front === 0 ? this.videoA : this.videoB;
  }

  /** 镜像前缀（视频角色朝右时整段 art 翻转；图集角色方向由行自带，不镜像） */
  facingTransform() {
    return !this.atlas && this.facing === 'right' ? 'scaleX(-1)' : '';
  }

  /** 新动画切到前台后的收尾（视频双缓冲与图集共用同一入口）：
   *  清 pending、写镜像、消费 Q 弹标记、启动移动驱动。 */
  onAnimFront(gen, el, player) {
    if (!this.pending || this.pending.gen !== gen) return;
    this.pending = null;
    if (!this.atlas && el) el.style.transform = this.facingTransform();
    if (this.pendingSquash) {
      this.pendingSquash = false;
      this.startSquash(el);
    }
    if (this.pendingMove) this.startMoveDrive(player);
  }

  /** 一次性动画结束（图集播放器回调；视频走视频元素的 ended）：世代对不上就丢掉 */
  onAnimEnded(gen) {
    if (gen !== this.gen) return;
    this.handleEnded();
  }

  /** 切换动画：视频 = 双缓冲 decode 后切前台；图集 = 单画布同步切帧。
   *  两条路径最终都回调 onAnimFront，语义（once/loop、Q 弹、移动驱动）完全一致。 */
  switchTo(next, nextOnce) {
    if (!next) return;
    const pending = this.pending;
    if (pending && pending.anim === next && pending.once === nextOnce) {
      // 防重命中（单动画点击时目标=当前动画，不重播）：仍消费 Q 弹标记
      if (this.pendingSquash) {
        this.pendingSquash = false;
        this.startSquash(this.frontEl());
      }
      return;
    }
    const gen = ++this.gen;
    this.pending = { anim: next, once: nextOnce, gen };
    if (this.atlas) {
      this.atlas.play(next, nextOnce, gen);
      return;
    }
    const el = this.front === 0 ? this.videoB : this.videoA;
    if (!el) return;
    el.src = this.assetBase + encodeURIComponent(next) + (S.ANIMATION_EXT || '.webm');
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = nextOnce ? () => this.onAnimEnded(gen) : null;
    el.load();
    const onReady = () => {
      el.removeEventListener('loadeddata', onReady);
      if (this.pending && this.pending.gen !== gen) return;
      const old = this.front === 0 ? this.videoA : this.videoB;
      el.classList.add('is-front');
      if (old && old !== el) {
        old.classList.remove('is-front');
        old.onended = null;
        old.pause();
      }
      this.front = this.front === 0 ? 1 : 0;
      el.play().catch(() => {});
      this.onAnimFront(gen, el, el);
    };
    el.addEventListener('loadeddata', onReady);
    if (el.readyState >= 2) onReady();
  }

  playOnce(name) {
    this.anim = name;
    this.once = true;
    this.switchTo(name, true);
  }

  /** 动画链（与上游 pickNext 语义一致，纯逻辑在 shared） */
  playIdle() {
    this.stopMove();
    const animations = this.animations;
    const weights = this.weights;
    const roll = Math.random();
    const k = S.rollKind(roll, weights);
    let next;
    if (k === 'idle') {
      next = S.pick(animations.idle, this.anim);
    } else if (k === 'turn') {
      next = S.pick(animations.turn, this.anim);
    } else if (k === 'move') {
      if (!roamingEnabled) {
        next = S.pick(animations.idle, this.anim);
      } else {
        const moved = this.tryMove();
        if (moved === false) {
          next = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim).name;
        } else if (typeof moved === 'string') {
          next = moved;
        } else {
          // 已有一场移动进行中（占用）：重播当前动画，不另设
          this.playOnce(this.anim);
          return;
        }
      }
    } else {
      next = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim).name;
    }
    this.playOnce(next);
  }

  handleEnded() {
    if (this.dragState.active) return;
    const animations = this.animations;
    if (S.isEventAnim(animations.events, this.anim)) {
      // 工作状态多候选档位：播完一段自动轮换到下一候选（仅非终态档位）
      const nonTerminal = this.workState && this.workState !== 'success' && this.workState !== 'error';
      const nextWork = nonTerminal ? S.nextWorkStatusAnim((animations.events && animations.events.workStatus) || [], this.anim) : null;
      if (nextWork !== null) {
        this.playOnce(nextWork);
        return;
      }
      // 非 workStatus 事件动画播完：workStatus 仍非终态 → 立即恢复档位循环，不进随机链
      if (this.resumeWorkStatusAnim()) return;
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    // 朝向：图集角色的行动作自带朝向（播完回到该朝向）；视频角色按 turn 池翻转 facing
    const side = this.sideOf(this.anim);
    if (side) this.facing = side;
    else if (animations.turn.includes(this.anim)) this.facing = this.facing === 'left' ? 'right' : 'left';
    if (animations.drag.includes(this.anim) || animations.clicks.includes(this.anim)) {
      if (this.resumeWorkStatusAnim()) return;
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    this.playIdle();
  }

  /** 动作自带朝向（仅图集角色有：running-left/right 等行；视频角色一律返回 null） */
  sideOf(name) {
    return this.atlas && name ? this.atlas.sideOf(name) : null;
  }

  /** 互动/事件动画播完后恢复 workStatus 档位循环；终态/空闲返回 false 交回调用方 */
  resumeWorkStatusAnim() {
    const state = this.workState;
    if (!state || state === 'success' || state === 'error') return false;
    const pool = this.animations.events && this.animations.events.workStatus;
    if (!pool || pool.length === 0) return false;
    const slot = pool[S.WORK_STATUS_INDEX[state]];
    if (slot === undefined) return false;
    const name = S.pickSlot(slot, this.anim);
    if (Array.isArray(slot) && slot.length > 1) this.playOnce(name);
    else this.switchTo(name, false);
    return true;
  }

  // ---- 漫游（rAF 驱动，动画首尾各 leadSec/tailSec 秒原地不动；几何在 shared/planMove） ----
  tryMove(preferredName) {
    if (this.moveRef !== null || this.pendingMove || this.throwRef !== null) return true;
    const moves = this.animations.moves;
    const actions = moves.actions;
    if (!actions.length) return false;
    const chosen = preferredName
      ? actions.find((a) => a.name === preferredName) || null
      : actions[Math.floor(Math.random() * actions.length)];
    if (!chosen) return false;
    const mp = Object.assign({}, moves.default, chosen.params || {});
    // 朝向：图集角色的行进方向由「行自带朝向」决定（running-left/right），视频角色沿用 facing×turn 规则
    const side = this.sideOf(chosen.name);
    if (side) this.facing = side;
    const dir = side
      ? (side === 'right' ? 1 : -1)
      : (this.facing === 'right') !== this.animations.turn.includes(this.anim)
        ? 1
        : -1;
    const W = VIEW.w;
    const H = VIEW.h;
    const distScale = this.size / S.PET_REF_WIDTH;
    const plan = S.planMove({
      cx: this.currentCenterX(),
      cy: this.currentCenterY(),
      W,
      H,
      dir,
      minDist: mp.minDist * distScale,
      maxDist: mp.maxDist * distScale,
      margin: mp.margin,
      halfW: this.halfW,
      sideAllow: this.sideAllow,
      areas: AREAS,
    });
    if (!plan) return false;
    this.pendingMove = { ...plan, dir, leadSec: mp.leadSec, tailSec: mp.tailSec };
    this.anim = chosen.name;
    this.once = true;
    this.switchTo(chosen.name, true);
    return chosen.name;
  }

  /** 移动驱动：source 提供 duration/currentTime（视频元素，或图集播放器的同形播放器） */
  startMoveDrive(source) {
    const pm = this.pendingMove;
    if (!pm || this.moveRef !== null) return;
    this.pendingMove = null;
    const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
    const duration = Number.isFinite(source.duration) && source.duration > 0 ? source.duration : 10.09;
    const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
    const token = ++this.moveToken;
    const W = VIEW.w;
    const H = VIEW.h;
    const step = () => {
      if (this.moveToken !== token) return;
      const t = source.currentTime || 0;
      let ratioX;
      if (t <= leadSec) ratioX = startRatio;
      else if (t >= duration - tailSec) ratioX = targetRatio;
      else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
      // 移动的是窗口（宠物包围盒跟随），sprite 在本窗口内不动
      this.sendBounds(ratioX * W - this.halfW, startYRatio * H - this.halfH);
      if (t < duration - tailSec) {
        this.moveRef = requestAnimationFrame(step);
      } else {
        this.moveRef = null;
        this.customPos = { rx: targetRatio, ry: startYRatio };
      }
    };
    this.moveRef = requestAnimationFrame(step);
  }

  stopMove() {
    this.pendingMove = null;
    this.moveToken++;
    if (this.moveRef !== null) {
      cancelAnimationFrame(this.moveRef);
      this.moveRef = null;
    }
  }

  // ---- 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）----
  stopDragFollow() {
    this.dragFollowToken++;
    if (this.dragFollow !== null) {
      cancelAnimationFrame(this.dragFollow);
      this.dragFollow = null;
    }
    this.dragTarget = null;
    this.dragVel = { vx: 0, vy: 0 };
  }

  /** rAF 弹簧跟随：窗口朝拖拽目标过阻尼追赶（不再硬贴指针），抹平高频抖动 */
  startDragFollow() {
    if (this.dragFollow !== null) return;
    const token = ++this.dragFollowToken;
    let last = performance.now();
    const step = () => {
      if (this.dragFollowToken !== token) return;
      const target = this.dragTarget;
      if (!target) {
        this.dragFollow = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const vel = this.dragVel;
      let x = this.pos.x;
      let y = this.pos.y;
      vel.vx = S.springStep(vel.vx, x, target.x, dt, this.physics.throwPower);
      vel.vy = S.springStep(vel.vy, y, target.y, dt, this.physics.throwPower);
      x += vel.vx * dt;
      y += vel.vy * dt;
      this.sendBounds(x, y);
      this.dragFollow = requestAnimationFrame(step);
    };
    this.dragFollow = requestAnimationFrame(step);
  }

  stopThrow() {
    this.throwToken++;
    if (this.throwRef !== null) {
      cancelAnimationFrame(this.throwRef);
      this.throwRef = null;
    }
    this.throwState = null;
  }

  /** 抛掷驱动：重力 + 边缘反弹 + 落地摩擦，落定后写入 customPos */
  startThrow(px, py, vx, vy) {
    this.stopDragFollow();
    this.stopMove();
    const token = ++this.throwToken;
    let state = { x: px, y: py, vx, vy };
    let last = performance.now();
    let prevGrounded = false;
    const step = () => {
      if (this.throwToken !== token) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const fallingVy = state.vy;
      const sp = this.throwSpaceOf();
      const res = S.throwStepRegion(state, dt, sp, this.physics);
      state = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      this.throwState = state;
      this.flying = true;
      // 宠物间碰撞（仅 physics.petCollision 开启）：飞行中的自己撞到其它宠物 → 动量弹开
      if (this.physics && this.physics.petCollision) {
        // 自己的身体盒按本角色的命中区算（图集角色比 9:16 舞台窄）；对方按尺寸归一化命中区
        const myBody = this.bodyBoxAt(state.x, state.y);
        for (const pid of Object.keys(this.others)) {
          const o = this.others[pid];
          if (!o || !o.size) continue;
          const otherBody = S.bodyPixelBox({ x: o.x, y: o.y, size: o.size, bottomPad: o.bottomPad });
          if (!S.rectsOverlap(myBody, otherBody)) continue;
          const hit = S.collidePet(
            { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size: this.size },
            { x: o.x, y: o.y, vx: o.vx, vy: o.vy, size: o.size },
          );
          if (hit) {
            state.vx = hit.fvx;
            state.vy = hit.fvy;
            this.throwState = state;
            // 被撞方的初速交给插件主进程，由它在下一次 sync 里交给目标窗口
            panelInvoke('pet.hit', { targetId: pid, vx: hit.hvx, vy: hit.hvy }).catch(() => {});
            break; // 一帧只处理一次碰撞
          }
        }
      }
      this.sendBounds(res.x, res.y);
      const curBounds = sp.bounds[res.screen] || sp.bounds[0];
      const grounded = curBounds ? res.y >= curBounds.maxY - 1 : false;
      if (res.bounced && grounded && !prevGrounded) {
        this.startSquash(this.frontEl(), S.landingSquash(fallingVy));
      }
      prevGrounded = grounded;
      if (res.atRest) {
        this.throwRef = null;
        this.throwState = null;
        this.flying = false;
        this.customPos = { rx: (this.pos.x + this.halfW) / VIEW.w, ry: (this.pos.y + this.halfH) / VIEW.h };
        return;
      }
      this.throwRef = requestAnimationFrame(step);
    };
    this.throwRef = requestAnimationFrame(step);
  }

  /** 身体盒（屏幕坐标）：命中区相对 sprite 左上角的位置固定，随窗口位置平移。
   *  图集角色的命中区比视频角色窄，跨宠物碰撞用同一份换算。 */
  bodyBoxAt(x, y) {
    return {
      left: x + this.hitRect.x,
      top: y + this.hitRect.y,
      right: x + this.hitRect.x + this.hitRect.w,
      bottom: y + this.hitRect.y + this.hitRect.h,
    };
  }

  /** 被撞回调（插件主进程经 sync 转发）：停当前动作，从落点以新初速抛出去 */
  onDeskHit(vx, vy) {
    this.stopMove();
    this.stopDragFollow();
    this.stopThrow();
    this.startThrow(this.pos.x, this.pos.y, vx, vy);
  }

  /** Q 弹挤压：前台元素（视频/画布）垂直压扁（贴地锚定）再回弹；reduce-motion 时跳过 */
  startSquash(el, depth = S.SQ_SQUASH) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const token = ++this.squashToken;
    if (this.squashRef !== null) cancelAnimationFrame(this.squashRef);
    const origin = el.style.transformOrigin;
    el.style.transformOrigin = 'bottom';
    const t0 = performance.now();
    const step = () => {
      if (this.squashToken !== token) return;
      const u = Math.min((performance.now() - t0) / S.SQ_DURATION_MS, 1);
      const scale = S.squashScale(u, depth);
      const squashPrefix = this.facingTransform();
      el.style.transform = (squashPrefix ? squashPrefix + ' ' : '') + 'scaleY(' + scale + ')';
      if (u < 1) {
        this.squashRef = requestAnimationFrame(step);
      } else {
        this.squashRef = null;
        el.style.transformOrigin = origin;
        el.style.transform = this.facingTransform();
      }
    };
    this.squashRef = requestAnimationFrame(step);
  }

  stopSquash() {
    this.squashToken++;
    if (this.squashRef !== null) {
      cancelAnimationFrame(this.squashRef);
      this.squashRef = null;
    }
  }

  // ---- 点击 vs 拖拽 ----
  onPointerDown(e) {
    if (e.button !== 0) return; // 只认左键（右键不进拖拽，与上游一致）
    const grabState = this.throwState;
    this.pressScoreFired = false;
    if (grabState) {
      const grabSpeed = Math.hypot(grabState.vx, grabState.vy);
      if (grabSpeed >= S.SCORE_MIN_SPEED) {
        this.pressScoreFired = true;
        S.spawnScoreBurst(e.clientX, e.clientY);
        S.mountScorePopup({
          x: e.clientX,
          y: e.clientY,
          score: S.clickScore(grabSpeed, this.size),
          speed: grabSpeed,
          size: this.pet.size,
        });
      }
    }
    this.stopThrow();
    this.stopDragFollow();
    this.stopMove();
    this.dragTrail = [];
    this.hit.classList.add('dragging');
    try {
      this.hit.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略捕获失败 */
    }
    // 记录按下时的指针屏幕坐标与宠物窗口位置：之后全部用 screenX/Y 做增量
    // （指针屏幕坐标与窗口位置无关，不受窗口被逐帧移动影响）
    this.dragState = {
      active: true,
      dragging: false,
      sx: toLocal(e.screenX),
      sy: toLocal(e.screenY),
      petX: this.pos.x,
      petY: this.pos.y,
    };
    this.syncInputBusy();
  }

  onPointerMove(e) {
    const d = this.dragState;
    if (!d.active) return;
    const dx = toLocal(e.screenX) - d.sx;
    const dy = toLocal(e.screenY) - d.sy;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < S.DRAG_THRESHOLD) return;
      d.dragging = true;
      // 真正开始拖拽才把舞台拍平（人物随光标拿起）
      this.stage.style.transform = 'none';
      if (this.animations.drag.length) {
        this.playOnce(S.pick(this.animations.drag));
      }
      this.syncInputBusy();
    }
    const now = performance.now();
    this.dragTrail.push({ t: now, x: toLocal(e.screenX), y: toLocal(e.screenY) });
    this.dragTrail = S.trimTrail(this.dragTrail, now);
    this.dragTarget = { x: d.petX + dx, y: d.petY + dy };
    this.startDragFollow();
  }

  onPointerUp(e) {
    const d = this.dragState;
    const wasDragging = d.dragging;
    d.active = false;
    d.dragging = false;
    this.hit.classList.remove('dragging');
    this.stopDragFollow();
    this.stage.style.transform = 'translateY(' + this.bottomPad + 'px)';
    this.syncInputBusy();
    if (!wasDragging) return;
    this.justDragged = true;
    setTimeout(() => {
      this.justDragged = false;
    }, 100);
    // 拖拽松手：workStatus 非终态时恢复状态循环，否则回 idle
    if (!this.resumeWorkStatusAnim()) {
      if (this.animations.idle.length) this.playOnce(S.pick(this.animations.idle, this.anim));
    }
    const px = this.pos.x;
    const py = this.pos.y;
    const vel = S.estimateReleaseVelocity(this.dragTrail, performance.now(), this.physics);
    this.dragTrail = [];
    if (vel) {
      this.startThrow(px, py, vel.vx, vel.vy);
    } else {
      // customPos 语义 = 宠物中心比例；松手无边界夹取
      this.customPos = { rx: (px + this.halfW) / VIEW.w, ry: (py + this.halfH) / VIEW.h };
      this.position();
    }
    window.__dshPetDebug.lastDragRelease = { x: this.pos.x, y: this.pos.y };
  }

  // ---- 点击穿透（严格对齐上游：只有身体命中区可交互，透明像素穿透到下层应用） ----
  /** 本窗口是否必须保持可交互（拖拽中 / 菜单开着）——兜底轮询的最高优先级输入 */
  inputBusy() {
    return this.dragState.active || this.menuOpen;
  }

  syncInputBusy() {
    const busy = this.inputBusy();
    if (busy === this._inputBusy) return;
    this._inputBusy = busy;
    window.__dshPetDebug.inputBusy = busy;
  }

  /** 常规判定：光标在不在身体命中区（兜底轮询与转发事件共用同一份状态） */
  setInteractive(flag) {
    const next = !!flag;
    if (next === this._interactive) return;
    this._interactive = next;
    window.__dshPetDebug.interactive = next;
    // 页内通道：不直接翻窗，交给统一出口（兜底轮询里按完整规则判定）
    if (next) setWindowIgnore(false);
  }

  onMouseMove(e) {
    if (this.dragState.active || this.menuOpen) {
      this.setInteractive(true);
      return;
    }
    const r = this.hitRect;
    const wx = Number.isFinite(e.clientX) ? e.clientX : toLocal(e.screenX) - (this.pos.x + VIEW.x - this.margin.l);
    const wy = Number.isFinite(e.clientY) ? e.clientY : toLocal(e.screenY) - (this.pos.y + VIEW.y - this.margin.t);
    const px = wx - this.margin.l;
    const py = wy - this.margin.t;
    this.setInteractive(px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
  }

  /**
   * 空闲鼠标关注（只有图集角色有视线格）：把全局光标位置换算成 16 个方向之一，
   * 交给图集播放器画对应视线格；光标离开关注半径、或宠物正在拖拽/飞行/走动/开菜单时关闭。
   * point = 宿主 getState 给的屏幕坐标光标（DIP）；null = 未知。
   * 「半径」是本插件的启发式取值（图集 lookRadius × 宠物宽），不是官方规范。
   */
  onCursor(point) {
    if (!this.atlas) return;
    if (
      !point ||
      this.dragState.active ||
      this.throwState ||
      this.menuOpen ||
      this.moveRef !== null ||
      this.pendingMove
    ) {
      this.atlas.setLook(null);
      return;
    }
    const r = this.hitRect;
    const dx = point.x - (this.pos.x + VIEW.x + r.x + r.w / 2);
    const dy = point.y - (this.pos.y + VIEW.y + r.y + r.h / 2);
    const dist = Math.hypot(dx, dy);
    if (dist < Math.min(r.w, r.h) * 0.12 || dist > this.atlas.spec.lookRadius * this.size) {
      this.atlas.setLook(null);
      return;
    }
    // 正上为 0，顺时针增加：atan2(dx, -dy) 恰好是屏幕坐标系里「从正上顺时针」的方位角
    const frames = this.atlas.spec.look.frames;
    const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    this.atlas.setLook(Math.round((((deg % 360) + 360) % 360) / (360 / frames)) % frames);
  }

  onClick() {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged) return;
    if (this.pressScoreFired) {
      this.pressScoreFired = false;
      this.stopThrow();
      this.stopMove();
      return;
    }
    this.stopThrow();
    this.stopMove();
    if (!this.animations.clicks.length) return;
    this.pendingSquash = true; // 等新点击动画切到前台后 Q 弹
    this.playOnce(S.pick(this.animations.clicks));
  }

  // ---- 右键菜单（统一自绘组件：树+渲染都来自 shared-core 的 menu 模块） ----
  /** 菜单/弹窗可视矩形 = 窗口 ∩ 宠物所在那块屏（贴边时外扩余量伸出屏幕会看不见） */
  visibleClampRect() {
    const area = S.resolveRect(AREAS, this.pos.x + this.halfW, this.pos.y + this.halfH);
    if (!area) return null;
    const winX = this.pos.x + VIEW.x - this.margin.l;
    const winY = this.pos.y + VIEW.y - this.margin.t;
    const winW = this.size + this.margin.l + this.margin.r;
    const winH = this.winH + this.margin.t + this.margin.b;
    const ax = area.x + VIEW.x;
    const ay = area.y + VIEW.y;
    const vx0 = Math.max(ax, winX);
    const vy0 = Math.max(ay, winY);
    const vx1 = Math.min(ax + area.width, winX + winW);
    const vy1 = Math.min(ay + area.height, winY + winH);
    const w = vx1 - vx0;
    const h = vy1 - vy0;
    if (w < 40 || h < 40) return null;
    return { x: vx0 - winX, y: vy0 - winY, w, h };
  }

  onContextMenu(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged || this.menuOpen) return;
    // 页面自绘菜单：抑制原生右键菜单（宿主 widget 的原生菜单也一并让位）
    e.preventDefault();
    if (!document.getElementById('dsh-pet-menu-style')) {
      const style = document.createElement('style');
      style.id = 'dsh-pet-menu-style';
      style.textContent = S.MENU_CSS;
      document.head.appendChild(style);
    }
    this.stopThrow();
    this.stopMove();
    /** 工具根项：这是 PI-Desktop 侧的等价能力，工具项就是宿主/插件真有的动作 */
    const tools = [
      { label: '碎碎念一句', action: 'whisper' },
      { label: alwaysOnTop ? '取消置顶' : '窗口置顶', action: 'toggle-pin' },
      { label: '回到初始位置', action: 'home' },
      { label: '设置…', action: 'open-settings' },
      { label: '收起这只宠物', action: 'close-pet' },
      { label: '收起全部宠物', action: 'hide-all' },
    ];
    const tree = tools.concat(S.buildMenuTree(this.animations));
    if (!tree.length) return;
    this.menuOpen = true;
    this.setInteractive(true);
    this.syncInputBusy();
    window.__dshPetDebug.menuOpen = true;
    const m = S.mountContextMenu({
      tree,
      x: e.clientX,
      y: e.clientY,
      clamp: this.visibleClampRect(),
      onAction: (leaf) => this.onMenuAction(leaf),
      onClose: () => {
        this.menuOpen = false;
        window.__dshPetDebug.menuOpen = false;
        this.syncInputBusy();
      },
    });
    this.menuClose = m.close;
  }

  onMenuAction(leaf) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    switch (leaf.action) {
      case 'whisper':
        runSpriteAction('whisper', this);
        return;
      case 'toggle-pin':
        runSpriteAction('toggle-pin', this);
        return;
      case 'open-settings':
        runSpriteAction('open-settings', this);
        return;
      case 'close-pet':
        runSpriteAction('close-pet', this);
        return;
      case 'hide-all':
        runSpriteAction('hide-all', this);
        return;
      case 'home':
        this.goHome();
        return;
      default:
        break;
    }
    if (!leaf.anim) return;
    // 文字类（noMirror）朝右站姿是镜像的：点播前强制朝左
    if (S.isNoMirrorAnimation(this.animations.categories, leaf.anim) && this.facing === 'right') {
      this.facing = 'left';
    }
    // 点播移动动画：走真实移动（同一套边界检查/距离/leadSec·tailSec），挪不动退化纯播放
    if (this.animations.moves.actions.some((a) => a.name === leaf.anim)) {
      if (this.tryMove(leaf.anim) === false) this.playOnce(leaf.anim);
      return;
    }
    this.playOnce(leaf.anim);
  }

  closeMenu() {
    if (this.menuClose) {
      this.menuClose();
      this.menuClose = null;
    }
    this.menuOpen = false;
    window.__dshPetDebug.menuOpen = false;
    this.syncInputBusy();
  }

  /** 「回到初始位置」：停掉漫游/移动，清掉拖拽/漫游留下的会话位置，回配置角落 */
  goHome() {
    this.stopThrow();
    this.stopMove();
    this.customPos = null;
    this.position();
  }

  /** 气泡渲染：工作状态 > 碎碎念（同步下发） > 点击回应文本；三者都关时隐藏 */
  renderBubble() {
    this.bubble.classList.toggle('is-whisper', this.workOn || this.bubbleOn);
    if (this.workOn) {
      if (!this.workText) {
        this.bubble.classList.remove('is-on');
        window.__dshPetDebug.lastBubbleTitle = '';
        return;
      }
      this.bubble.replaceChildren(Object.assign(document.createElement('div'), { className: 'pet-bub-row', textContent: this.workText }));
      this.bubble.classList.add('is-on');
      window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
      return;
    }
    if (!this.bubbleOn || !this.bubbleText) {
      this.bubble.classList.remove('is-on');
      window.__dshPetDebug.lastBubbleTitle = '';
      return;
    }
    this.bubble.replaceChildren(Object.assign(document.createElement('div'), { className: 'pet-bub-row', textContent: this.bubbleText }));
    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
  }
}
