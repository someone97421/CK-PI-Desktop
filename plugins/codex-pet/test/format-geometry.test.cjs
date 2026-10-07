'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const format = require('../shared/format.js');
const geometry = require('../shared/geometry.js');

test('v1 idle 按桌面逐帧时长循环，帧边界和图集裁切正确', () => {
  const spec = format.makeSpec({ spriteVersionNumber: 1 });
  assert.deepEqual(spec.animations.idle.frames.map((f) => f.duration), [280, 110, 110, 140, 140, 320]);
  assert.equal(format.frameAt(spec.animations.idle, 279).index, 0);
  assert.equal(format.frameAt(spec.animations.idle, 280).index, 1);
  assert.equal(format.frameAt(spec.animations.idle, 1100).index, 0);
  assert.deepEqual(format.cellFor(64, spec.geometry), { x: 0, y: 1664, width: 192, height: 208 });
});

test('状态动作播放三遍后进入 idle，非循环自定义动作返回 fallback', () => {
  const spec = format.makeSpec({});
  const wave = spec.animations.waving;
  const duration = wave.primary.reduce((sum, f) => sum + f.duration, 0);
  assert.equal(format.frameAt(wave, duration * 3 - 1).index, 27);
  assert.equal(format.frameAt(wave, duration * 3).index, 0);
  const custom = format.makeSpec({ frame: { width: 32, height: 32, columns: 2, rows: 1 }, animations: { idle: { frames: [0], fps: 8 }, waving: { frames: [1], fps: 10, loop: false, fallback: 'idle' } } });
  assert.deepEqual(format.frameAt(custom.animations.waving, 100), { index: 1, ended: true });
  assert.throws(() => format.makeSpec({ animations: { idle: { frames: [999] } } }), /Invalid/);
});

const displays = [
  { id: 'left', workArea: { x: -1920, y: 0, width: 1920, height: 1040 } },
  { id: 'main', workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
];

test('多屏负坐标按最大重叠选屏并限制在工作区', () => {
  assert.equal(geometry.displayFor({ x: -300, y: 100, width: 384, height: 200 }, displays).id, 'left');
  assert.deepEqual(geometry.clampBounds({ x: -2100, y: 1000, width: 384, height: 200 }, displays), { x: -1920, y: 840, width: 384, height: 200 });
});

test('移除显示器后归位，初次位置跟随光标所在屏幕', () => {
  assert.deepEqual(geometry.initialBounds({ width: 384, height: 200 }, [displays[1]], { x: 100, y: 100 }, { x: -1800, y: 120 }), { x: 0, y: 120, width: 384, height: 200 });
  assert.deepEqual(geometry.initialBounds({ width: 384, height: 200 }, displays, { x: -100, y: 100 }, null), { x: -408, y: 816, width: 384, height: 200 });
});

test('指定 FPS 覆盖标准和自定义动作时长，保留循环/回退和原始素材', () => {
  const spec = format.makeSpec({ animations: { jumping: { frames: [32, 33], fps: 5, loop: false, fallback: 'idle' } } });
  const idle = format.playbackAnimation(spec.animations.idle, 20);
  assert.equal(format.frameAt(idle, 49).index, 0);
  assert.equal(format.frameAt(idle, 50).index, 1);
  assert.equal(format.frameAt(idle, 300).index, 0);
  const wave = format.playbackAnimation(spec.animations.waving, 10);
  assert.ok(wave.primary.every((frame) => frame.duration === 100));
  assert.equal(format.frameAt(wave, 1200).index, 0);
  const jump = format.playbackAnimation(spec.animations.jumping, 10);
  assert.deepEqual(format.frameAt(jump, 200), { index: 33, ended: true });
  assert.equal(jump.fallback, 'idle');
  assert.equal(spec.animations.jumping.frames[0].duration, 200);
  assert.equal(spec.animations.idle.frames[0].duration, 280);
  assert.equal(format.playbackAnimation(spec.animations.idle, null), spec.animations.idle);
});
