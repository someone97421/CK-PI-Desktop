import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_VIDEO_BYTES, createAnalyzer, loadVideo, publicError,
  readBoundedResponse, readConfig, validateInput,
} from './video.mjs';

const config = () => readConfig({ VIDEO_API_KEY: 'test-secret', VIDEO_MODEL_ID: 'test-model' });
const args = (extra = {}) => ({ question: '总结视频', base64: 'YWJj', mime_type: 'video/mp4', ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const answer = () => json({
  candidates: [{ content: { parts: [{ text: '内部思考', thought: true }, { text: '视频分析' }] }, finishReason: 'STOP' }],
  usageMetadata: { totalTokenCount: 12 },
});

test('配置支持自定义路径、v1、Bearer 和无认证', () => {
  const value = readConfig({ VIDEO_API_BASE_URL: 'http://localhost:8000/gemini/v1/', VIDEO_API_AUTH: 'none', VIDEO_MODEL_ID: 'models/custom-model' });
  assert.equal(value.root, 'http://localhost:8000/gemini');
  assert.equal(value.version, 'v1');
  assert.equal(value.model, 'custom-model');
  assert.equal(readConfig({ VIDEO_API_AUTH: 'bearer', VIDEO_API_KEY: 'key', VIDEO_MODEL_ID: 'm' }).auth, 'bearer');
  assert.throws(() => readConfig({}), /VIDEO_MODEL_ID/);
  assert.throws(() => readConfig({ VIDEO_MODEL_ID: 'm' }), /VIDEO_API_KEY/);
  assert.throws(() => readConfig({ VIDEO_MODEL_ID: 'm', VIDEO_API_AUTH: 'none', VIDEO_TIMEOUT_SECONDS: '0' }), /VIDEO_TIMEOUT_SECONDS/);
});

test('输入三选一、未知参数和数值边界', () => {
  validateInput(args({ fps: 1, start_seconds: 1, end_seconds: 2 }));
  assert.throws(() => validateInput(args({ path: 'clip.mp4' })), /只能/);
  assert.throws(() => validateInput(args({ base64: 123 })), /字符串/);
  assert.throws(() => validateInput(args({ question: ' ' })), /question/);
  assert.throws(() => validateInput(args({ fps: 25 })), /fps/);
  assert.throws(() => validateInput(args({ start_seconds: 2, end_seconds: 1 })), /end_seconds/);
  assert.throws(() => validateInput(args({ max_output_tokens: 1.5 })), /整数/);
  assert.throws(() => validateInput(args({ api_key: 'not-allowed' })), /不支持参数/);
});

test('支持标准 base64 与 data URL，拒绝损坏编码', async () => {
  const result = await loadVideo(args({ base64: 'data:video/mp4;base64,YWJj', mime_type: undefined }));
  assert.equal(result.data.toString(), 'abc');
  assert.equal(result.mime, 'video/mp4');
  for (const base64 of ['abc', 'YWJj\n', '====', 'YR==', '']) {
    await assert.rejects(loadVideo(args({ base64 })));
  }
});

test('大段 base64 不使用递归正则，仍受解码大小约束', async () => {
  const base64 = Buffer.alloc(2_000_000, 1).toString('base64');
  assert.equal((await loadVideo(args({ base64 }))).data.length, 2_000_000);
  await assert.rejects(loadVideo(args({ base64: 'A'.repeat(66_666_800) })), /50 MB/);
});

test('本地文件读取和扩展名推断', async () => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'video-mcp-test-'));
  try {
    const path = join(dir, 'clip.mp4');
    await writeFile(path, Buffer.from('video'));
    const result = await loadVideo({ path });
    assert.equal(result.mime, 'video/mp4');
    assert.equal(result.data.toString(), 'video');
    await assert.rejects(loadVideo({ path: dir }), /普通视频文件/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('URL 下载无 API Key，支持响应 MIME', async () => {
  const result = await loadVideo({ url: 'https://video.example/clip' }, undefined, async (url, options) => {
    assert.equal(url.href, 'https://video.example/clip');
    assert.equal(options.headers, undefined);
    return new Response('video', { headers: { 'content-type': 'video/webm' } });
  });
  assert.equal(result.mime, 'video/webm');
  await assert.rejects(loadVideo({ url: 'file:///clip.mp4' }), /HTTP/);
});

test('下载在 Content-Length 和实际流量两个层面限额', async () => {
  await assert.rejects(readBoundedResponse(new Response('x', { headers: { 'content-length': String(MAX_VIDEO_BYTES + 1) } }), MAX_VIDEO_BYTES), /上限/);
  await assert.rejects(readBoundedResponse(new Response('1234'), 3), /上限/);
  assert.equal((await readBoundedResponse(new Response('123'), 3)).toString(), '123');
});

test('inline 请求包含视频元数据、JSON 模式和输出预算', async () => {
  const analyze = createAnalyzer(config(), async (url, options) => {
    assert.match(url, /\/v1beta\/models\/test-model:generateContent$/);
    assert.equal(options.headers['x-goog-api-key'], 'test-secret');
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].inlineData.data, 'YWJj');
    assert.deepEqual(body.contents[0].parts[0].videoMetadata, { startOffset: '1s', endOffset: '2s', fps: 2 });
    assert.equal(body.generationConfig.maxOutputTokens, 100);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    return json({ candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] }, finishReason: 'STOP' }] });
  });
  const result = await analyze(args({ start_seconds: 1, end_seconds: 2, fps: 2, response_format: 'json', max_output_tokens: 100 }));
  assert.deepEqual(result.analysis_json, { summary: 'ok' });
  assert.equal(result.transport, 'inline');
});

test('Files API 上传、分析、清理，不向上传 URL 附加 Key', async () => {
  const calls = [];
  const analyze = createAnalyzer(config(), async (url, options) => {
    calls.push(url);
    if (url.endsWith('/upload/v1beta/files')) return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
    if (url === 'https://upload.example/session') {
      assert.equal(options.headers['x-goog-api-key'], undefined);
      return json({ file: { name: 'files/test', state: 'ACTIVE', uri: 'https://files.example/test' } });
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].fileData.fileUri, 'https://files.example/test');
    return answer();
  });
  const result = await analyze(args({ transport: 'files' }));
  assert.equal(result.analysis, '视频分析');
  assert.equal(result.upload_cleanup, 'deleted');
  assert.equal(calls.length, 4);
});

test('模型失败仍清理上传文件，并可继续下一次调用', async () => {
  let deleted = 0;
  const analyze = createAnalyzer(config(), async (url, options) => {
    if (url.endsWith('/upload/v1beta/files')) return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
    if (url === 'https://upload.example/session') return json({ file: { name: 'files/test', state: 'ACTIVE', uri: 'https://files.example/test' } });
    if (options.method === 'DELETE') { deleted++; return new Response(null, { status: 204 }); }
    return json({ error: { message: 'test-secret' } }, 400);
  });
  await assert.rejects(analyze(args({ transport: 'files' })), /HTTP 400/);
  assert.equal(deleted, 1);
  await assert.rejects(analyze(args()), /HTTP 400/);
  assert.equal(publicError(new Error('key=test-secret'), config()), 'key=[REDACTED]');
});

test('取消释放任务占用；同时调用得到明确错误', async () => {
  let notify;
  const entered = new Promise((resolve) => { notify = resolve; });
  const analyze = createAnalyzer(config(), async (_url, options) => {
    notify();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const first = analyze(args(), controller.signal);
  await entered;
  await assert.rejects(analyze(args()), /已有/);
  controller.abort();
  await assert.rejects(first, /取消/);
});

test('音频参数独立，拒绝视频 MIME 与采样参数', () => {
  const audio = args({ mime_type: 'audio/mp3' });
  validateInput(audio, 'audio');
  for (const extra of [{ fps: 1 }, { start_seconds: 1 }, { end_seconds: 2 }, { mime_type: 'video/mp4' }]) {
    assert.throws(() => validateInput({ ...audio, ...extra }, 'audio'));
  }
  assert.throws(() => validateInput(audio), /mime_type/);
});

test('音频支持 data URL 和直链 MIME 推断', async () => {
  const data = await loadVideo({ base64: 'data:audio/wav;base64,YWJj' }, undefined, undefined, 'audio');
  assert.equal(data.mime, 'audio/wav');
  assert.equal(data.data.toString(), 'abc');
  const remote = await loadVideo({ url: 'https://audio.example/clip.flac' }, undefined,
    async () => new Response('audio', { headers: { 'content-type': 'application/octet-stream' } }), 'audio');
  assert.equal(remote.mime, 'audio/flac');
});

test('音频本地路径推断及 inline 请求不含视频元数据', async () => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'audio-mcp-test-'));
  try {
    const path = join(dir, 'clip.mp3');
    await writeFile(path, Buffer.from('audio'));
    const analyze = createAnalyzer(config(), async (_url, options) => {
      const part = JSON.parse(options.body).contents[0].parts[0];
      assert.equal(part.inlineData.mimeType, 'audio/mp3');
      assert.equal(part.videoMetadata, undefined);
      return answer();
    });
    const result = await analyze({ path, question: '转写录音' }, undefined, 'audio');
    assert.equal(result.audio_bytes, 5);
    assert.equal(result.video_bytes, undefined);
    assert.equal(result.analysis, '视频分析');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('音频 Files 上传、分析和清理', async () => {
  let deleted = false;
  const analyze = createAnalyzer(config(), async (url, options) => {
    if (url.endsWith('/upload/v1beta/files')) {
      assert.equal(JSON.parse(options.body).file.display_name, 'mcp-audio');
      assert.equal(options.headers['x-goog-upload-header-content-type'], 'audio/ogg');
      return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
    }
    if (url === 'https://upload.example/session') return json({ file: { name: 'files/audio', state: 'ACTIVE', uri: 'https://files.example/audio' } });
    if (options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    const part = JSON.parse(options.body).contents[0].parts[0];
    assert.equal(part.fileData.mimeType, 'audio/ogg');
    assert.equal(part.videoMetadata, undefined);
    return answer();
  });
  const result = await analyze(args({ mime_type: 'audio/ogg', transport: 'files' }), undefined, 'audio');
  assert.equal(result.audio_bytes, 3);
  assert.equal(result.upload_cleanup, 'deleted');
  assert.equal(deleted, true);
});
