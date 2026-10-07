'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const format = require('../shared/format.js');
const { validatePng } = require('./png.cjs');

function fail(code, message, enMessage) {
  throw Object.assign(new Error(message), { code, enMessage });
}

function imageInfo(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    try { return validatePng(bytes); } catch (error) { fail('PET_IMAGE_INVALID', `PNG 图集损坏或不完整：${error.message}`, `The PNG atlas is damaged or incomplete: ${error.message}`); }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > bytes.length) break;
      if (type === 'VP8X' && size >= 10) return { width: 1 + bytes.readUIntLE(start + 4, 3), height: 1 + bytes.readUIntLE(start + 7, 3), mimeType: 'image/webp', extension: '.webp' };
      if (type === 'VP8L' && size >= 5 && bytes[start] === 47) {
        const bits = bytes.readUInt32LE(start + 1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mimeType: 'image/webp', extension: '.webp' };
      }
      if (type === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) {
        return { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff, mimeType: 'image/webp', extension: '.webp' };
      }
      offset = start + size + (size & 1);
    }
  }
  fail('PET_IMAGE_INVALID', '图集必须是有效的 PNG 或 WebP 图片。', 'The sprite atlas must be a valid PNG or WebP image.');
}

function sheetRelativePath(value) {
  const relative = String(value || '').replaceAll('\\', '/');
  if (!relative || path.posix.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.split('/').some((part) => part === '..' || !part)) {
    fail('PET_SHEET_PATH', 'spritesheetPath 必须是宠物目录内的相对文件路径。', 'spritesheetPath must refer to a file inside the pet directory.');
  }
  return relative;
}

function normalizeManifest(input, fallbackId = 'pet') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('PET_MANIFEST_INVALID', 'pet.json 必须是 JSON 对象。', 'pet.json must contain a JSON object.');
  const id = (typeof input.id === 'string' && input.id.trim()) || fallbackId;
  const displayName = (typeof input.displayName === 'string' && input.displayName.trim()) || id;
  const version = input.spriteVersionNumber === undefined ? 1 : input.spriteVersionNumber;
  if (version !== 1 && version !== 2) fail('PET_VERSION_UNSUPPORTED', `尚不支持宠物图集版本 ${String(version)}。`, `Sprite version ${String(version)} is not supported yet.`);
  return { ...input, id, displayName, description: typeof input.description === 'string' ? input.description : '', spritesheetPath: sheetRelativePath(input.spritesheetPath || 'spritesheet.webp'), spriteVersionNumber: version };
}

function validateAtlas(manifest, info) {
  let spec;
  try { spec = format.makeSpec(manifest); } catch (error) { fail('PET_ANIMATION_INVALID', `宠物帧规格或动作无效：${error.message}`, `Invalid pet frame or animation specification: ${error.message}`); }
  const expectedWidth = spec.geometry.width * spec.geometry.columns;
  const expectedHeight = spec.geometry.height * spec.geometry.rows;
  if (info.width !== expectedWidth || info.height !== expectedHeight) {
    fail('PET_ATLAS_DIMENSIONS', `图集需要 ${expectedWidth}×${expectedHeight}，实际是 ${info.width}×${info.height}。`, `This pet needs a ${expectedWidth}×${expectedHeight} atlas; this image is ${info.width}×${info.height}.`);
  }
  return info;
}

class PetLibrary {
  constructor(dataPath) {
    this.dataPath = dataPath;
    this.directory = path.join(dataPath, 'pets');
    this.rows = [];
    this.errors = [];
    this.mutations = Promise.resolve();
  }
  folder(id) { return path.join(this.directory, crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24)); }
  serialize(fn) {
    const result = this.mutations.then(fn);
    this.mutations = result.catch(() => {});
    return result;
  }
  async init() { await fs.mkdir(this.directory, { recursive: true }); return this.refresh(); }
  async refresh() {
    const rows = [], errors = [];
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const folder = path.join(this.directory, entry.name);
        const manifest = normalizeManifest(JSON.parse(await fs.readFile(path.join(folder, 'pet.json'), 'utf8')));
        if (this.folder(manifest.id) !== folder) continue;
        const sheet = await fs.readFile(path.join(folder, manifest.spritesheetPath));
        const info = validateAtlas(manifest, imageInfo(sheet));
        let importedAt;
        try { importedAt = JSON.parse(await fs.readFile(path.join(folder, '.library.json'), 'utf8')).importedAt; } catch { importedAt = (await fs.stat(path.join(folder, 'pet.json'))).mtime.toISOString(); }
        rows.push({ id: manifest.id, displayName: manifest.displayName, description: manifest.description, spriteVersionNumber: manifest.spriteVersionNumber, width: info.width, height: info.height, importedAt });
      } catch (error) { errors.push({ folder: entry.name, code: error.code || 'PET_READ_FAILED', message: error.message, enMessage: error.enMessage }); }
    }
    this.rows = rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.errors = errors;
    return this.list();
  }
  list() { return this.rows.map((row) => ({ ...row })); }
  async asset(id) {
    if (!this.rows.some((row) => row.id === id)) fail('PET_NOT_FOUND', '这只宠物已不存在，请刷新宠物库。', 'This pet is no longer available. Refresh the library.');
    const folder = this.folder(id);
    const manifest = normalizeManifest(JSON.parse(await fs.readFile(path.join(folder, 'pet.json'), 'utf8')));
    const bytes = await fs.readFile(path.join(folder, manifest.spritesheetPath));
    const info = validateAtlas(manifest, imageInfo(bytes));
    return { manifest, dataUrl: `data:${info.mimeType};base64,${bytes.toString('base64')}` };
  }
  async put(rawManifest, bytes) {
    return this.serialize(async () => {
      const manifest = normalizeManifest(rawManifest);
      validateAtlas(manifest, imageInfo(bytes));
      await fs.mkdir(this.directory, { recursive: true });
      const staging = await fs.mkdtemp(path.join(this.directory, '.import-'));
      const target = this.folder(manifest.id);
      const backup = `${target}.previous-${crypto.randomUUID()}`;
      let movedOld = false, installed = false;
      try {
        const destination = path.join(staging, manifest.spritesheetPath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
        await fs.writeFile(path.join(staging, 'pet.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        await fs.writeFile(path.join(staging, '.library.json'), JSON.stringify({ importedAt: new Date().toISOString() }));
        try { await fs.rename(target, backup); movedOld = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(staging, target);
        installed = true;
        if (movedOld) await fs.rm(backup, { recursive: true, force: true });
        await this.refresh();
        return manifest.id;
      } catch (error) {
        if (movedOld && !installed) await fs.rename(backup, target).catch(() => {});
        throw error;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    });
  }
  async importDirectory(directory) {
    const imported = [], errors = [];
    const visit = async (folder, depth) => {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === 'pet.json')) {
        try {
          const manifest = normalizeManifest(JSON.parse(await fs.readFile(path.join(folder, 'pet.json'), 'utf8')), path.basename(folder));
          const source = path.join(folder, manifest.spritesheetPath);
          const real = await fs.realpath(source);
          const root = await fs.realpath(folder);
          if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) fail('PET_SHEET_PATH', '图集不在所选宠物目录内。', 'The sprite atlas is outside the selected pet directory.');
          imported.push(await this.put(manifest, await fs.readFile(real)));
        } catch (error) { errors.push({ folder: path.basename(folder), code: error.code || 'PET_IMPORT_FAILED', message: error.message, enMessage: error.enMessage }); }
        return;
      }
      if (depth < 2) for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(path.join(folder, entry.name), depth + 1);
    };
    await visit(directory, 0);
    if (!imported.length && !errors.length) fail('PET_IMPORT_EMPTY', '所选目录中没有找到 pet.json。', 'No pet.json was found in the selected directory.');
    return { imported, errors };
  }
  async importFiles(files) {
    const imported = [], errors = [];
    const entries = (Array.isArray(files) ? files : []).map((file) => ({ ...file, relativePath: String(file.relativePath || file.name || '').replaceAll('\\', '/') }));
    const manifests = entries.filter((file) => path.posix.basename(file.relativePath) === 'pet.json');
    if (!manifests.length) fail('PET_IMPORT_EMPTY', '请选择 pet.json 和对应的 PNG／WebP 图集。', 'Choose pet.json and its PNG or WebP sprite atlas.');
    for (const file of manifests) {
      try {
        const manifest = normalizeManifest(JSON.parse(Buffer.from(file.dataBase64 || '', 'base64').toString('utf8')), path.posix.dirname(file.relativePath) === '.' ? 'pet' : path.posix.basename(path.posix.dirname(file.relativePath)));
        const wanted = path.posix.normalize(path.posix.join(path.posix.dirname(file.relativePath), manifest.spritesheetPath));
        const image = entries.find((item) => item.relativePath === wanted) || (manifests.length === 1 ? entries.find((item) => item.relativePath === manifest.spritesheetPath || item.name === path.posix.basename(manifest.spritesheetPath)) : null);
        if (!image) fail('PET_SHEET_MISSING', `缺少图集 ${manifest.spritesheetPath}。`, `Missing sprite atlas: ${manifest.spritesheetPath}.`);
        imported.push(await this.put(manifest, Buffer.from(image.dataBase64 || '', 'base64')));
      } catch (error) { errors.push({ folder: file.relativePath, code: error.code || 'PET_IMPORT_FAILED', message: error.message, enMessage: error.enMessage }); }
    }
    return { imported, errors };
  }
  async create(input) {
    const bytes = Buffer.from(input.dataBase64 || '', 'base64');
    const info = imageInfo(bytes);
    const manifest = { id: input.id || crypto.randomUUID(), displayName: input.displayName, description: input.description || '', spriteVersionNumber: input.spriteVersionNumber === undefined ? 1 : Number(input.spriteVersionNumber), spritesheetPath: `spritesheet${info.extension}` };
    return this.put(manifest, bytes);
  }
  async remove(id) {
    return this.serialize(async () => {
      if (!this.rows.some((row) => row.id === id)) fail('PET_NOT_FOUND', '这只宠物已不存在。', 'This pet is no longer available.');
      await fs.rm(this.folder(id), { recursive: true, force: true });
      await this.refresh();
    });
  }
  async export(id) {
    const { manifest, dataUrl } = await this.asset(id);
    return { files: [{ name: 'pet.json', dataBase64: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString('base64') }, { name: manifest.spritesheetPath, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) }] };
  }
}

module.exports = { PetLibrary, imageInfo, normalizeManifest, sheetRelativePath, validateAtlas, fail };
