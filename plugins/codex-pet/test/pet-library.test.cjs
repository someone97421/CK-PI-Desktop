'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { PetLibrary } = require('../lib/pet-library.cjs');
const { parseInstallLink, importInstallLink } = require('../lib/install-link.cjs');
const format = require('../shared/format.js');

function png(width, height) {
  function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const sheets = { 1: png(1536, 1872), 2: png(1536, 2288) };
const file = (name, bytes) => ({ name: path.posix.basename(name), relativePath: name, dataBase64: bytes.toString('base64') });
const jsonFile = (name, manifest) => file(name, Buffer.from(JSON.stringify(manifest)));
async function fixture(t) {
  assert.ok(process.env.PI_SCRATCH_DIR, '测试临时文件必须位于 PI_SCRATCH_DIR');
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, 'pet-library-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = new PetLibrary(path.join(root, 'data')); await library.init();
  return { root, library };
}
async function source(root, name, manifest, bytes) {
  const folder = path.join(root, name); await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'pet.json'), JSON.stringify(manifest));
  if (bytes) {
    const sheet = path.join(folder, manifest.spritesheetPath || 'spritesheet.webp');
    await fs.mkdir(path.dirname(sheet), { recursive: true }); await fs.writeFile(sheet, bytes);
  }
  return folder;
}

test('标准 v1/v2 导入导出保持 manifest、图集及帧规格，可重新导入', async (t) => {
  const { library, root } = await fixture(t);
  for (const version of [1, 2]) {
    const manifest = { id: `透明-${version}`, displayName: `透明宠物 ${version}`, description: '测试生成', spriteVersionNumber: version, spritesheetPath: 'images/sheet.png' };
    const folder = await source(root, `source-${version}`, manifest, sheets[version]);
    assert.deepEqual(await library.importDirectory(folder), { imported: [manifest.id], errors: [] });
    const exported = await library.export(manifest.id);
    assert.deepEqual(JSON.parse(Buffer.from(exported.files[0].dataBase64, 'base64')), manifest);
    assert.equal(exported.files[1].name, 'images/sheet.png');
    assert.deepEqual(Buffer.from(exported.files[1].dataBase64, 'base64'), sheets[version]);
    const other = new PetLibrary(path.join(root, `other-${version}`)); await other.init();
    assert.deepEqual(await other.importFiles(exported.files), { imported: [manifest.id], errors: [] });
    const asset = await other.asset(manifest.id);
    assert.equal(format.makeSpec(asset.manifest).hasLook, version === 2);
    assert.deepEqual(other.list().map(({ width, height }) => [width, height]), [[1536, version === 1 ? 1872 : 2288]]);
  }
});

test('可选 manifest 字段采用默认值，custom frame/animations 保留并按自定义帧播放', async (t) => {
  const { library, root } = await fixture(t);
  const folder = await source(root, 'fallback-id', {}, sheets[1]);
  assert.deepEqual(await library.importDirectory(folder), { imported: ['fallback-id'], errors: [] });
  assert.deepEqual((await library.asset('fallback-id')).manifest, { id: 'fallback-id', displayName: 'fallback-id', description: '', spriteVersionNumber: 1, spritesheetPath: 'spritesheet.webp' });
  const manifest = { id: 'custom', spriteVersionNumber: 2, spritesheetPath: 'tiny.png', frame: { width: 16, height: 24, columns: 2, rows: 2 }, animations: { idle: { frames: [0, 2], fps: 4 }, waving: { frames: [1, 3], fps: 10, loop: false, fallback: 'idle' } } };
  await library.put(manifest, png(32, 48));
  const exported = await library.export('custom');
  const saved = JSON.parse(Buffer.from(exported.files[0].dataBase64, 'base64'));
  assert.deepEqual(saved.frame, manifest.frame); assert.deepEqual(saved.animations, manifest.animations);
  const spec = format.makeSpec(saved);
  assert.deepEqual(format.cellFor(3, spec.geometry), { x: 16, y: 24, width: 16, height: 24 });
  assert.deepEqual(format.frameAt(spec.animations.idle, 250), { index: 2, ended: false });
  assert.deepEqual(format.frameAt(spec.animations.waving, 200), { index: 3, ended: true });
});

test('坏图片和尺寸不符拒绝覆盖，同 id 更新只保留一份，自有副本移除不动原资源', async (t) => {
  const { library, root } = await fixture(t);
  const original = { id: 'same', displayName: '原宠物', spritesheetPath: 'sheet.png' };
  const folder = await source(root, 'source', original, sheets[1]);
  assert.deepEqual(await library.importDirectory(folder), { imported: ['same'], errors: [] });
  const before = await library.export('same');
  await assert.rejects(library.put({ ...original, displayName: '坏图' }, Buffer.from('不是图片')), { code: 'PET_IMAGE_INVALID' });
  await assert.rejects(library.put({ ...original, displayName: '错尺寸' }, sheets[2]), { code: 'PET_ATLAS_DIMENSIONS' });
  assert.deepEqual(await library.export('same'), before);
  await library.put({ ...original, displayName: '更新宠物', spriteVersionNumber: 2 }, sheets[2]);
  assert.equal(library.list().length, 1); assert.equal(library.list()[0].displayName, '更新宠物');
  assert.deepEqual((await fs.readdir(library.directory)), [path.basename(library.folder('same'))]);
  await library.remove('same'); assert.deepEqual(library.list(), []);
  assert.deepEqual(await fs.readFile(path.join(folder, 'sheet.png')), sheets[1]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'pet.json'), 'utf8')), original);
});

test('截断 PNG 不能作为有效图集覆盖已导入宠物', async (t) => {
  const { library } = await fixture(t);
  const manifest = { id: 'intact', spritesheetPath: 'sheet.png' }; await library.put(manifest, sheets[1]);
  const before = await library.export('intact');
  await assert.rejects(library.put(manifest, sheets[1].subarray(0, 24)), { code: 'PET_IMAGE_INVALID' });
  assert.deepEqual(await library.export('intact'), before);
});

test('批量目录及文件导入继续导入完整宠物，并返回缺图 errors', async (t) => {
  const { library, root } = await fixture(t);
  const batch = path.join(root, 'batch');
  await source(batch, 'good', { id: 'directory-good', spritesheetPath: 'sheet.png' }, sheets[1]);
  await source(batch, 'missing', { id: 'directory-missing', spritesheetPath: 'sheet.png' });
  const directories = await library.importDirectory(batch);
  assert.deepEqual(directories.imported, ['directory-good']);
  assert.equal(directories.errors.length, 1); assert.equal(directories.errors[0].folder, 'missing'); assert.equal(directories.errors[0].code, 'ENOENT');
  const files = await library.importFiles([jsonFile('good/pet.json', { id: 'file-good', spritesheetPath: 'sheet.png', spriteVersionNumber: 2 }), file('good/sheet.png', sheets[2]), jsonFile('missing/pet.json', { id: 'file-missing', spritesheetPath: 'sheet.png' })]);
  assert.deepEqual(files.imported, ['file-good']); assert.equal(files.errors.length, 1);
  assert.equal(files.errors[0].folder, 'missing/pet.json'); assert.equal(files.errors[0].code, 'PET_SHEET_MISSING');
  assert.equal(library.list().length, 2);
});

test('安装链接解析 HTTPS、版本、名称，mock fetch 下载后导入', async (t) => {
  const { library } = await fixture(t);
  const link = `codex://pets/install?${new URLSearchParams({ name: '透明 Test Pet', imageUrl: 'https://example.test/sheet.png?token=test', spriteVersionNumber: '2', description: '透明图集' })}`;
  assert.deepEqual(parseInstallLink(link), { name: '透明 Test Pet', imageUrl: 'https://example.test/sheet.png?token=test', spriteVersionNumber: 2, description: '透明图集' });
  assert.equal(parseInstallLink('codex://pets/install?name=Default&imageUrl=https%3A%2F%2Fexample.test%2Fs.png').spriteVersionNumber, 1);
  assert.throws(() => parseInstallLink('codex://pets/install?name=Pet&imageUrl=http%3A%2F%2Fexample.test%2Fs.png'), { code: 'PET_LINK_IMAGE' });
  assert.throws(() => parseInstallLink(link.replace('spriteVersionNumber=2', 'spriteVersionNumber=3')), { code: 'PET_VERSION_UNSUPPORTED' });
  const calls = [];
  const id = await importInstallLink(library, link, async (url, options) => { calls.push({ url, options }); return { ok: true, arrayBuffer: async () => sheets[2] }; });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, parseInstallLink(link).imageUrl); assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(id, 'test-pet'); assert.equal(library.list()[0].displayName, '透明 Test Pet');
  assert.equal((await library.asset(id)).manifest.spriteVersionNumber, 2);
});
