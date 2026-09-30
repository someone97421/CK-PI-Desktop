#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { uploadLocalFile } from './upload.cjs';

const httpsUrl = z.string().max(16384).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, '请提供不含账号密码的公网 HTTPS 文件直链。');
const mediaMime = z.string().max(128).regex(/^(image|audio|video)\/[a-z0-9.+-]+$/, '请指定小写图片、音频或视频 MIME 类型。');
const mediaSchema = z.object({
  url: httpsUrl,
  mimeType: mediaMime,
  size: z.number().int().min(0).max(100_000_000).optional(),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000).optional(),
}).strict();
const outputSchema = z.object({
  ok: z.literal(true),
  url: httpsUrl,
  path: z.string().optional(),
  mimeType: z.string(),
  size: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000).optional(),
  mediaUrl: mediaSchema.optional(),
  warning: z.string().optional(),
}).strict();

function result(output) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(output) },
      { type: 'resource_link', uri: output.url, name: output.path ? basename(output.path) : '公网媒体', mimeType: output.mimeType,
        ...(output.size !== undefined ? { size: output.size } : {}),
        description: output.expiresAt ? `临时链接，预计到期 ${new Date(output.expiresAt).toISOString()}` : '公网媒体文件直链' },
    ],
    structuredContent: output,
  };
}
function failure(error) {
  const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
  const message = aborted ? '上传已取消或超时，请检查网络和客户端工具超时设置。' : String(error?.message || error).slice(0, 500);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createServer({ upload = uploadLocalFile, signal } = {}) {
  const server = new McpServer({ name: 'litterbox-mcp-server', version: '0.1.0' });
  server.registerTool('litterbox_upload_file', {
    title: '上传文件到 Litterbox',
    description: '将本地文件上传到 Litterbox，返回公开临时直链、MIME、字节数、到期时间和 resource_link。任何持有链接的人可访问；有效期 1、12、24 或 72 小时，默认 24 小时。100 MB 内的图片、音频、视频额外返回 structuredContent.mediaUrl 供支持的客户端原生理解；更大的文件仅托管。',
    inputSchema: z.object({
      path: z.string().min(1).max(32768).describe('服务运行电脑上的绝对文件路径，例如 E:/Videos/clip.mp4 或 /home/user/clip.mp4。'),
      expiration: z.enum(['1h', '12h', '24h', '72h']).default('24h').describe('公开临时文件保留时长。'),
      mimeType: z.string().max(128).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i).optional().describe('可选 MIME；默认按扩展名推断。'),
    }).strict(),
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    try {
      const combined = signal ? AbortSignal.any([signal, extra.signal]) : extra.signal;
      return result(await upload(args, combined));
    } catch (error) { return failure(error); }
  });
  server.registerTool('litterbox_attach_media_url', {
    title: '附加公网媒体直链',
    description: '将已有公网 HTTPS 图片、音频或视频直链返回为 resource_link 与 structuredContent.mediaUrl，不上传或下载文件。支持的客户端可将媒体交给当前 Gemini 模型获取并理解；其他客户端使用返回的链接。请提供文件直链和 MIME，单次媒体总量限制由模型决定。',
    inputSchema: mediaSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    if (args.expiresAt !== undefined && args.expiresAt <= Date.now()) return failure(new Error('媒体链接已过期，请重新上传原文件或提供新链接。'));
    return result({ ok: true, ...args, mediaUrl: args });
  });
  return server;
}

// 导入模块不会启动服务；stdio 由 MCP 客户端管理，无常驻 HTTP 监听。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Litterbox MCP：node server.mjs\n工具：litterbox_upload_file、litterbox_attach_media_url\n传输：stdio；Node.js >=22.19；无需 API key。\n');
  } else {
    const shutdown = new AbortController();
    const server = createServer({ signal: shutdown.signal });
    const close = () => { shutdown.abort(); void server.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdin.once('end', close);
    try { await server.connect(new StdioServerTransport()); }
    catch (error) { process.stderr.write(`Litterbox MCP 启动失败：${String(error.message || error).slice(0, 300)}\n`); process.exitCode = 1; }
  }
}
