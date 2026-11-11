import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import format from '../shared/format.js';

const ACTIONS = { running: 'running', permission: 'waiting', completed: 'review', failed: 'failed', selected: 'idle' };
let dispose;

function createSprites(pi) {
  const listeners = new Set();
  let snapshot = { asset: null, settings: {} }, cached, timer, busy = false, stopped = false, lastCall = 0;
  const publish = (asset, settings) => {
    if (snapshot.asset === asset && ['motion', 'filter', 'frameRate'].every((key) => snapshot.settings[key] === settings[key])) return;
    snapshot = { asset, settings };
    for (const listener of listeners) listener();
  };
  async function call(method, args) {
    const delay = Math.max(0, 135 - (Date.now() - lastCall));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (stopped || !listeners.size) throw new Error('Sidebar sprite inactive');
    lastCall = Date.now();
    return pi.dispatch('plugin.call', { method, args });
  }
  async function refresh() {
    if (busy || stopped || !listeners.size) return;
    busy = true;
    try {
      const settings = await call('pet.sidebarState');
      if (!settings.key) { cached = null; publish(null, settings); return; }
      if (cached?.key !== settings.key) {
        publish(null, settings);
        const chunks = [];
        for (let index = 0; index < settings.chunks; index += 1) {
          chunks.push(await call('pet.sidebarChunk', { key: settings.key, index }));
        }
        const bytes = Uint8Array.from(atob(chunks.join('')), (char) => char.charCodeAt(0));
        const asset = JSON.parse(new TextDecoder().decode(bytes));
        const spec = format.makeSpec(asset.manifest);
        const image = new Image();
        image.src = asset.dataUrl;
        await image.decode();
        cached = { key: settings.key, spec, image };
      }
      if (!stopped) publish(cached, settings);
    } catch {
      if (!stopped) publish(null, snapshot.settings);
    } finally {
      busy = false;
      if (!stopped && listeners.size) timer = setTimeout(refresh, 5000);
    }
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
    },
    getSnapshot: () => snapshot,
    stop() { stopped = true; clearTimeout(timer); listeners.clear(); cached = null; },
  };
}

function SpriteCanvas({ asset, action, settings, fallback }) {
  const ref = useRef(null);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!context) { setFailed(true); return; }
    const source = asset.spec.animations[action];
    const animation = format.playbackAnimation(source.primary ? { ...source, frames: source.primary, loopStart: 0 } : source, settings.frameRate);
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = canvas.height = Math.round(20 * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = settings.filter === 'smooth';
    let frame = 0, timer, visible = true, ended = false;
    const paint = () => {
      clearTimeout(timer);
      if (ended) return;
      try {
        const cell = format.cellFor(animation.frames[frame].index, asset.spec.geometry);
        const scale = Math.min(20 / cell.width, 20 / cell.height);
        const width = cell.width * scale, height = cell.height * scale;
        context.clearRect(0, 0, 20, 20);
        context.drawImage(asset.image, cell.x, cell.y, cell.width, cell.height, (20 - width) / 2, (20 - height) / 2, width, height);
        setPainted(true);
      } catch { ended = true; setFailed(true); return; }
      const reduced = settings.motion === 'reduce' || (settings.motion !== 'full' && motion.matches);
      if (action === 'idle' || reduced || !visible || document.hidden) return;
      timer = setTimeout(() => {
        if (frame + 1 < animation.frames.length) frame += 1;
        else if (animation.loopStart === null) return;
        else frame = animation.loopStart ?? 0;
        paint();
      }, animation.frames[frame].duration);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; paint(); });
    observer.observe(canvas);
    const restart = () => { frame = 0; paint(); };
    motion.addEventListener('change', restart);
    document.addEventListener('visibilitychange', paint);
    paint();
    return () => {
      ended = true;
      clearTimeout(timer);
      observer.disconnect();
      motion.removeEventListener('change', restart);
      document.removeEventListener('visibilitychange', paint);
    };
  }, [asset, action, settings]);
  if (failed) return fallback;
  return React.createElement(React.Fragment, null,
    painted ? null : fallback,
    React.createElement('canvas', {
      ref, className: 'pet-sidebar-sprite', 'aria-hidden': true,
      style: { visibility: painted ? 'visible' : 'hidden', imageRendering: settings.filter === 'smooth' ? 'auto' : 'pixelated' },
    }),
  );
}

export function onLoad(pi) {
  const sprites = createSprites(pi);
  function SidebarPet({ status, fallback }) {
    const { asset, settings } = useSyncExternalStore(sprites.subscribe, sprites.getSnapshot, sprites.getSnapshot);
    const action = ACTIONS[status];
    if (!asset?.spec.animations[action]) return fallback;
    return React.createElement(SpriteCanvas, { key: `${asset.key}:${action}`, asset, action, settings, fallback });
  }
  const removeStyle = pi.ui.injectStyle('.pet-sidebar-sprite { display: block; width: 20px; height: 20px; pointer-events: none; }');
  try {
    const removeSlot = pi.slots.register({ slot: 'sidebarSessionStatus', component: SidebarPet });
    dispose = () => { removeSlot(); removeStyle(); sprites.stop(); };
  } catch (error) {
    removeStyle(); sprites.stop(); throw error;
  }
}

export function onUnload() { dispose?.(); dispose = null; }
