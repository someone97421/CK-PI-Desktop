/**
 * Fullscreen / maximize state interlock on Windows (issue #1655).
 *
 * Behavioral: the borderless fullscreen helper keeps the tracked flag in sync
 * with Electron's own, and the native-menu actions never leave both the
 * maximize and fullscreen flags set at once. Entering fullscreen from a
 * maximized window unmaximizes first; maximizing a fullscreen window leaves
 * fullscreen first.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { isWindowFullScreen, setWindowFullScreen } = await import(
  "../electron/main/window-fullscreen.ts"
);
const { readMainSource } = await import("./helpers/source-contracts.mjs");

const lifecycleSource = await readMainSource();

function makeWindow() {
  const window = new EventEmitter();
  const calls = [];
  let maximized = false;
  let fullScreen = false;
  window.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
  window.isDestroyed = () => false;
  window.isMinimized = () => false;
  window.isFocused = () => true;
  window.isVisible = () => true;
  window.isMaximized = () => maximized;
  // On the Win32 borderless path Electron's own flag stays false, which is the
  // whole reason the tracked flag exists.
  window.isFullScreen = () => fullScreen;
  window.setFullScreen = (value) => {
    fullScreen = value;
    window.emit(value ? "enter-full-screen" : "leave-full-screen");
  };
  window.unmaximize = () => {
    calls.push("unmaximize");
    maximized = false;
  };
  window.maximize = () => {
    calls.push("maximize");
    maximized = true;
  };
  return {
    window,
    calls,
    setMaximized(value) {
      maximized = value;
    },
  };
}

test("the tracked flag follows setWindowFullScreen for the borderless fallback", () => {
  const fixture = makeWindow();
  // Electron's own flag stays false on the Win32 borderless path, so the
  // tracked flag alone decides the toggle state.
  assert.equal(isWindowFullScreen(fixture.window), false);

  setWindowFullScreen(fixture.window, true, true);
  assert.equal(isWindowFullScreen(fixture.window), true);

  setWindowFullScreen(fixture.window, false, true);
  assert.equal(isWindowFullScreen(fixture.window), false);
});
test("the tracked flag is not written when the borderless fallback does not apply", () => {
  const fixture = makeWindow();
  // Without the Win32 borderless path only Electron's real flag is consulted,
  // so the tracked set stays empty and the helper mirrors `setFullScreen`.
  assert.equal(fixture.window.isFullScreen(), false);
  setWindowFullScreen(fixture.window, true, false);
  assert.equal(fixture.window.isFullScreen(), true);
  assert.equal(isWindowFullScreen(fixture.window), true);
  setWindowFullScreen(fixture.window, false, false);
  assert.equal(isWindowFullScreen(fixture.window), false);
});

test("entering fullscreen from a maximized window unmaximizes first", () => {
  const fixture = makeWindow();
  fixture.setMaximized(true);

  const wasMaximized = fixture.window.isMaximized();
  if (!isWindowFullScreen(fixture.window) && wasMaximized) {
    fixture.window.unmaximize();
  }
  setWindowFullScreen(fixture.window, true, true);

  assert.deepEqual(fixture.calls, ["unmaximize"]);
  assert.equal(isWindowFullScreen(fixture.window), true);
  // The window must never be maximized and fullscreen at the same time.
  assert.equal(fixture.window.isMaximized(), false);
});

test("maximizing a fullscreen window leaves fullscreen first", () => {
  const fixture = makeWindow();
  setWindowFullScreen(fixture.window, true, true);
  assert.equal(isWindowFullScreen(fixture.window), true);

  if (fixture.window.isMaximized()) {
    fixture.window.unmaximize();
  } else {
    if (isWindowFullScreen(fixture.window)) {
      setWindowFullScreen(fixture.window, false, true);
    }
    fixture.window.maximize();
  }

  assert.deepEqual(fixture.calls, ["maximize"]);
  assert.equal(isWindowFullScreen(fixture.window), false);
  assert.equal(fixture.window.isMaximized(), true);
});

test("the fullscreen toggle unmaximizes before it toggles", () => {
  const block = lifecycleSource.slice(
    lifecycleSource.indexOf('case "toggleFullScreen"'),
    lifecycleSource.indexOf('case "minimize"'),
  );
  assert.match(block, /if \(!target\.isFullScreen\(\)\) \{/);
  assert.match(block, /const wasMaximized = target\.isMaximized\(\)/);
  assert.match(block, /if \(wasMaximized\) target\.unmaximize\(\)/);
  assert.match(block, /target\.setFullScreen\(true\)/);
  assert.match(block, /target\.setFullScreen\(false\)/);
});

test("leaving fullscreen returns a previously maximized window to maximized", () => {
  const fixture = makeWindow();
  fixture.setMaximized(true);

  // Enter fullscreen from maximized, mirroring `executeNativeMenuAction`.
  if (!isWindowFullScreen(fixture.window)) {
    const wasMaximized = fixture.window.isMaximized();
    if (wasMaximized) fixture.window.unmaximize();
    if (wasMaximized) {
      fixture.window.once("leave-full-screen", () => {
        if (fixture.window.isDestroyed() || isWindowFullScreen(fixture.window)) return;
        fixture.window.maximize();
      });
    }
    setWindowFullScreen(fixture.window, true, true);
  }
  assert.equal(isWindowFullScreen(fixture.window), true);
  assert.equal(fixture.window.isMaximized(), false);

  // Leaving fullscreen must restore the pre-fullscreen maximized state.
  setWindowFullScreen(fixture.window, false, true);
  assert.equal(isWindowFullScreen(fixture.window), false);
  assert.equal(fixture.window.isMaximized(), true);
});

test("leaving fullscreen keeps a normal window at its normal size", () => {
  const fixture = makeWindow();
  assert.equal(fixture.window.isMaximized(), false);

  setWindowFullScreen(fixture.window, true, true);
  setWindowFullScreen(fixture.window, false, true);

  assert.equal(isWindowFullScreen(fixture.window), false);
  assert.equal(fixture.window.isMaximized(), false);
  assert.deepEqual(fixture.calls, []);
});

test("the fullscreen toggle restores maximized on leave", () => {
  const block = lifecycleSource.slice(
    lifecycleSource.indexOf('case "toggleFullScreen"'),
    lifecycleSource.indexOf('case "minimize"'),
  );
  assert.match(block, /target\.once\("leave-full-screen"/);
  assert.match(block, /target\.maximize\(\)/);
});

test("the maximize toggle leaves fullscreen first", () => {
  const block = lifecycleSource.slice(
    lifecycleSource.indexOf('case "toggleMaximize"'),
    lifecycleSource.indexOf('case "close"'),
  );
  assert.match(block, /if \(target\.isMaximized\(\)\)/);
  assert.match(block, /if \(target\.isFullScreen\(\)\) target\.setFullScreen\(false\)/);
  assert.match(block, /target\.maximize\(\)/);
});

test("显示器布局调整使用原生全屏状态", () => {
  assert.match(
    lifecycleSource,
    /if \(isLiveWindow\(\) && !window\.isFullScreen\(\)\) \{/,
  );
});
