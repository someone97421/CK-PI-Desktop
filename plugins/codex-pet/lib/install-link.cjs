'use strict';

const crypto = require('node:crypto');
const { fail, imageInfo } = require('./pet-library.cjs');

function parseInstallLink(value) {
  let link;
  try { link = new URL(String(value || '').trim()); } catch { fail('PET_LINK_INVALID', '请输入有效的 Codex 宠物安装链接。', 'Enter a valid Codex pet installation link.'); }
  if (link.protocol !== 'codex:' || link.hostname !== 'pets' || link.pathname !== '/install') fail('PET_LINK_INVALID', '链接需要以 codex://pets/install 开头。', 'The link must start with codex://pets/install.');
  const name = (link.searchParams.get('name') || '').trim();
  let image;
  try { image = new URL(link.searchParams.get('imageUrl') || ''); } catch { fail('PET_LINK_IMAGE', '安装链接中缺少有效的 HTTPS 图片地址。', 'The installation link needs a valid HTTPS image URL.'); }
  if (!name || image.protocol !== 'https:') fail('PET_LINK_IMAGE', '安装链接需要名称和 HTTPS 图片地址。', 'The installation link needs a name and an HTTPS image URL.');
  const rawVersion = link.searchParams.get('spriteVersionNumber') || '1';
  if (rawVersion !== '1' && rawVersion !== '2') fail('PET_VERSION_UNSUPPORTED', '安装链接只支持图集版本 1 或 2。', 'The installation link supports sprite versions 1 or 2.');
  return { name, imageUrl: image.href, description: link.searchParams.get('description') || '', spriteVersionNumber: Number(rawVersion) };
}

async function importInstallLink(library, value, fetchImage = fetch) {
  const input = parseInstallLink(value);
  const response = await fetchImage(input.imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) fail('PET_LINK_DOWNLOAD', `图片下载失败（HTTP ${response.status}）。`, `Could not download the sprite atlas (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const info = imageInfo(bytes);
  const id = input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `pet-${crypto.createHash('sha256').update(input.name).digest('hex').slice(0, 12)}`;
  return library.put({ id, displayName: input.name, description: input.description, spriteVersionNumber: input.spriteVersionNumber, spritesheetPath: `spritesheet${info.extension}` }, bytes);
}

module.exports = { parseInstallLink, importInstallLink };
