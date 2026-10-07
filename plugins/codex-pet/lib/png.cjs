'use strict';
const { inflateSync, crc32 } = require('node:zlib');

function validatePng(bytes) {
  let offset = 8, header, ended = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('Invalid PNG checksum');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('Invalid PNG header');
      header = bytes.subarray(offset + 8, offset + 8 + length);
    } else if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    else if (type === 'IEND') { ended = length === 0; offset = end; break; }
    offset = end;
  }
  if (!header || !ended || !data.length || offset !== bytes.length) throw new Error('Incomplete PNG image');
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), depth = header[8], color = header[9];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth) || header[10] !== 0 || header[11] !== 0 || header[12] > 1) throw new Error('Invalid PNG encoding');
  const passSize = (w, h) => w > 0 && h > 0 ? h * (Math.ceil(w * channels * depth / 8) + 1) : 0;
  let expected;
  if (header[12] === 0) expected = passSize(width, height);
  else {
    expected = 0;
    for (const [x, y, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) expected += passSize(Math.max(0, Math.ceil((width - x) / dx)), Math.max(0, Math.ceil((height - y) / dy)));
  }
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: Math.min(expected, 256 * 1024 * 1024) });
  if (pixels.length !== expected) throw new Error('Incomplete PNG pixel data');
  return { width, height, mimeType: 'image/png', extension: '.png' };
}
module.exports = { validatePng };
