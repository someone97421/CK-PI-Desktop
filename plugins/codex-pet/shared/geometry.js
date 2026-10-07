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
  return { displayFor, clampBounds, initialBounds };
});
