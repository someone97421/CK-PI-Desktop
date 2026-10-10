import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import { installWidgetTopmost, setWidgetAlwaysOnTop } from "../electron/main/plugin-widget-topmost.ts";

function fixture({ rejectTopmost = false } = {}) {
  const window = new EventEmitter();
  Object.assign(window, { topmost: true, visible: true, minimized: false, destroyed: false, writes: [] });
  window.isDestroyed = () => window.destroyed;
  window.isVisible = () => window.visible;
  window.isMinimized = () => window.minimized;
  window.isAlwaysOnTop = () => window.topmost;
  window.hookWindowMessage = (message, callback) => {
    assert.equal(message, 0x0047);
    window.positionChanged = callback;
  };
  window.setAlwaysOnTop = (value, level) => {
    window.writes.push(value);
    if (value) assert.equal(level, "screen-saver");
    window.topmost = value && !window.rejectTopmost;
    window.positionChanged();
  };
  installWidgetTopmost(window, true);
  window.writes.length = 0;
  window.rejectTopmost = rejectTopmost;
  return window;
}
const windowsOnly = { skip: process.platform !== "win32" };

test("原生置顶丢失后合并恢复一次，恢复产生的消息不重复置顶", windowsOnly, async () => {
  const window = fixture();
  window.topmost = false;
  window.positionChanged();
  window.positionChanged();
  await tick();
  await tick();
  assert.deepEqual(window.writes, [true]);
});

test("原生置顶恢复失败后停止自激重试，重新显示才重试", windowsOnly, async () => {
  const window = fixture({ rejectTopmost: true });
  window.topmost = false;
  window.positionChanged();
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(window.writes, [true]);
  window.rejectTopmost = false;
  window.emit("show");
  await tick();
  assert.equal(window.topmost, true);
  assert.deepEqual(window.writes, [true, true]);
});

test("异步重复降级不会在连续消息中反复恢复", windowsOnly, async (t) => {
  t.mock.method(Date, "now", () => 10000);
  const window = fixture();
  window.topmost = false;
  window.positionChanged();
  await tick();
  assert.deepEqual(window.writes, [true]);
  window.topmost = false;
  for (let i = 0; i < 5; i++) {
    window.positionChanged();
    await tick();
  }
  assert.deepEqual(window.writes, [true]);
  window.emit("restore");
  await tick();
  assert.equal(window.topmost, true);
});

test("等待恢复期间用户关闭置顶，后续层级变化也尊重关闭选择", windowsOnly, async () => {
  const window = fixture();
  window.topmost = false;
  window.positionChanged();
  setWidgetAlwaysOnTop(window, false);
  await tick();
  window.emit("show");
  window.emit("restore");
  await tick();
  assert.deepEqual(window.writes, [false]);
  setWidgetAlwaysOnTop(window, true);
  window.topmost = false;
  window.positionChanged();
  await tick();
  assert.equal(window.topmost, true);
});

test("隐藏或最小化的宠物不被拉回，重新显示或恢复后才校正", windowsOnly, async () => {
  for (const [property, event] of [["visible", "show"], ["minimized", "restore"]]) {
    const window = fixture();
    window[property] = property === "minimized";
    window.topmost = false;
    window.positionChanged();
    await tick();
    assert.deepEqual(window.writes, []);
    window[property] = property === "visible";
    window.emit(event);
    await tick();
    assert.deepEqual(window.writes, [true]);
  }
});

test("窗口关闭取消待恢复任务并清理事件监听", windowsOnly, async () => {
  const window = fixture();
  window.topmost = false;
  window.positionChanged();
  window.destroyed = true;
  window.emit("closed");
  await tick();
  assert.deepEqual(window.writes, []);
  assert.equal(window.listenerCount("show"), 0);
  assert.equal(window.listenerCount("restore"), 0);
});
