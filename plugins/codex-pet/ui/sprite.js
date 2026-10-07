import '../shared/format.js';

const format = globalThis.CodexPetFormat;

export class SpritePlayer {
  constructor(stage, onError) {
    this.stage = stage;
    this.onError = onError;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'pet-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'button');
    this.canvas.setAttribute('aria-label', 'Pet');
    this.canvas.style.touchAction = 'none';
    this.stage.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.spec = null;
    this.image = null;
    this.state = null;
    this.action = 'idle';
    this.started = performance.now();
    this.look = null;
    this.dragging = false;
    this.reduced = false;
    this.disposed = false;
    this.generation = 0;
    this.lastFrame = null;
    this.size = 96;
    this.media = matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotion = () => this.configure(this.settings || {});
    this.media.addEventListener('change', this.onMotion);
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }
  async load(manifest, dataUrl) {
    const generation = ++this.generation;
    const spec = format.makeSpec(manifest);
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    if (this.disposed || generation !== this.generation) return;
    if (image.naturalWidth !== spec.geometry.width * spec.geometry.columns || image.naturalHeight !== spec.geometry.height * spec.geometry.rows) throw new Error('Sprite atlas dimensions do not match pet.json');
    this.spec = spec;
    this.image = image;
    this.canvas.width = spec.geometry.width;
    this.canvas.height = spec.geometry.height;
    this.canvas.setAttribute('aria-label', manifest.displayName || manifest.id || 'Pet');
    this.canvas.hidden = false;
    this.stage.classList.add('has-pet');
    this.configure(this.settings || {});
    this.play(format.STATE_ACTION[this.state] || 'idle', true);
  }
  clear() {
    this.generation += 1;
    this.image = null;
    this.spec = null;
    this.canvas.hidden = true;
    this.stage.classList.remove('has-pet');
  }
  configure(settings) {
    this.settings = settings;
    if (this.spec && (this.playbackSpec !== this.spec || this.frameRate !== settings.frameRate)) {
      this.playbackSpec = this.spec;
      this.frameRate = settings.frameRate;
      this.animations = Object.fromEntries(Object.entries(this.spec.animations).map(([name, animation]) => [name, format.playbackAnimation(animation, settings.frameRate)]));
      this.started = performance.now();
    }
    this.size = settings.size || 96;
    this.reduced = settings.motion === 'reduce' || (settings.motion !== 'full' && this.media.matches);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size * (this.spec?.geometry.height || 208) / (this.spec?.geometry.width || 192)}px`;
    this.stage.style.height = this.canvas.style.height;
    this.canvas.style.imageRendering = settings.filter === 'smooth' ? 'auto' : 'pixelated';
    this.context.imageSmoothingEnabled = settings.filter === 'smooth';
    this.lastFrame = null;
  }
  setState(state) {
    if (state === this.state) return;
    this.state = state;
    if (!this.dragging) this.play(format.STATE_ACTION[state] || 'idle', true);
  }
  play(name, force = false, transient = false, primaryLoop = false) {
    const wanted = this.spec?.animations[name] ? name : 'idle';
    if (!force && this.action === wanted) return;
    this.action = wanted;
    this.started = performance.now();
    this.transient = transient;
    this.primaryLoop = primaryLoop || (!transient && this.state === 'running' && wanted === format.STATE_ACTION.running);
    this.look = null;
    this.lastFrame = null;
  }
  perform(name) { this.play(name, true, true); }
  drag(direction) {
    this.dragging = true;
    this.play(direction < 0 ? 'running-left' : 'running-right', false, false, true);
  }
  endDrag() {
    this.dragging = false;
    this.play(format.STATE_ACTION[this.state] || 'idle', true);
  }
  pointAt(dx, dy, inside) {
    this.look = this.spec?.hasLook && this.settings?.gaze !== false && !this.state && !this.dragging && !this.transient && inside ? format.lookIndex(dx, dy) : null;
  }
  tick(time) {
    if (this.disposed) return;
    if (this.image && this.spec && !document.hidden) {
      try {
        let animation = this.animations[this.action] || this.animations.idle;
        if (this.primaryLoop) animation = { frames: animation.primary || animation.frames, loopStart: 0 };
        const elapsed = time - this.started;
        const prefixTime = animation.frames.slice(0, animation.loopStart || animation.frames.length).reduce((total, frame) => total + frame.duration, 0);
        if (this.transient && elapsed >= prefixTime) {
          this.play(format.STATE_ACTION[this.state] || 'idle', true);
          animation = this.animations[this.action] || this.animations.idle;
        }
        const result = format.frameAt(animation, time - this.started);
        if (result.ended) this.play(animation.fallback || 'idle', true);
        const index = this.reduced ? this.spec.animations.idle.frames[0].index : this.look ?? result.index;
        if (index !== this.lastFrame) {
          const cell = format.cellFor(index, this.spec.geometry);
          this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.context.drawImage(this.image, cell.x, cell.y, cell.width, cell.height, 0, 0, this.canvas.width, this.canvas.height);
          this.lastFrame = index;
        }
      } catch (error) { this.onError?.(error.message); this.clear(); }
    }
    this.frame = requestAnimationFrame((next) => this.tick(next));
  }
  hitTest(x, y) {
    if (!this.image || this.canvas.hidden) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return false;
    const px = Math.floor((x - rect.left) / rect.width * this.canvas.width);
    const py = Math.floor((y - rect.top) / rect.height * this.canvas.height);
    return this.context.getImageData(px, py, 1, 1).data[3] > 16;
  }
  dispose() {
    this.disposed = true;
    this.generation += 1;
    cancelAnimationFrame(this.frame);
    this.media.removeEventListener('change', this.onMotion);
    this.canvas.remove();
  }
}
