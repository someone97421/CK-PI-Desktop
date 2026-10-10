(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexPetGeometry = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function displayFor(bounds, displays) {
    if (!displays?.length) return null;
    let best = null, area = -1;
    for (const display of displays) {
      const rect = display.workArea || display.bounds;
      const overlap = Math.max(0, Math.min(bounds.x + bounds.width, rect.x + rect.width) - Math.max(bounds.x, rect.x)) * Math.max(0, Math.min(bounds.y + bounds.height, rect.y + rect.height) - Math.max(bounds.y, rect.y));
      if (overlap > area) { best = display; area = overlap; }
    }
    if (area > 0) return best;
    return displays.reduce((nearest, display) => {
      const distance = (item) => { const rect = item.workArea || item.bounds; return Math.hypot(bounds.x - Math.max(rect.x, Math.min(rect.x + rect.width, bounds.x)), bounds.y - Math.max(rect.y, Math.min(rect.y + rect.height, bounds.y))); };
      return distance(display) < distance(nearest) ? display : nearest;
    });
  }
  function clampBounds(bounds, displays) {
    const display = displayFor(bounds, displays);
    if (!display) return { ...bounds };
    const area = display.workArea || display.bounds;
    const width = Math.max(120, Math.min(Math.round(bounds.width), area.width));
    const height = Math.max(120, Math.min(Math.round(bounds.height), area.height));
    return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds.x))), y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds.y))), width, height };
  }
  function initialBounds(size, displays, cursor, position) {
    if (position) return clampBounds({ ...size, x: position.x, y: position.y }, displays);
    const display = displays.find((item) => { const area = item.workArea || item.bounds; return cursor && cursor.x >= area.x && cursor.y >= area.y && cursor.x < area.x + area.width && cursor.y < area.y + area.height; }) || displays[0];
    const area = display?.workArea || display?.bounds || { x: 0, y: 0, width: 1280, height: 800 };
    return clampBounds({ ...size, x: area.x + area.width - size.width - 24, y: area.y + area.height - size.height - 24 }, displays);
  }
  // 拖动允许跨屏，只要求留有可见区域；松手后再将整窗收进工作区。
  function dragBounds(bounds, displays) {
    let best = { ...bounds }, distance = Infinity;
    for (const display of displays || []) {
      const area = display.workArea || display.bounds;
      const visibleX = Math.min(64, bounds.width, area.width);
      const visibleY = Math.min(64, bounds.height, area.height);
      const x = Math.round(Math.max(area.x + visibleX - bounds.width, Math.min(area.x + area.width - visibleX, bounds.x)));
      const y = Math.round(Math.max(area.y + visibleY - bounds.height, Math.min(area.y + area.height - visibleY, bounds.y)));
      const candidateDistance = (x - bounds.x) ** 2 + (y - bounds.y) ** 2;
      if (candidateDistance < distance) { best = { ...bounds, x, y }; distance = candidateDistance; }
    }
    return best;
  }
  function inHoverRegion(x, y, controls, pop) {
    const contains = (rect, padding = 8) => rect && rect.right > rect.left && rect.bottom > rect.top &&
      x >= rect.left - padding && x < rect.right + padding && y >= rect.top - padding && y < rect.bottom + padding;
    if (contains(controls) || contains(pop)) return true;
    if (!controls || !pop) return false;
    // 顶层弹层脱离控制栏 DOM，保留二者之间的鼠标通道。
    return contains({
      left: Math.min(controls.left, pop.left), right: Math.max(controls.right, pop.right),
      top: Math.min(controls.bottom, pop.bottom), bottom: Math.max(controls.top, pop.top),
    });
  }
  return { displayFor, clampBounds, dragBounds, initialBounds, inHoverRegion };
});
