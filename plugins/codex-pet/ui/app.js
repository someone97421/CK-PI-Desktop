import { createUI } from './interface.js';
import { SpritePlayer } from './sprite.js';
import '../shared/geometry.js';

const geometry = globalThis.CodexPetGeometry;
const bridge = window.pluginBridge;
const preview = !bridge;
const root = document.querySelector('#app');
let model, ui, sprite, nativeState, anchor, dragging, closed = false, syncing = false;
let loadedPet = null, loadedStamp = null, pollTimer, activityTimer, cursorTimer, resizeFrame, ignoreMouse = false;
let boundsQueue = null, pendingBounds = null, seenIntent = { settings: 0, focus: 0 };
let embeddedView = document.documentElement.dataset.piPluginPanelShape === 'view';
let settingsSurface = new URLSearchParams(location.search).get('surface') === 'settings' || embeddedView;
let nativeAvailable = false;
const previewState = {
  locale: new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh-CN', preview: true,
  settings: { selectedPetId: null, visible: true, size: 96, alwaysOnTop: true, filter: 'pixelated', motion: 'system', frameRate: null, position: null, pollSeconds: 8, shortcut: '' },
  pets: [], activity: { rows: [], state: null, stale: false, error: null, updatedAt: null }, models: [], commands: [],
  draft: { text: '', attachments: [], skills: [], modelKey: '' }, intent: { settings: 0, focus: 0 }, warnings: [],
};
const previewAssets = new Map();

async function previewRequest(channel, payload) {
  const unavailable = () => { throw new Error(previewState.locale === 'en' ? 'This is a browser preview. Install the plugin to use desktop and chat features.' : '当前为浏览器预览。安装插件后可使用桌面和聊天功能。'); };
  switch (channel) {
    case 'pet.state': case 'pet.refresh': return previewState;
    case 'pet.activity': return previewState.activity;
    case 'pet.asset': return previewAssets.get(payload.id);
    case 'pet.settings': Object.assign(previewState.settings, payload.patch); return previewState;
    case 'pet.select': previewState.settings.selectedPetId = payload.id; return previewState;
    case 'pet.draft': Object.assign(previewState.draft, payload); return previewState;
    case 'pet.commands': return [];
    case 'pet.remove': previewAssets.delete(payload.id); previewState.pets = previewState.pets.filter((pet) => pet.id !== payload.id); if (previewState.settings.selectedPetId === payload.id) previewState.settings.selectedPetId = null; return previewState;
    case 'pet.importFiles': {
      const manifestFile = payload.files.find((file) => file.name === 'pet.json' || file.relativePath?.endsWith('/pet.json'));
      if (!manifestFile) throw new Error('Choose pet.json and its sprite atlas.');
      const manifest = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(manifestFile.dataBase64), (char) => char.charCodeAt(0))));
      manifest.id ||= 'preview-pet'; manifest.displayName ||= manifest.id; manifest.spritesheetPath ||= 'spritesheet.webp'; manifest.spriteVersionNumber ??= 1;
      const atlas = payload.files.find((file) => file.name === manifest.spritesheetPath.split('/').pop());
      if (!atlas) throw new Error('Missing sprite atlas.');
      const dataUrl = `data:${atlas.name.endsWith('.png') ? 'image/png' : 'image/webp'};base64,${atlas.dataBase64}`;
      const image = new Image(); image.src = dataUrl; await image.decode();
      const spec = globalThis.CodexPetFormat.makeSpec(manifest);
      if (image.naturalWidth !== spec.geometry.width * spec.geometry.columns || image.naturalHeight !== spec.geometry.height * spec.geometry.rows) throw new Error('The atlas dimensions do not match pet.json.');
      previewAssets.set(manifest.id, { manifest, dataUrl });
      previewState.pets = previewState.pets.filter((pet) => pet.id !== manifest.id);
      previewState.pets.push({ ...manifest, width: image.naturalWidth, height: image.naturalHeight, importedAt: new Date().toISOString() });
      previewState.settings.selectedPetId = manifest.id;
      return { imported: [manifest.id], errors: [], state: previewState };
    }
    case 'pet.export': {
      const asset = previewAssets.get(payload.id);
      return { files: [{ name: 'pet.json', dataBase64: btoa(unescape(encodeURIComponent(JSON.stringify(asset.manifest, null, 2)))) }, { name: asset.manifest.spritesheetPath, dataBase64: asset.dataUrl.split(',')[1] }] };
    }
    default: return unavailable();
  }
}

async function request(channel, payload = {}) {
  const result = preview ? await previewRequest(channel, payload) : await bridge.invoke(channel, payload);
  const next = result?.state || (result?.settings && result?.pets ? result : null);
  if (next) await applyState(next);
  return result;
}
function missingWindow(error) { return String(error?.message || error).includes('no window for this widget action'); }
async function widget(action, payload = {}) {
  if (!bridge?.widget?.invoke || (action !== 'open' && !nativeAvailable)) return null;
  try { return await bridge.widget.invoke(action, payload); }
  catch (error) {
    if (!missingWindow(error)) throw error;
    nativeAvailable = false;
    clearTimeout(cursorTimer);
    return null;
  }
}
function showError(error) { ui?.showError(error?.message || String(error)); }

async function applyState(next) {
  if (closed) return;
  const previous = model;
  model = next;
  ui?.update(next);
  if (sprite) {
    const id = next.settings.selectedPetId;
    const stamp = next.pets.find((pet) => pet.id === id)?.importedAt || null;
    if (id !== loadedPet || stamp !== loadedStamp) {
      loadedPet = id; loadedStamp = stamp;
      if (!id) sprite.clear();
      else {
        try {
          const asset = preview ? await previewRequest('pet.asset', { id }) : await bridge.invoke('pet.asset', { id });
          if (loadedPet === id) await sprite.load(asset.manifest, asset.dataUrl);
        } catch (error) { sprite.clear(); showError(error); }
      }
    }
    sprite.configure(next.settings);
    sprite.setState(next.activity.state);
  }
  if (!settingsSurface && nativeAvailable) {
    if (!previous || previous.settings.alwaysOnTop !== next.settings.alwaysOnTop) await widget('setAlwaysOnTop', { value: next.settings.alwaysOnTop });
    if (next.intent?.settings > seenIntent.settings) { seenIntent.settings = next.intent.settings; await openSettings(); }
    if (next.intent?.focus > seenIntent.focus) { seenIntent.focus = next.intent.focus; ui.focusComposer(); }
  }
  scheduleLayout();
}

function scheduleLayout() {
  if (closed) return;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => resizeWindow().catch(showError));
}
function setBounds(bounds) {
  // 最多一个请求在途、一个最新目标待发送，不回放已过期的鼠标轨迹。
  pendingBounds = bounds;
  if (!boundsQueue) {
    boundsQueue = Promise.resolve().then(async () => {
      try {
        while (pendingBounds && !closed) {
          const target = pendingBounds;
          pendingBounds = null;
          const result = await widget('setBounds', target);
          if (result?.bounds && nativeState) nativeState.bounds = result.bounds;
        }
      } finally {
        pendingBounds = null;
        boundsQueue = null;
      }
    });
  }
  return boundsQueue;
}
async function resizeWindow() {
  if (!nativeAvailable || embeddedView || dragging) return;
  nativeState ||= await widget('getState');
  if (!nativeState || closed || dragging) return;
  const bounds = root.getBoundingClientRect();
  const size = settingsSurface ? { width: 760, height: 680 } : { width: 384, height: Math.max(120, Math.ceil(bounds.bottom + 12)) };
  if (!anchor) anchor = geometry.initialBounds(size, nativeState.displays, nativeState.cursor, settingsSurface ? null : model?.settings.position);
  const target = geometry.clampBounds({ ...size, x: anchor.x, y: anchor.y }, nativeState.displays);
  // 记住裁剪后的实际位置，收起面板时不再弹回屏幕底部。
  anchor = { x: target.x, y: target.y };
  const current = nativeState.bounds;
  if (Object.keys(target).some((key) => Math.abs(target[key] - current[key]) > 1)) await setBounds(target);
}
async function openSettings() {
  if (preview) { location.search = '?surface=settings'; return; }
  if (settingsSurface) return;
  const screen = nativeState || await widget('getState');
  const result = await widget('open', { id: 'settings', query: { surface: 'settings' }, width: 760, height: 680 });
  if (!result && screen) throw new Error('The host does not support pet settings windows.');
}
async function onAction(action, payload) {
  try {
    switch (action) {
      case 'settings': case 'choose-pet': return openSettings();
      case 'hide': if (preview) return showError(previewState.locale === 'en' ? 'Use the installed plugin to hide the desktop pet.' : '安装插件后可隐藏桌面宠物。'); await ui.flushDraft(); return request('pet.hide');
      case 'wave': return sprite?.perform('waving');
      case 'jump': return sprite?.perform('jumping');
      case 'focus-composer': return ui.focusComposer();
      case 'open-session': return await request('pet.openSession', { sessionId: payload?.sessionId || model?.activity?.output?.sessionId });
      case 'reset-position': anchor = null; await request('pet.resetPosition'); return scheduleLayout();
      case 'close':
        if (preview) { location.search = ''; return; }
        if (!settingsSurface) await ui.flushDraft();
        return widget('close');
    }
  } catch (error) { showError(error); }
}

async function cursorUpdate() {
  if (closed || !nativeAvailable || settingsSurface || dragging) return;
  const state = await widget('getState');
  // 查询期间可能已经按下宠物，旧悬停结果不能再打开鼠标穿透。
  if (!state || closed || dragging) return;
  nativeState = state;
  const x = nativeState.cursor.x - nativeState.bounds.x;
  const y = nativeState.cursor.y - nativeState.bounds.y;
  const element = document.elementFromPoint(x, y);
  const focused = document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') && document.hasFocus();
  const controlsHovered = ui.updateCursor(x, y);
  const interactive = !!focused || controlsHovered || !!element?.closest('[data-interactive]') || !!sprite?.hitTest(x, y);
  const wanted = !interactive;
  if (wanted !== ignoreMouse) { await widget('setIgnoreMouse', { ignore: wanted }); ignoreMouse = wanted; }
  const rect = sprite?.canvas.getBoundingClientRect();
  if (rect) {
    const dx = x - rect.left - rect.width / 2, dy = y - rect.top - rect.height / 2;
    sprite.pointAt(dx, dy, Math.hypot(dx, dy) <= model.settings.size * 2.5);
  }
}
function attachPetInteraction() {
  const canvas = sprite.canvas;
  async function updateDrag(pending, sampledState) {
    pending.dirty = false;
    if (!pending.bounds || dragging !== pending || closed) return;
    const state = preview ? { cursor: pending.point, displays: [] } : sampledState || await widget('getState');
    if (!state || dragging !== pending || closed) return;
    if (!preview) nativeState = state;
    // 鼠标与窗口都采用宿主 DIP 坐标，跨不同缩放的屏幕时不混用 screenX/Y。
    const dx = state.cursor.x - pending.startX, dy = state.cursor.y - pending.startY;
    if (Math.hypot(dx, dy) < 4 && !pending.moved) return;
    pending.moved = true;
    sprite.drag(dx);
    const bounds = geometry.dragBounds({ ...pending.bounds, x: pending.bounds.x + dx, y: pending.bounds.y + dy }, state.displays);
    anchor = { x: bounds.x, y: bounds.y };
    if (!preview) await setBounds(bounds);
  }
  function scheduleDrag(pending) {
    if (pending.frame || pending.update || pending.finishing || closed) return;
    pending.frame = requestAnimationFrame(() => {
      pending.frame = 0;
      pending.update = updateDrag(pending).catch(showError).finally(() => {
        pending.update = null;
        if (pending.dirty && dragging === pending) scheduleDrag(pending);
      });
    });
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (dragging || event.button !== 0 || !sprite.hitTest(event.clientX, event.clientY)) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const pending = { bounds: null, moved: false, pointerId: event.pointerId, point: { x: event.screenX, y: event.screenY }, frame: 0, update: null, dirty: false, finishing: false };
    dragging = pending;
    pending.ready = (async () => {
      try {
        // 等上一次布局落位，并覆盖可能在按下前已发出的穿透请求。
        if (!preview) { await widget('setIgnoreMouse', { ignore: false }); ignoreMouse = false; }
        await boundsQueue;
        const state = preview ? { bounds: { x: 0, y: 0, width: 384, height: 200 }, displays: [] } : await widget('getState');
        if (!state || closed || dragging !== pending) return;
        nativeState = state;
        pending.bounds = { ...state.bounds };
        // 按下点相对于窗口的位置固定，初始化期间移动鼠标也不会丢失位移。
        pending.startX = preview ? event.screenX : state.bounds.x + event.clientX;
        pending.startY = preview ? event.screenY : state.bounds.y + event.clientY;
        if (pending.dirty) scheduleDrag(pending);
      } catch (error) {
        if (dragging === pending) dragging = null;
        if (canvas.hasPointerCapture(pending.pointerId)) canvas.releasePointerCapture(pending.pointerId);
        showError(error);
      }
    })();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.finishing || event.pointerId !== dragging.pointerId) return;
    dragging.point = { x: event.screenX, y: event.screenY };
    dragging.dirty = true;
    if (dragging.bounds) scheduleDrag(dragging);
  });
  const finish = async (event) => {
    const pending = dragging;
    if (!pending || pending.finishing || event.pointerId !== pending.pointerId) return;
    pending.finishing = true;
    pending.point = { x: event.screenX, y: event.screenY };
    cancelAnimationFrame(pending.frame);
    pending.frame = 0;
    // 松手时立刻采样，避免等待在途移动后读到鼠标已经离开的新位置。
    const releasedState = !preview && event.type === 'pointerup' ? widget('getState') : Promise.resolve(null);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    try {
      const [state] = await Promise.all([releasedState, pending.ready, pending.update]);
      if (dragging !== pending || closed || !pending.bounds) return;
      if (event.type === 'pointerup' && (preview || state)) await updateDrag(pending, state);
      await boundsQueue;
      if (pending.moved && !preview) {
        const target = geometry.clampBounds(nativeState.bounds, nativeState.displays);
        await setBounds(target);
        anchor = { x: nativeState.bounds.x, y: nativeState.bounds.y };
        await request('pet.position', { position: anchor });
      } else if (!pending.moved && event.type === 'pointerup') await onAction('open-session');
    } finally {
      if (dragging === pending) {
        dragging = null;
        sprite.endDrag();
        scheduleLayout();
      }
    }
  };
  canvas.addEventListener('pointerup', (event) => void finish(event).catch(showError));
  canvas.addEventListener('pointercancel', (event) => void finish(event).catch(showError));
  canvas.addEventListener('lostpointercapture', (event) => void finish(event).catch(showError));
  canvas.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return onAction('open-session'); }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key) || preview) return;
    event.preventDefault();
    if (dragging) return;
    if (event.key === 'Escape') return onAction('reset-position');
    const state = await widget('getState'), step = event.shiftKey ? 1 : 10;
    if (!state) return;
    const target = geometry.clampBounds({ ...state.bounds, x: state.bounds.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), y: state.bounds.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }, state.displays);
    anchor = { x: target.x, y: target.y }; await setBounds(target); await request('pet.position', { position: anchor });
  });
}

async function sync() {
  if (closed || syncing) return;
  syncing = true;
  try { await request('pet.state'); } catch (error) { showError(error); }
  finally { syncing = false; if (!closed) pollTimer = setTimeout(sync, 1200); }
}
async function activityLoop() {
  if (closed || settingsSurface || preview) return;
  try {
    const activity = await bridge.invoke('pet.activity');
    if (!closed && model) {
      model = { ...model, activity };
      ui.updateActivity(activity);
      sprite?.setState(activity.state);
    }
  } catch (error) { if (!closed) showError(error); }
  finally { if (!closed) activityTimer = setTimeout(activityLoop, 300); }
}
async function cursorLoop() {
  try { await cursorUpdate(); } catch (error) { if (!closed) showError(error); }
  finally { if (!closed && nativeAvailable && !settingsSurface) cursorTimer = setTimeout(cursorLoop, 150); }
}

// 即使旧宿主没有 surface 标记，也只探测一次真实窗口能力。
if (!preview && !embeddedView && bridge?.widget?.invoke) {
  try {
    nativeState = await bridge.widget.invoke('getState');
    nativeAvailable = !!nativeState;
  } catch (error) {
    if (!missingWindow(error)) throw error;
    embeddedView = true;
  }
}
settingsSurface = new URLSearchParams(location.search).get('surface') === 'settings' || embeddedView;
ui = createUI({ root, request, onAction, onLayout: scheduleLayout, embeddedView, surface: settingsSurface ? 'settings' : 'pet' });
const stage = root.querySelector('#pet-stage');
if (stage && !settingsSurface) { sprite = new SpritePlayer(stage, showError); sprite.clear(); attachPetInteraction(); }
const observer = new ResizeObserver(scheduleLayout);
observer.observe(root);
window.addEventListener('beforeunload', () => {
  closed = true;
  clearTimeout(pollTimer); clearTimeout(activityTimer); clearTimeout(cursorTimer);
  cancelAnimationFrame(resizeFrame); cancelAnimationFrame(dragging?.frame);
  dragging = null; pendingBounds = null;
  observer.disconnect(); sprite?.dispose(); ui.dispose();
});
bridge?.on?.('appearance:changed', () => void sync());
await sync();
if (!settingsSurface && !preview) void activityLoop();
if (nativeAvailable && !settingsSurface) void cursorLoop();
