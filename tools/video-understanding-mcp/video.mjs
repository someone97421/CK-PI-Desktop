import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_VIDEO_BYTES = 50_000_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const INLINE_THRESHOLD = 10_000_000;
const MIME_TYPES = new Set([
  'video/mp4', 'video/mpeg', 'video/quicktime', 'video/avi',
  'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp',
]);
const EXTENSIONS = {
  '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpg',
  '.mov': 'video/quicktime', '.avi': 'video/avi', '.flv': 'video/x-flv',
  '.webm': 'video/webm', '.wmv': 'video/wmv', '.3gp': 'video/3gpp',
};

export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  oneOf: [
    { required: ['path'] }, { required: ['base64'] }, { required: ['url'] },
  ],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 20000, description: '视频分析问题。' },
    path: { type: 'string', minLength: 1, description: 'MCP 所在机器上的视频绝对路径；与 base64、url 三选一。' },
    base64: { type: 'string', minLength: 1, maxLength: 66666800, description: '视频标准 base64 或 data:video/...;base64,...；解码后最多 50 MB。优先用本地路径，避免大段编码占用对话。' },
    url: { type: 'string', minLength: 1, description: 'HTTP(S) 视频直链，先下载再检查大小；不是网页或播放列表。' },
    mime_type: { type: 'string', enum: [...MIME_TYPES], description: '视频 MIME 类型。纯 base64 必填；路径和 URL 可从扩展名或响应推断。' },
    transport: { type: 'string', enum: ['auto', 'inline', 'files'], description: 'auto: 10 MB 内 inline base64，否则 Files API；inline 适合仅支持 generateContent 的中转。' },
    start_seconds: { type: 'number', minimum: 0, description: '分析片段起点，秒；发送原视频，由模型按元数据裁剪。' },
    end_seconds: { type: 'number', exclusiveMinimum: 0, description: '分析片段终点，必须大于起点。' },
    fps: { type: 'number', exclusiveMinimum: 0, maximum: 24, description: '画面采样率，范围 (0,24]；不填使用提供商默认值。' },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    max_output_tokens: { type: 'integer', minimum: 1, maximum: 65536 },
    response_format: { type: 'string', enum: ['text', 'json'], description: 'json 使用 Gemini application/json 响应模式。' },
  },
};

const AUDIO_MIME_TYPES = new Set([
  'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
]);
const AUDIO_EXTENSIONS = {
  '.wav': 'audio/wav', '.mp3': 'audio/mp3', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac',
};
export const audioInputSchema = structuredClone(inputSchema);
for (const key of ['start_seconds', 'end_seconds', 'fps']) delete audioInputSchema.properties[key];
for (const property of Object.values(audioInputSchema.properties)) {
  if (property.description) property.description = property.description.replaceAll('视频', '音频').replaceAll('data:video/', 'data:audio/');
}
audioInputSchema.properties.mime_type.enum = [...AUDIO_MIME_TYPES];

function mediaProfile(kind) {
  if (kind === 'video') return { label: '视频', schema: inputSchema, mimes: MIME_TYPES, extensions: EXTENSIONS };
  if (kind === 'audio') return { label: '音频', schema: audioInputSchema, mimes: AUDIO_MIME_TYPES, extensions: AUDIO_EXTENSIONS };
  throw new Error('不支持的媒体类型。');
}

function numberInRange(value, name, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} 必须在 ${min} 到 ${max} 之间${integer ? '且为整数' : ''}。`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const base = new URL(env.VIDEO_API_BASE_URL || 'https://generativelanguage.googleapis.com');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('VIDEO_API_BASE_URL 必须是无凭据、查询参数和片段的 HTTP(S) 地址。');
  }
  // 接入点可带中转路径和 /v1beta 或 /v1，上传接口复用相同路径前缀。
  const root = base.href.replace(/\/+$/, '').replace(/\/v1(?:beta)?$/, '');
  const version = /\/v1$/.test(base.pathname.replace(/\/+$/, '')) ? 'v1' : 'v1beta';
  const auth = env.VIDEO_API_AUTH || 'x-goog-api-key';
  if (!['x-goog-api-key', 'bearer', 'none'].includes(auth)) throw new Error('VIDEO_API_AUTH 仅支持 x-goog-api-key、bearer、none。');
  const apiKey = env.VIDEO_API_KEY || '';
  const model = (env.VIDEO_MODEL_ID || '').replace(/^models\//, '');
  if (!model.trim()) throw new Error('请通过 VIDEO_MODEL_ID 配置模型 ID（可带 models/ 前缀）。');
  if (auth !== 'none' && !apiKey) throw new Error('请通过 VIDEO_API_KEY 配置 Key，或显式设置 VIDEO_API_AUTH=none。');
  const transport = env.VIDEO_TRANSPORT || 'auto';
  if (!['auto', 'inline', 'files'].includes(transport)) throw new Error('VIDEO_TRANSPORT 仅支持 auto、inline、files。');
  return {
    root, version, auth, apiKey, model, transport,
    timeoutMs: numberInRange(Number(env.VIDEO_TIMEOUT_SECONDS || 600), 'VIDEO_TIMEOUT_SECONDS', 1, 1800) * 1000,
    outputTokens: numberInRange(Number(env.VIDEO_MAX_OUTPUT_TOKENS || 4096), 'VIDEO_MAX_OUTPUT_TOKENS', 1, 65536, true),
  };
}

export function validateInput(args, kind = 'video') {
  const schema = mediaProfile(kind).schema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象。');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`不支持参数 ${key}。`);
  }
  for (const key of ['path', 'base64', 'url']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].length)) throw new Error(`${key} 必须是非空字符串。`);
  }
  if (['path', 'base64', 'url'].filter((key) => args[key] !== undefined).length !== 1) throw new Error('path、base64、url 必须且只能提供一个。');
  if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 20000) throw new Error('question 必须是 1 到 20000 字符的非空问题。');
  for (const key of ['transport', 'response_format', 'mime_type']) {
    if (args[key] !== undefined && !schema.properties[key].enum.includes(args[key])) throw new Error(`${key} 不在支持范围内。`);
  }
  for (const [key, min, max, integer] of [
    ['start_seconds', 0, Number.MAX_SAFE_INTEGER, false],
    ['end_seconds', Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, false],
    ['fps', Number.MIN_VALUE, 24, false], ['temperature', 0, 2, false],
    ['max_output_tokens', 1, 65536, true],
  ]) {
    if (args[key] !== undefined) numberInRange(args[key], key, min, max, integer);
  }
  if (args.end_seconds !== undefined && args.end_seconds <= (args.start_seconds || 0)) throw new Error('end_seconds 必须大于 start_seconds。');
}

function checkSize(size, kind) {
  const { label } = mediaProfile(kind);
  if (!size || size > MAX_VIDEO_BYTES) throw new Error(`${label}必须非空且不超过 50 MB（50,000,000 字节）；请先裁剪或压缩${label}。`);
}

function resolveMime(explicit, inferred, source = '', kind = 'video') {
  const { label, mimes, extensions } = mediaProfile(kind);
  const mime = explicit || inferred?.split(';')[0].trim().toLowerCase() || extensions[extname(source).toLowerCase()];
  if (!mimes.has(mime)) throw new Error(`无法识别支持的${label}类型，请设置 mime_type 或使用${label}文件直链。`);
  return mime;
}

export async function readBoundedResponse(response, limit, signal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel();
    throw new Error(`响应超过 ${limit} 字节上限。`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`响应超过 ${limit} 字节上限。`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function loadVideo(args, signal, fetchImpl = fetch, kind = 'video') {
  const { label, mimes } = mediaProfile(kind);
  if (args.base64 !== undefined) {
    const encoded = args.base64;
    if (encoded.length > inputSchema.properties.base64.maxLength) throw new Error('base64 输入超过 50 MB 解码大小边界。');
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(encoded);
    const raw = match ? match[2] : encoded;
    const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
    if (raw.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(raw) || raw.slice(0, raw.length - padding).includes('=')) {
      throw new Error('base64 必须是标准、完整编码（包含必要的 = 填充），不支持空白或 URL-safe 编码。');
    }
    const data = Buffer.from(raw, 'base64');
    checkSize(data.length, kind);
    if (data.toString('base64') !== raw) throw new Error('base64 编码不规范。');
    return { data, mime: resolveMime(args.mime_type, match?.[1], '', kind), sourceType: 'base64' };
  }
  if (args.path !== undefined) {
    const file = await open(args.path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`path 必须指向普通${label}文件。`);
      checkSize(stat.size, kind);
      const mime = resolveMime(args.mime_type, undefined, args.path, kind);
      // 多读一个字节，文件在读取时增长也不会突破内存边界。
      const data = Buffer.alloc(Math.min(stat.size + 1, MAX_VIDEO_BYTES + 1));
      let offset = 0;
      while (offset < data.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(data, offset, data.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) throw new Error(`${label}在读取时发生变化，请等文件写入完成后重试。`);
      checkSize(offset, kind);
      return { data: data.subarray(0, offset), mime, sourceType: 'path' };
    } finally {
      await file.close();
    }
  }
  const url = new URL(args.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`url 仅支持 HTTP(S) ${label}直链。`);
  const response = await fetchImpl(url, { signal, redirect: 'follow' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${label}下载失败（HTTP ${response.status}）。`);
  }
  const data = await readBoundedResponse(response, MAX_VIDEO_BYTES, signal);
  checkSize(data.length, kind);
  const header = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const mime = resolveMime(args.mime_type, mimes.has(header) ? header : undefined, new URL(response.url || url).pathname, kind);
  return { data, mime, sourceType: 'url' };
}

function headers(config, extra = {}) {
  return {
    ...(config.auth === 'x-goog-api-key' ? { 'x-goog-api-key': config.apiKey } : {}),
    ...(config.auth === 'bearer' ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...extra,
  };
}

async function jsonResponse(response, signal) {
  const data = await readBoundedResponse(response, MAX_RESPONSE_BYTES, signal);
  if (!response.ok) throw new Error(`Gemini 接口失败（HTTP ${response.status}）；请检查接入点、认证、模型和传输模式。`);
  try { return JSON.parse(data.toString('utf8')); }
  catch { throw new Error('Gemini 接口未返回有效 JSON，请确认接入点支持 Gemini 原生 API。'); }
}

function fileName(value) {
  if (typeof value !== 'string' || !/^files\/[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Files API 返回无效文件名称。');
  return value;
}

export function createAnalyzer(config, fetchImpl = fetch) {
  let busy = false;
  return async (args, callerSignal, kind = 'video') => {
    const { label } = mediaProfile(kind);
    validateInput(args, kind);
    if (busy) throw new Error('当前已有媒体分析任务，请等待完成后重试。');
    busy = true;
    const signal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(callerSignal ? [callerSignal] : [])]);
    let uploadedName;
    let cleanupStatus = 'not_needed';
    let result;
    try {
      const video = await loadVideo(args, signal, fetchImpl, kind);
      const requested = args.transport || config.transport;
      const transport = requested === 'auto' ? (video.data.length <= INLINE_THRESHOLD ? 'inline' : 'files') : requested;
      let part;
      if (transport === 'inline') {
        part = { inlineData: { mimeType: video.mime, data: video.data.toString('base64') } };
      } else {
        const init = await fetchImpl(`${config.root}/upload/${config.version}/files`, {
          method: 'POST', signal, redirect: 'error',
          headers: headers(config, {
            'content-type': 'application/json', 'x-goog-upload-protocol': 'resumable',
            'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': String(video.data.length),
            'x-goog-upload-header-content-type': video.mime,
          }),
          body: JSON.stringify({ file: { display_name: `mcp-${kind}` } }),
        });
        if (!init.ok) await jsonResponse(init, signal);
        const uploadUrl = init.headers.get('x-goog-upload-url');
        await init.body?.cancel();
        if (!uploadUrl || !['http:', 'https:'].includes(new URL(uploadUrl).protocol)) throw new Error('Files API 未返回有效上传 URL；中转可能只支持 inline 模式。');
        // 上传 URL 自带会话凭据，不向它附加配置的 API Key。
        const uploaded = await jsonResponse(await fetchImpl(uploadUrl, {
          method: 'POST', signal, redirect: 'error',
          headers: { 'content-type': video.mime, 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' },
          body: video.data,
        }), signal);
        let file = uploaded.file;
        uploadedName = fileName(file?.name);
        while (file?.state === 'PROCESSING') {
          await sleep(2000, undefined, { signal });
          file = await jsonResponse(await fetchImpl(`${config.root}/${config.version}/${uploadedName}`, {
            headers: headers(config), signal, redirect: 'error',
          }), signal);
        }
        if (file?.state !== 'ACTIVE' || typeof file.uri !== 'string') throw new Error(`${label}处理未成功进入 ACTIVE 状态。`);
        part = { fileData: { mimeType: video.mime, fileUri: file.uri } };
      }
      const metadata = {};
      if (args.start_seconds !== undefined) metadata.startOffset = `${args.start_seconds.toFixed(9).replace(/\.?0+$/, '')}s`;
      if (args.end_seconds !== undefined) metadata.endOffset = `${args.end_seconds.toFixed(9).replace(/\.?0+$/, '')}s`;
      if (args.fps !== undefined) metadata.fps = args.fps;
      if (kind === 'video' && Object.keys(metadata).length) part.videoMetadata = metadata;
      const generationConfig = { maxOutputTokens: args.max_output_tokens ?? config.outputTokens };
      if (args.temperature !== undefined) generationConfig.temperature = args.temperature;
      if (args.response_format === 'json') generationConfig.responseMimeType = 'application/json';
      const response = await jsonResponse(await fetchImpl(`${config.root}/${config.version}/models/${encodeURIComponent(config.model)}:generateContent`, {
        method: 'POST', signal, redirect: 'error',
        headers: headers(config, { 'content-type': 'application/json' }),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [part, { text: args.question }] }], generationConfig }),
      }), signal);
      const candidate = response.candidates?.[0];
      const text = (candidate?.content?.parts || []).filter((item) => typeof item.text === 'string' && !item.thought).map((item) => item.text).join('\n');
      if (!text.trim()) throw new Error(`模型没有返回分析文本（${response.promptFeedback?.blockReason || candidate?.finishReason || 'empty'}）。`);
      result = {
        analysis: text, model: config.model, source_type: video.sourceType,
        [kind === 'audio' ? 'audio_bytes' : 'video_bytes']: video.data.length, mime_type: video.mime, transport,
        finish_reason: candidate.finishReason || 'UNKNOWN', usage: response.usageMetadata || {},
      };
      if (args.response_format === 'json') {
        try { result.analysis_json = JSON.parse(text); }
        catch { throw new Error('模型未遵循 JSON 响应格式，请重试或使用 text。'); }
      }
    } catch (error) {
      if (signal.aborted) throw new Error(callerSignal?.aborted ? `${label}分析已取消。` : `${label}分析超过 ${config.timeoutMs / 1000} 秒，请缩短${label}或提高超时配置。`);
      throw error;
    } finally {
      if (uploadedName) {
        try {
          const response = await fetchImpl(`${config.root}/${config.version}/${uploadedName}`, {
            method: 'DELETE', headers: headers(config), signal: AbortSignal.timeout(15000), redirect: 'error',
          });
          cleanupStatus = response.ok || response.status === 404 ? 'deleted' : 'failed';
          await response.body?.cancel();
        } catch { cleanupStatus = 'failed'; }
        if (cleanupStatus === 'failed') process.stderr.write(`${label}上传文件清理失败：${uploadedName}\n`);
      }
      busy = false;
    }
    result.upload_cleanup = cleanupStatus;
    return result;
  };
}

export function publicError(error, config) {
  let message = error instanceof Error ? error.message : '视频分析失败。';
  if (config.apiKey) message = message.replaceAll(config.apiKey, '[REDACTED]');
  return message.slice(0, 2000);
}
