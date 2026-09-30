const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadFile } = require('./upload.cjs');
function file(size = 600000) {
  let maximum = 0;
  return { stat:async () => ({ size, mtimeMs:1 }), readRange:async (_path, offset, length) => {
    maximum = Math.max(maximum, length); return { bytes:Buffer.alloc(length, 42), totalSize:size };
  }, maximum:() => maximum };
}
test('分块 multipart 上传并返回可供模型识别的媒体引用', async () => {
  const fs = file();
  const result = await uploadFile(fs, { path:'clip.mp4', expiration:'1h' }, undefined, async (url, options) => {
    assert.equal(url, 'https://litterbox.catbox.moe/resources/internals/api.php');
    const chunks = []; for await (const chunk of options.body) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(body.length, Number(options.headers['Content-Length']));
    assert.match(body.toString(), /name="time"\r\n\r\n1h/);
    assert.match(body.toString(), /name="fileToUpload"; filename="clip.mp4"/);
    return new Response('https://litter.catbox.moe/abcdef.mp4');
  });
  assert.ok(fs.maximum() <= 256 * 1024);
  assert.equal(result.mediaUrl.mimeType, 'video/mp4');
  assert.equal(result.mediaUrl.size, 600000);
});
test('无效有效期、超限和取消都在上传前失败', async () => {
  const noFetch = () => { throw new Error('不应发送请求'); };
  await assert.rejects(uploadFile(file(), {path:'x.mp4', expiration:'2h'}, undefined, noFetch), /有效期/);
  await assert.rejects(uploadFile(file(1_000_000_001), {path:'x.mp4'}, undefined, noFetch), /上限/);
  await assert.rejects(uploadFile(file(), {path:'x.mp4'}, AbortSignal.abort(), noFetch), /abort/i);
});
test('异常响应和重定向地址不能当成成功', async () => {
  for (const body of ['https://evil.example/a.mp4', 'https://litter.catbox.moe/a.mp4?x=1', 'x'.repeat(5000)]) {
    await assert.rejects(uploadFile(file(), {path:'x.mp4'}, undefined, async () => new Response(body)));
  }
});
test('上传期间文件变化会中止', async () => {
  const fs = file(); fs.readRange = async () => ({ bytes:Buffer.alloc(1), totalSize:1 });
  await assert.rejects(uploadFile(fs, {path:'x.mp4'}, undefined, async (_url, options) => {
    for await (const _chunk of options.body) {} return new Response('https://litter.catbox.moe/a.mp4');
  }), /变化/);
});
