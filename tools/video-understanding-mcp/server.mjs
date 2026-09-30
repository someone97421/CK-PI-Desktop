import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { audioInputSchema, createAnalyzer, inputSchema, publicError, readConfig } from './video.mjs';

const outputSchema = {
  type: 'object',
  required: ['analysis', 'model', 'video_bytes', 'transport', 'finish_reason', 'upload_cleanup'],
  properties: {
    analysis: { type: 'string' },
    analysis_json: {},
    model: { type: 'string' },
    source_type: { type: 'string', enum: ['path', 'base64', 'url'] },
    video_bytes: { type: 'integer' },
    mime_type: { type: 'string' },
    transport: { type: 'string', enum: ['inline', 'files'] },
    finish_reason: { type: 'string' },
    usage: { type: 'object' },
    upload_cleanup: { type: 'string', enum: ['not_needed', 'deleted', 'failed'] },
  },
};

const audioOutputSchema = structuredClone(outputSchema);
audioOutputSchema.required = audioOutputSchema.required.map((key) => key === 'video_bytes' ? 'audio_bytes' : key);
audioOutputSchema.properties.audio_bytes = audioOutputSchema.properties.video_bytes;
delete audioOutputSchema.properties.video_bytes;

try {
  const config = readConfig();
  const analyze = createAnalyzer(config);
  const server = new Server({ name: 'local-video-understanding', version: '0.1.0' }, {
    capabilities: { tools: {} },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'analyze_video',
      description: '使用配置的 Gemini 模型理解视频的画面与声音。提供视频路径、base64 或 HTTP(S) 直链及问题，返回分析文本和用量；视频最多 50 MB，内容将发送到配置的接入点。',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, {
      name: 'analyze_audio',
      description: '按需理解纯音频：语音转写、内容总结、音乐与环境声音分析。提供音频路径、base64 或 HTTP(S) 直链及问题；音频最多 50 MB，内容将发送到配置的 Gemini 接入点。',
      inputSchema: audioInputSchema,
      outputSchema: audioOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!['analyze_video', 'analyze_audio'].includes(request.params.name)) {
      return { isError: true, content: [{ type: 'text', text: '未知工具，仅支持 analyze_video 和 analyze_audio。' }] };
    }
    try {
      const result = await analyze(request.params.arguments, extra.signal, request.params.name === 'analyze_audio' ? 'audio' : 'video');
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: publicError(error, config) }] };
    }
  });
  await server.connect(new StdioServerTransport());
} catch {
  // stdout 专供 MCP 协议；配置错误不回显环境变量或凭据。
  process.stderr.write('媒体 MCP 启动失败：请检查依赖、VIDEO_API_BASE_URL、VIDEO_API_KEY、VIDEO_MODEL_ID 和认证配置。\n');
  process.exitCode = 1;
}
