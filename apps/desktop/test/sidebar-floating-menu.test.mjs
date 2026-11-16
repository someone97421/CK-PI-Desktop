import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  placeSidebarFloatingMenu,
  placeSidebarFloatingMenuTop,
  SIDEBAR_MENU_VIEWPORT_PADDING,
} = await import("../src/lib/sidebar-floating-menu.ts");

test("sidebar floating menu opens above a bottom-edge project row", () => {
  const top = placeSidebarFloatingMenuTop(
    { top: 720, bottom: 752 },
    200,
    900,
  );

  assert.equal(top, 720 - 200 - 4);
});

test("sidebar floating menu stays below its anchor when the actual height fits", () => {
  const top = placeSidebarFloatingMenuTop(
    { top: 480, bottom: 512 },
    200,
    900,
  );

  assert.equal(top, 512 + 4);
});

test("sidebar floating menu opens above a pointer near the viewport bottom", () => {
  const pointerY = 840;
  const menuHeight = 220;
  const top = placeSidebarFloatingMenuTop(
    { top: pointerY, bottom: pointerY },
    menuHeight,
    900,
  );

  assert.equal(top, pointerY - menuHeight - 4);
});

test("sidebar floating menu stays within viewport padding in a short window", () => {
  const viewportHeight = 300;
  const top = placeSidebarFloatingMenuTop(
    { top: 260, bottom: 280 },
    500,
    viewportHeight,
  );

  assert.equal(top, SIDEBAR_MENU_VIEWPORT_PADDING);
  assert.equal(
    top + viewportHeight - 2 * SIDEBAR_MENU_VIEWPORT_PADDING,
    viewportHeight - SIDEBAR_MENU_VIEWPORT_PADDING,
  );
});

test("浮动菜单在桌面空间充足时保留触发点右侧布局", () => {
  assert.deepEqual(
    placeSidebarFloatingMenu(
      { top: 100, bottom: 132, right: 250 },
      { width: 220, height: 200 },
      { width: 1200, height: 900 },
    ),
    { top: 136, left: 254 },
  );
});

test("浮动菜单按实际宽度向左回收并保留底部向上翻转", () => {
  assert.deepEqual(
    placeSidebarFloatingMenu(
      { top: 720, bottom: 752, right: 310 },
      { width: 220, height: 200 },
      { width: 320, height: 900 },
    ),
    { top: 516, left: 92 },
  );
});

test("分组右键菜单在视口右下角仍保持完整可见", () => {
  assert.deepEqual(
    placeSidebarFloatingMenu(
      { top: 590, bottom: 590, right: 799 },
      { width: 176, height: 80 },
      { width: 800, height: 600 },
    ),
    { top: 506, left: 616 },
  );
});

test("菜单宽度或窗口宽度变化后从原锚点重新定位", () => {
  const anchor = { top: 100, bottom: 132, right: 250 };
  const place = (width, viewportWidth) => placeSidebarFloatingMenu(
    anchor,
    { width, height: 200 },
    { width: viewportWidth, height: 900 },
  );
  assert.equal(place(184, 600).left, 254);
  assert.equal(place(400, 600).left, 192);
  assert.equal(place(184, 320).left, 128);
  assert.equal(place(184, 600).left, 254);
});

test("窄窗口和视口外锚点均将菜单约束在横向留白内", () => {
  for (const viewportWidth of [120, 180, 320, 800]) {
    for (const measuredWidth of [80, 184, 500]) {
      for (const right of [-100, 0, viewportWidth - 1, viewportWidth + 100]) {
        const { left } = placeSidebarFloatingMenu(
          { top: 100, bottom: 132, right },
          { width: measuredWidth, height: 200 },
          { width: viewportWidth, height: 600 },
        );
        const constrainedWidth = Math.min(
          measuredWidth,
          viewportWidth - 2 * SIDEBAR_MENU_VIEWPORT_PADDING,
        );
        assert.ok(left >= SIDEBAR_MENU_VIEWPORT_PADDING);
        assert.ok(left + constrainedWidth <= viewportWidth - SIDEBAR_MENU_VIEWPORT_PADDING);
      }
    }
  }
});
