/**
 * dsh-pet 桌宠（这是一个助手插件）—— 精灵图集角色：规格表 + 画布播放器。
 *
 * 现有的女仆角色是 106 段透明 webm，逐段用双缓冲 <video> 播放（sprite.js 的原有路径）。
 * Codex v2 标准宠物素材是一张精灵图集（8 列 × 11 行，每格 192×208，全图 1536×2288），
 * 一行一类动作、按格推进；这里**原生逐帧绘制到 <canvas>**，不把它转成 106 段视频：
 *   - 画布内部分辨率 = 单格原始像素（192×208），CSS 缩放到舞台上，像素边缘清晰；
 *   - 一次只画当前格（clearRect + drawImage 单格），不搬运整张图；
 *   - 帧推进用 rAF 计时，帧时长按行配置（见下表），一次性动作播完回调 sprite.handleEnded()，
 *     循环动作直接回绕 —— 与视频路径的 once/loop 语义一致。
 *
 * 帧数不是「每行 8 帧」的假设，而是逐格读取素材 alpha 得出的：
 *   row0 0..5（第 6 格与第 0 格姿态几乎一致，是独立的 neutral 静态格，不进 idle 循环）、
 *   row1/2 0..7、row3 0..3、row4 0..4、row5 0..7、row6/7/8 0..5、row9/10 0..7。
 * 帧时长没有权威规范可查，取值为本插件的显式选择（注释里写清），改这里即可调整快慢。
 *
 * 规格表 keyed by 角色 id，与 assets/config.jsonc 的 characters.<id> 一一对应：
 * 动作池（哪些动作进 idle/turn/点击/事件）在配置里，行结构（行号/帧数/朝向）在这里。
 *
 * 经典 script 全局共享：index.html 在 sprite.js 之前加载本文件。
 */
'use strict';

/**
 * 角色图集规格。字段含义：
 *   cols     每行格数（Codex v2 标准 8）
 *   cell     单格像素尺寸（画布内部分辨率）
 *   anims    动作名 → { row, from, frames, frameMs, loop, side }
 *            from  = 该行起始格（默认 0）；frames = 实测帧数
 *            frameMs = 单帧毫秒（**本插件的取值，不是官方规范**）
 *            loop  = 允许循环（调用方要求常驻播放时回绕，而不是播完就结束）
 *            side  = 该行动作自带朝向（'left'/'right'）：行进方向与 facing 由它决定，不做镜像
 *   look     视线格：frames 个方向（正上起顺时针等分），顺序排在 row 起的连续行里
 *   lookAnims 只有这些动作在前台时才改画视线格（避免打断走位/事件动作）
 *   lookRadius 关注半径（× 宠物宽）：光标离宠物中心超过它就不看
 *   hit      命中区 = 全图集非透明像素并集包围盒（格内像素，含边界，实测）
 */
const PetAtlasSpecs = {
  'xiao-dino': {
    id: 'xiao-dino',
    label: 'Xiao Dino',
    cols: 8,
    cell: { w: 192, h: 208 },
    anims: {
      // row0 待机呼吸：0..5 共 6 帧（约 0.9s 一轮）
      idle: { row: 0, from: 0, frames: 6, frameMs: 150, loop: true },
      // row0 第 6 格：静态 neutral 姿态（与第 0 格同姿态，属独立格，可单独点播）
      neutral: { row: 0, from: 6, frames: 1, frameMs: 400, loop: false },
      // row1/2 带方向的奔跑（每行 8 帧 ≈ 0.88s 一轮）：行进方向与朝向由行本身决定
      'running-right': { row: 1, frames: 8, frameMs: 110, loop: true, side: 'right' },
      'running-left': { row: 2, frames: 8, frameMs: 110, loop: true, side: 'left' },
      // row3 挥手（4 帧）、row4 跳跃（5 帧）、row5 失败（8 帧）
      waving: { row: 3, frames: 4, frameMs: 150, loop: false },
      jumping: { row: 4, frames: 5, frameMs: 120, loop: false },
      failed: { row: 5, frames: 8, frameMs: 130, loop: false },
      // row6 等待（循环）、row7 工作（标准名 running/work，循环）、row8 审阅（循环）
      waiting: { row: 6, frames: 6, frameMs: 180, loop: true },
      working: { row: 7, frames: 6, frameMs: 110, loop: true },
      review: { row: 8, frames: 6, frameMs: 160, loop: true },
    },
    // row9 的 8 格 + row10 的 8 格 = 16 个视线方向：索引 0 = 正上，顺时针每格 22.5°
    look: { row: 9, cols: 8, frames: 16 },
    lookAnims: ['idle'],
    // 关注半径（× 宠物宽）：光标离宠物中心超过它就不看（贴到宠物身边才算「注意到你」）
    lookRadius: 0.9,
    hit: { x0: 5, y0: 5, x1: 186, y1: 202 },
  },
};

/** 补默认值（from=0 / loop=false）；同一份规格只处理一次，避免每次取用时重复写 */
function normalizeAtlasSpec(spec) {
  if (!spec || spec.__ready) return spec;
  for (const name of Object.keys(spec.anims)) {
    const def = spec.anims[name];
    def.name = name;
    if (def.from === undefined) def.from = 0;
    if (def.loop === undefined) def.loop = false;
    if (def.side !== 'left' && def.side !== 'right') delete def.side;
  }
  spec.look ||= { row: 0, cols: spec.cols, frames: 0 };
  spec.lookAnims = Array.isArray(spec.lookAnims) ? spec.lookAnims : [];
  spec.lookRadius = Number.isFinite(spec.lookRadius) ? spec.lookRadius : 1;
  spec.__ready = true;
  return spec;
}

/** 角色 id → 规格（没有对应实现时返回 null，不假装支持） */
function petAtlasSpec(id) {
  const spec = PetAtlasSpecs[id];
  return spec ? normalizeAtlasSpec(spec) : null;
}

/**
 * 图集播放器：把「一行连续格」当成一段动画。
 * 只负责画与计时；切换动画、Q 弹、移动驱动仍由 PetSprite 统一调度
 * （与视频路径共用同一套回调：owner.onAnimFront / owner.onAnimEnded）。
 */
class PetAtlasRenderer {
  /**
   * @param {object} spec 角色图集规格（petAtlasSpec 的返回值）
   * @param {object} owner PetSprite（提供 size/bottomPad/onAnimFront/onAnimEnded）
   * @param {string} sheetUrl 图集 URL（相对 widget 页面）
   */
  constructor(spec, owner, sheetUrl) {
    this.spec = spec;
    this.owner = owner;
    this.cell = spec.cell;
    this.sheetUrl = sheetUrl;
    this.el = document.createElement('canvas');
    this.el.className = 'pet-atlas';
    this.el.width = this.cell.w;
    this.el.height = this.cell.h;
    this.ctx = this.el.getContext('2d');
    this.image = null;
    this.ready = false;
    this.loadError = null;
    /** 当前动画状态 */
    this.anim = null;
    this.def = null;
    this.once = false;
    this.gen = 0;
    this.frame = 0;
    this.elapsed = 0;
    this.playing = false;
    this.raf = null;
    this.last = 0;
    /** 视线格索引（null = 不做空闲关注）；设置后冻结行内时钟，只画视线格 */
    this.lookIndex = null;
    this.layout();
    this.load();
  }

  /** 画布 CSS 尺寸 = 单格等比 contain 进舞台（居中、脚踩舞台底线）；舞台尺寸与视频角色一致 */
  layout() {
    const size = this.owner.size;
    const stageW = size;
    const stageH = (size * 9) / 16;
    const scale = Math.min(stageW / this.cell.w, stageH / this.cell.h);
    const w = this.cell.w * scale;
    const h = this.cell.h * scale;
    this.rect = { x: (stageW - w) / 2, y: stageH - h, w, h };
    this.el.style.left = this.rect.x + 'px';
    this.el.style.top = this.rect.y + 'px';
    this.el.style.width = this.rect.w + 'px';
    this.el.style.height = this.rect.h + 'px';
  }

  load() {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.ready = true;
      this.draw();
    };
    // 图集缺失/损坏：显式报错（红条 + 调试记录），不静默当作透明角色
    img.onerror = () => {
      this.loadError = '图集加载失败：' + this.sheetUrl;
      img.onerror = null;
      window.__dshPetDebug.errors.push(this.loadError);
      showError('Xiao Dino 图集加载失败：' + this.sheetUrl + '（检查插件 assets/characters/ 是否完整）');
    };
    img.src = this.sheetUrl;
    this.image = img;
  }

  // ---- 查询 ----
  defOf(name) {
    return this.spec.anims[name] || null;
  }

  /** 该动作自带的朝向（'left'/'right'/'null'）：行进方向与 facing 由它决定 */
  sideOf(name) {
    const def = this.defOf(name);
    return def && def.side ? def.side : null;
  }

  /** 命中区（sprite 坐标，含 stage 的 bottomPad 位移）：按素材包围盒等比换算 */
  hitRect() {
    const hit = this.spec.hit;
    const r = this.rect;
    const c = this.cell;
    return {
      x: r.x + (hit.x0 / c.w) * r.w,
      y: this.owner.bottomPad + r.y + (hit.y0 / c.h) * r.h,
      w: ((hit.x1 - hit.x0 + 1) / c.w) * r.w,
      h: ((hit.y1 - hit.y0 + 1) / c.h) * r.h,
    };
  }

  /** 命中区占舞台的比例（宿主点击穿透轮询用；不含 bottomPad，与视频角色同一约定） */
  hitSpec() {
    const size = this.owner.size;
    const stageW = size;
    const stageH = (size * 9) / 16;
    const r = this.hitRect();
    return { x: r.x / stageW, y: (r.y - this.owner.bottomPad) / stageH, w: r.w / stageW, h: r.h / stageH };
  }

  /** 当前动画的位置播放器：duration/currentTime 与视频元素同形（移动驱动直接读它） */
  player() {
    const self = this;
    return {
      get duration() {
        return self.def ? (self.def.frames * self.def.frameMs) / 1000 : 0;
      },
      get currentTime() {
        return self.elapsed;
      },
    };
  }

  // ---- 播放 ----
  /**
   * 切到某个动作：gen 是 PetSprite 的世代号（过期回调会被它丢掉）。
   * once = true 播一遍就回调 onAnimEnded；once = false 时只有 loop 动作回绕，
   * 一次性动作仍然播完即结束（与视频路径的 loop=!once 语义对齐）。
   */
  play(name, once, gen) {
    const def = this.defOf(name);
    if (!def) {
      console.error('[dsh-pet] 图集角色没有动作：' + name);
      this.pause();
      return;
    }
    this.anim = name;
    this.def = def;
    this.once = !!once;
    this.gen = gen;
    this.elapsed = 0;
    this.frame = 0;
    this.lookIndex = null;
    this.playing = true;
    this.draw();
    this.owner.onAnimFront(gen, this.el, this.player());
    this.start();
  }

  start() {
    if (this.raf !== null) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((now) => this.tick(now));
  }

  pause() {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  tick(now) {
    this.raf = null;
    if (!this.playing || !this.def) return;
    const dt = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    // 空闲关注期间冻结行内时钟：宠物站着看光标，不继续推进待机链
    if (this.lookIndex === null) {
      this.elapsed += dt;
      const total = (this.def.frames * this.def.frameMs) / 1000;
      if (this.elapsed >= total) {
        if (this.once || !this.def.loop) {
          this.elapsed = total;
          this.frame = this.def.frames - 1;
          this.draw();
          this.finish();
          return;
        }
        this.elapsed -= total;
      }
      const index = Math.min(this.def.frames - 1, Math.floor((this.elapsed * 1000) / this.def.frameMs));
      if (index !== this.frame) {
        this.frame = index;
        this.draw();
      }
    }
    this.raf = requestAnimationFrame((next) => this.tick(next));
  }

  /** 一次性动作播完：交回 sprite 的动画链（与视频 ended 同一入口） */
  finish() {
    this.playing = false;
    const gen = this.gen;
    this.owner.onAnimEnded(gen);
  }

  /**
   * 空闲鼠标关注：index = 视线格（0 = 正上，顺时针 22.5° 步进），null = 关闭。
   * 当前动作不在 lookAnims 里时忽略（不打断走位/事件动作）。
   */
  setLook(index) {
    const frames = this.spec.look.frames;
    const allowed = index !== null && frames > 0 && this.def !== null && this.spec.lookAnims.includes(this.anim);
    const next = allowed ? ((index % frames) + frames) % frames : null;
    if (next === this.lookIndex) return;
    this.lookIndex = next;
    this.draw();
  }

  /** 画当前帧（或视线格）：整格对齐，缩放交给 CSS */
  draw() {
    const w = this.cell.w;
    const h = this.cell.h;
    this.ctx.clearRect(0, 0, w, h);
    if (!this.ready || !this.image) return;
    let row;
    let col;
    if (this.lookIndex !== null) {
      const look = this.spec.look;
      row = look.row + Math.floor(this.lookIndex / look.cols);
      col = this.lookIndex % look.cols;
    } else if (this.def) {
      const index = this.def.from + this.frame;
      row = this.def.row + Math.floor(index / this.spec.cols);
      col = index % this.spec.cols;
    } else {
      return;
    }
    this.ctx.drawImage(this.image, col * w, row * h, w, h, 0, 0, w, h);
  }

  /** 释放：停计时、解绑图片回调、丢引用（DOM 节点随 sprite 一起移除） */
  dispose() {
    this.playing = false;
    this.pause();
    if (this.image) {
      this.image.onload = null;
      this.image.onerror = null;
      this.image.src = '';
      this.image = null;
    }
    this.ready = false;
    this.def = null;
    this.anim = null;
    this.owner = null;
    this.el.remove();
  }
}
