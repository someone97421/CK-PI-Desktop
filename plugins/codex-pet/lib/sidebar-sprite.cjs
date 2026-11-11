'use strict';

const { createHash } = require('node:crypto');
const { fail } = require('./pet-library.cjs');
const CHUNK_SIZE = 48 * 1024;

class SidebarSprite {
  constructor(library) {
    this.library = library;
    this.cached = null;
  }
  async state(settings) {
    const id = settings.selectedPetId;
    const preferences = { motion: settings.motion, filter: settings.filter, frameRate: settings.frameRate };
    if (!id) { this.cached = null; return { key: null, ...preferences }; }
    const revision = this.library.revision;
    if (this.cached?.id !== id || this.cached.revision !== revision) {
      const cached = { id, revision };
      cached.pending = this.library.asset(id).then((asset) => {
        cached.data = Buffer.from(JSON.stringify(asset)).toString('base64');
        cached.key = createHash('sha256').update(cached.data).digest('hex');
        return cached;
      });
      this.cached = cached;
    }
    const cached = await this.cached.pending;
    return { key: cached.key, chunks: Math.ceil(cached.data.length / CHUNK_SIZE), ...preferences };
  }
  chunk({ key, index } = {}) {
    const cached = this.cached;
    if (!cached?.data || key !== cached.key) fail('PET_SPRITE_CHANGED', '宠物图集已更新。', 'The pet atlas has changed.');
    if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(cached.data.length / CHUNK_SIZE)) fail('PET_SPRITE_CHUNK', '无效的图集分块。', 'Invalid atlas chunk.');
    return cached.data.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
  }
}

module.exports = { SidebarSprite };
