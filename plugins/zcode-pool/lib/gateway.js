'use strict';
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { conversation } = require('./runtime');
const { redact } = require('./local');
const PORT = 41971;
const ENDPOINT = `http://127.0.0.1:${PORT}/v1`;
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function failure(res, status, message) { json(res, status, { error: { message, type: 'zcode_bridge_error' } }); }
async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('请求正文超过 32 MB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求正文不是有效 JSON'); }
}
function requestWorkspace(req) {
  const encoded = req.headers['x-pi-zcode-workspace'];
  if (typeof encoded !== 'string' || !encoded) throw new Error('请求缺少会话工作目录，请更新主程序并在本地会话中使用 ZCode Pool');
  let context;
  try { context = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new Error('会话工作目录信息无效'); }
  if (context?.version !== 1 || typeof context.sessionId !== 'string' || !context.sessionId.trim()
    || typeof context.path !== 'string' || !path.isAbsolute(context.path) || context.path.includes('\0')) {
    throw new Error('会话工作目录信息无效');
  }
  return { workspacePath: context.path, sessionId: context.sessionId };
}
function usageOf(usage = {}) {
  const number = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  const input = number(usage.inputTokens), output = number(usage.outputTokens);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: number(usage.cacheReadTokens) },
    completion_tokens_details: { reasoning_tokens: number(usage.reasoningTokens) } };
}
async function createGateway(host) {
  const sockets = new Set();
  const controllers = new Set();
  const server = http.createServer((req, res) => { handle(req, res).catch(error => failure(res, 500, redact(error))); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  async function handle(req, res) {
    const pathname = (req.url || '').split('?')[0];
    if (req.method === 'GET' && pathname === '/v1/models') {
      json(res, 200, { object: 'list', data: host.models().filter(model => model.enabled).map(model => ({ id: model.id, object: 'model', owned_by: 'zcode-start-plan' })) });
      return;
    }
    if (req.method !== 'POST' || pathname !== '/v1/chat/completions') { failure(res, 404, '端点不存在'); return; }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { failure(res, 415, '需要 application/json'); return; }
    if (!host.ready()) { failure(res, 503, 'ZCode 桥接尚未就绪，请从插件面板启动'); return; }
    const abort = new AbortController();
    controllers.add(abort);
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', cancel);
    let body, workspace;
    try {
      try {
        body = await requestBody(req);
        workspace = requestWorkspace(req);
        if (!body || typeof body.model !== 'string') throw new Error('缺少 model');
        conversation(body.messages);
        if (body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice !== 'none') throw new Error('ZCode Agent 桥接不支持强制调用 PI 工具');
      } catch (error) { failure(res, 400, redact(error)); return; }
      if (abort.signal.aborted) return;
      if (!host.models().some(model => model.id === body.model && model.enabled)) { failure(res, 404, '模型不存在或已在插件中关闭'); return; }
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      let sentHeaders = false, textSeen = false, reasoning = '';
      function event(data) {
        if (res.destroyed || abort.signal.aborted) return;
        if (!sentHeaders) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          sentHeaders = true;
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
      const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
      try {
        const result = await host.execute({ ...workspace, model: body.model, messages: body.messages, reasoning: body.reasoning_effort || body.reasoning?.effort, signal: abort.signal,
          onDelta: (kind, text) => {
            if (kind === 'text_delta') textSeen ||= text.length > 0;
            else reasoning += text;
            if (body.stream === true) event(chunk(kind === 'text_delta' ? { content: text } : { reasoning_content: text }));
          },
        });
        if (res.destroyed || abort.signal.aborted) return;
        const usage = usageOf(result.usage);
        if (body.stream === true) {
          if (!textSeen && result.text) event(chunk({ content: result.text }));
          event(chunk({}, 'stop', { usage }));
          res.end('data: [DONE]\n\n');
        } else json(res, 200, { id, object: 'chat.completion', created, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }], usage });
      } catch (error) {
        if (res.destroyed || abort.signal.aborted) return;
        const message = redact(error);
        if (sentHeaders) { event({ error: { message, type: 'zcode_bridge_error' } }); res.end('data: [DONE]\n\n'); }
        else failure(res, 502, message);
      }
    } finally {
      controllers.delete(abort);
      res.off('close', cancel);
    }
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.on('error', error => host.onError(redact(error)));
  return {
    async close() {
      for (const controller of controllers) controller.abort();
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
module.exports = { createGateway, ENDPOINT, usageOf };
