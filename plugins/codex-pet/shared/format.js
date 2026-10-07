/* Codex 宠物图集解释器。共享纯逻辑，浏览器与 Node 使用同一份规格。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexPetFormat = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // OpenAI hatch-pet / animation-rows.md 面向桌面 app 的逐帧时长。
  // TUI 将 idle 时长扩大 6 倍；这里保留桌面合约值，区别记录于阶段文档。
  const IDLE_MS = [280, 110, 110, 140, 140, 320];
  const ROWS = {
    idle: [0, 6, 0, 0],
    'running-right': [1, 8, 120, 220],
    'running-left': [2, 8, 120, 220],
    waving: [3, 4, 140, 280],
    jumping: [4, 5, 140, 280],
    failed: [5, 8, 140, 240],
    waiting: [6, 6, 150, 260],
    running: [7, 6, 120, 220],
    review: [8, 6, 150, 280],
  };
  const ALIASES = { move_right: 'running-right', move_left: 'running-left', wave: 'waving', bounce: 'jumping', sad: 'failed', working: 'running' };
  const STATE_ACTION = { 'needs-input': 'waiting', blocked: 'failed', ready: 'review', running: 'running' };

  function frameGeometry(manifest = {}) {
    const input = manifest.frame || {};
    const geometry = { width: input.width ?? 192, height: input.height ?? 208, columns: input.columns ?? 8, rows: input.rows ?? (manifest.spriteVersionNumber === 2 ? 11 : 9) };
    if (Object.values(geometry).some((value) => !Number.isInteger(value) || value <= 0) || geometry.columns * geometry.rows > 256) throw new Error('Invalid Codex pet frame geometry');
    return geometry;
  }
  function rowFrames(row, count, duration, finalDuration, columns) {
    return Array.from({ length: count }, (_, index) => ({ index: row * columns + index, duration: index === count - 1 ? finalDuration : duration }));
  }
  function makeSpec(manifest = {}) {
    const geometry = frameGeometry(manifest);
    const animations = {};
    if (geometry.columns === 8 && geometry.rows >= 9) {
      const idle = IDLE_MS.map((duration, index) => ({ index, duration }));
      animations.idle = { frames: idle, loopStart: 0, fallback: 'idle' };
      for (const [name, [row, count, duration, finalDuration]] of Object.entries(ROWS)) {
        if (name === 'idle') continue;
        const primary = rowFrames(row, count, duration, finalDuration, geometry.columns);
        // 公开 runtime 的语义：状态行播三遍，随后进入 idle 循环。
        animations[name] = { frames: [...primary, ...primary, ...primary, ...idle], loopStart: primary.length * 3, fallback: 'idle', primary };
      }
    }
    for (const [name, input] of Object.entries(manifest.animations || {})) {
      if (!input || !Array.isArray(input.frames) || !input.frames.length) throw new Error(`Invalid pet animation: ${name}`);
      const fps = input.fps ?? 8;
      if (!Number.isFinite(fps) || fps <= 0 || fps > 60 || input.frames.some((index) => !Number.isInteger(index) || index < 0 || index >= geometry.columns * geometry.rows)) throw new Error(`Invalid pet animation: ${name}`);
      animations[name] = { frames: input.frames.map((index) => ({ index, duration: 1000 / fps })), loopStart: input.loop === false ? null : 0, fallback: typeof input.fallback === 'string' ? input.fallback : 'idle' };
    }
    if (!animations.idle) throw new Error('The pet needs an idle animation');
    for (const [alias, name] of Object.entries(ALIASES)) if (!animations[alias] && animations[name]) animations[alias] = animations[name];
    return { geometry, animations, version: manifest.spriteVersionNumber ?? 1, hasLook: geometry.columns === 8 && geometry.rows === 11 && manifest.spriteVersionNumber === 2 };
  }
  function playbackAnimation(animation, fps) {
    if (!Number.isFinite(fps) || fps < 1 || fps > 60) return animation;
    const retime = (frames) => frames.map((frame) => ({ ...frame, duration: 1000 / fps }));
    return { ...animation, frames: retime(animation.frames), ...(animation.primary ? { primary: retime(animation.primary) } : {}) };
  }
  function frameAt(animation, elapsed) {
    const frames = animation.frames;
    let time = Math.max(0, elapsed);
    const total = frames.reduce((sum, frame) => sum + frame.duration, 0);
    if (time >= total) {
      if (animation.loopStart === null) return { index: frames[frames.length - 1].index, ended: true };
      const start = animation.loopStart ?? 0;
      const prefix = frames.slice(0, start).reduce((sum, frame) => sum + frame.duration, 0);
      const loopTime = total - prefix;
      time = prefix + ((time - prefix) % loopTime);
    }
    for (const frame of frames) {
      if (time < frame.duration) return { index: frame.index, ended: false };
      time -= frame.duration;
    }
    return { index: frames[frames.length - 1].index, ended: animation.loopStart === null };
  }
  function cellFor(index, geometry) {
    return { x: (index % geometry.columns) * geometry.width, y: Math.floor(index / geometry.columns) * geometry.height, width: geometry.width, height: geometry.height };
  }
  function lookIndex(dx, dy) {
    // v2 兼容映射：顶部起顺时针16等分。公开源未规定角度顺序，阶段文档标明。
    const direction = ((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2));
    return 9 * 8 + (Math.round(direction / (Math.PI * 2) * 16) % 16);
  }
  return { IDLE_MS, ROWS, ALIASES, STATE_ACTION, frameGeometry, makeSpec, playbackAnimation, frameAt, cellFor, lookIndex };
});
