'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail } = require('./pet-library.cjs');

class QuickChat {
  constructor(pi, dataPath) {
    this.pi = pi;
    this.file = path.join(dataPath, 'chat-draft.json');
    this.draft = { text: '', attachments: [], skills: [], modelKey: '' };
    this.pending = null;
    this.sending = null;
    this.writeQueue = Promise.resolve();
    this.receipts = new Map();
  }
  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved.draft && typeof saved.draft.text === 'string') this.draft = { ...this.draft, ...saved.draft };
      this.pending = saved.pending || null;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  getDraft() { return { ...this.draft, attachments: this.draft.attachments.map((item) => ({ ...item })), skills: [...this.draft.skills] }; }
  persist() {
    const json = JSON.stringify({ draft: this.draft, pending: this.pending });
    const task = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.new`;
      await fs.writeFile(temp, json);
      await fs.rename(temp, this.file);
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }
  async saveDraft(input) {
    if (typeof input.text === 'string') this.draft.text = input.text;
    if (Array.isArray(input.attachments)) this.draft.attachments = input.attachments;
    if (Array.isArray(input.skills)) this.draft.skills = input.skills;
    if (typeof input.modelKey === 'string') this.draft.modelKey = input.modelKey;
    delete this.draft.sendError;
    await this.persist();
  }
  invoke(operation, args = []) { return this.pi.desktop.invoke({ operation, args }); }
  async createSession(text, modelKey) {
    const defaults = await this.invoke('settings/get');
    const models = await this.pi.models.list();
    const configuredKey = defaults?.defaultProviderId && defaults?.defaultModelId ? `${defaults.defaultProviderId}/${defaults.defaultModelId}` : null;
    const model = modelKey ? models.find((item) => item.key === modelKey) : models.find((item) => item.key === configuredKey) || models.find((item) => item.isDefault);
    if (modelKey && !model) fail('PET_MODEL_MISSING', '所选模型已不可用，请重新选择。', 'The selected model is no longer available. Choose another model.');
    const input = { title: text.trim().slice(0, 72) || 'Pet chat', mode: ['agent', 'plan', 'goal'].includes(defaults?.defaultMode) ? defaults.defaultMode : 'agent' };
    if (model) {
      input.providerId = model.providerId;
      input.modelId = model.modelId;
      if (model.thinkingLevels?.includes(defaults?.defaultThinkingLevel)) input.thinkingLevel = defaults.defaultThinkingLevel;
    }
    const created = await this.invoke('session/create', [input]);
    const id = created?.session?.id || created?.id || created?.sessionId;
    if (!id) fail('PET_SESSION_CREATE', '宿主没有返回新会话标识。', 'The host did not return the new session ID.');
    return id;
  }
  async checkPending(pending) {
    const result = await this.invoke('session/get', [{ id: pending.sessionId, messageLimit: 100, contentLimit: 1 }]);
    const messages = result?.messages || result?.session?.messages || [];
    return messages.some((message) => message.id === pending.messageId);
  }
  async send(input) {
    const requestId = String(input.requestId || crypto.randomUUID());
    if (this.receipts.has(requestId)) return this.receipts.get(requestId);
    if (this.sending) {
      if (this.sending.requestId === requestId) return this.sending.promise;
      fail('PET_SEND_BUSY', '上一条消息仍在发送中。', 'The previous message is still being sent.');
    }
    const promise = this.performSend(input, requestId);
    this.sending = { requestId, promise };
    try { return await promise; } finally { this.sending = null; }
  }
  async performSend(input, requestId) {
    const text = typeof input.text === 'string' ? input.text : this.draft.text;
    const attachments = Array.isArray(input.attachments) ? input.attachments : this.draft.attachments;
    const skills = Array.isArray(input.skills) ? input.skills : this.draft.skills;
    const modelKey = typeof input.modelKey === 'string' ? input.modelKey : this.draft.modelKey;
    if (!text.trim() && !attachments.length) fail('PET_SEND_EMPTY', '请输入内容或添加附件。', 'Enter a message or add an attachment.');
    const signature = crypto.createHash('sha256').update(JSON.stringify({ text, attachments, skills, modelKey })).digest('hex');
    await this.saveDraft({ text, attachments, skills, modelKey });
    let pending = this.pending;
    try {
      if (pending?.attempted) {
        // 宿主回包丢失时先核对持久化用户消息；不自动再次投递。
        const admitted = await this.checkPending(pending);
        if (admitted && pending.signature === signature) return await this.finish(pending, requestId, text);
        if (admitted) pending = null;
      }
      if (!pending || pending.signature !== signature) {
        let sessionId = this.draft.sessionId;
        if (!modelKey && sessionId) {
          const result = await this.invoke('session/get', [{ id: sessionId, messageLimit: 1, contentLimit: 1 }]);
          if ((result?.session?.id || result?.id) !== sessionId) fail('PET_SESSION_MISSING', '关联会话已删除或不可用，草稿已保留。', 'The linked session was deleted or is unavailable. Your draft was kept.');
        } else {
          sessionId = await this.createSession(text, modelKey);
        }
        pending = { sessionId, messageId: crypto.randomUUID(), requestId, signature, attempted: false };
        this.pending = pending;
        this.draft.sessionId = pending.sessionId;
        await this.persist();
      }
      const staged = [];
      if (attachments.length) {
        const scratch = await this.invoke('session/getScratchPath', [{ sessionId: pending.sessionId }]);
        if (!scratch?.path) fail('PET_SCRATCH_MISSING', '宿主没有返回会话附件目录。', 'The host did not return an attachment directory.');
        const directory = path.join(scratch.path, 'pet-attachments', pending.messageId);
        await fs.mkdir(directory, { recursive: true });
        for (const [index, attachment] of attachments.entries()) {
          const name = path.basename(String(attachment.name || `attachment-${index + 1}`).replaceAll('\\', '/')) || `attachment-${index + 1}`;
          const bytes = Buffer.from(attachment.dataBase64 || '', 'base64');
          const file = path.join(directory, `${index}-${name}`);
          await fs.writeFile(file, bytes);
          const mimeType = String(attachment.mimeType || 'application/octet-stream');
          staged.push({ path: file, name, kind: mimeType.startsWith('image/') ? 'image' : 'file', mimeType, size: bytes.length });
        }
      }
      const commands = skills.map((skill) => typeof skill === 'string' ? skill : skill?.skillId || skill?.id).filter(Boolean).map((id) => `$${String(id).replace(/^skill:/, '')}`);
      const content = [...commands, text].filter(Boolean).join('\n');
      pending.attempted = true;
      this.pending = pending;
      await this.persist();
      const result = await this.invoke('agent/prompt', [{ sessionId: pending.sessionId, content, messageId: pending.messageId, attachments: staged, viewingSessionId: null }]);
      if (result?.accepted === false) {
        pending.attempted = false;
        fail('PET_SEND_REJECTED', '宿主未接受消息，草稿已保留。', 'The host did not accept the message. Your draft was kept.');
      }
      return await this.finish(pending, requestId, text);
    } catch (error) {
      this.draft.sendError = error.message;
      await this.persist();
      throw error;
    }
  }
  async finish(pending, requestId, text) {
    const receipt = { sessionId: pending.sessionId };
    this.receipts.set(requestId, receipt);
    this.receipts.set(pending.requestId, receipt);
    if (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value);
    this.pending = null;
    if (this.draft.text === text) this.draft = { text: '', attachments: [], skills: [], modelKey: this.draft.modelKey, sessionId: pending.sessionId };
    await this.persist();
    return receipt;
  }
  async flush() { await this.writeQueue; }
}

module.exports = { QuickChat };
