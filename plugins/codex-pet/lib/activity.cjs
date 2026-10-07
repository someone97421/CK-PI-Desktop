'use strict';

const PRIORITY = { 'needs-input': 0, blocked: 1, ready: 2, running: 3 };
const MAX_SUBSCRIPTIONS = 16;
const CONCURRENCY = 4;
const FALLBACK_BATCH = 8;
const STATUS_BATCH = 16;
const short = (value) => String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
const OUTPUT_LIMIT = 240;
const OUTPUT_TTL = 12000;
const messageText = (message) => message?.role === 'assistant' && typeof message.content === 'string' ? message.content.slice(-OUTPUT_LIMIT).trim() : '';
const now = () => new Date().toISOString();
const runningStatus = (status) => ['running', 'starting', 'busy', 'waiting', 'awaiting_approval', 'awaiting_input', 'awaiting_permission', 'waiting_approval', 'waiting_input', 'waiting_permission'].includes(status);

async function bounded(values, action) {
  let next = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (next < values.length) {
      const value = values[next++];
      try { await action(value); } catch (error) { errors.push(error); }
    }
  }));
  if (errors.length) throw errors[0];
}

/** 活动保留简短状态与当前轮最近一条模型正文的末尾片段。
 * 结束状态仍以最新持久化未读通知为准，旧轮次不会覆盖当前轮状态。
 */
class ActivityMonitor {
  constructor(pi, { pollSeconds = 8, onChange = () => {} } = {}) {
    this.pi = pi;
    this.onChange = onChange;
    this.pollSeconds = 8;
    this.setPollSeconds(pollSeconds);
    this._active = false;
    this._epoch = 0;
    this._sessions = new Map();
    this._live = new Map();
    this._subscriptions = new Map();
    this._notifications = [];
    this._state = { rows: [], state: null, updatedAt: null, stale: false, error: null };
    this._output = null;
    this._statusQueue = [];
    this._statusCandidates = new Set();
    this._fallbackCursor = 0;
    this._listener = (frame) => this._event(frame);
    this._requestCount = 0;
    this._requestQueue = [];
  }

  async start() {
    if (this._stopping) await this._stopping;
    if (this._active) return this.refresh();
    this._active = true;
    this._epoch++;
    this.pi.events.on('desktop:event', this._listener);
    this._schedule();
    return this.refresh();
  }

  stop() {
    if (this._stopping) return this._stopping;
    this._active = false;
    this._epoch++;
    clearTimeout(this._timer);
    clearTimeout(this._hintTimer);
    this._timer = this._hintTimer = null;
    this.pi.events.off('desktop:event', this._listener);
    this._stopping = (async () => {
      if (this._refreshing) await this._refreshing;
      await bounded([...this._subscriptions], async ([sessionId, id]) => {
        await this._desktop('unsubscribe', id);
        this._subscriptions.delete(sessionId);
      });
      this._live.clear();
      this._sessions.clear();
      this._notifications = [];
      this._output = null;
      this._statusQueue = [];
      this._statusCandidates.clear();
    })().finally(() => { this._stopping = null; });
    return this._stopping;
  }

  setPollSeconds(n) {
    if (!Number.isFinite(n) || n <= 0) throw new RangeError('pollSeconds 必须为正数');
    this.pollSeconds = n;
    if (this._active) this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    if (!this._active) return;
    this._timer = setTimeout(async () => {
      await this.refresh();
      if (this._active) this._schedule();
    }, this.pollSeconds * 1000);
    this._timer.unref?.();
  }

  getState() {
    const output = this._output && this._output.expiresAt > Date.now() && this._sessions.has(this._output.sessionId) ? { ...this._output, title: short(this._sessions.get(this._output.sessionId)?.title || '未命名会话') } : null;
    return { ...this._state, output, rows: this._state.rows.map((row) => ({ ...row })) };
  }

  _publish(stale = false, error = null) {
    if (!this._active) return;
    if (stale) {
      this._state = { ...this._state, stale: true, error: short(error?.message || error) };
    } else {
      const latest = new Map();
      const unread = new Map();
      for (const note of this._notifications) {
        if (!latest.has(note.sessionId) || String(note.createdAt) > String(latest.get(note.sessionId).createdAt)) latest.set(note.sessionId, note);
        if (!note.readAt) unread.set(note.sessionId, (unread.get(note.sessionId) || 0) + 1);
      }
      const rows = [];
      for (const sessionId of new Set([...this._sessions.keys(), ...this._live.keys(), ...latest.keys()])) {
        const session = this._sessions.get(sessionId);
        const live = this._live.get(sessionId);
        const note = latest.get(sessionId);
        const pendingCount = live ? live.approvals.size + live.inputs.size + live.extraPending : 0;
        const queuedCount = live?.queuedCount || 0;
        let state, detail;
        if (pendingCount) {
          state = 'needs-input'; detail = `等待处理 ${pendingCount} 件`;
        } else if (live?.running || (!live && (this._isRunning(session) || this._statusCandidates.has(sessionId)))) {
          state = 'running'; detail = live?.tool ? `正在使用 ${live.tool}` : '正在运行';
        } else if (note && !note.readAt && (!live?.turnId || note.turnId === live.turnId || (live.startedAt && String(note.createdAt) >= live.startedAt)) && (!live?.startedAt || String(note.createdAt) >= live.startedAt)) {
          state = note.kind === 'task.failed' ? 'blocked' : note.kind === 'task.completed' ? 'ready' : null;
          detail = state === 'blocked' ? `任务失败${note.errorCode ? `：${short(note.errorCode)}` : ''}` : '任务已完成';
        }
        if (!state) continue;
        rows.push({ sessionId, title: short(session?.title || note?.sessionTitle || '未命名会话'), state, detail,
          updatedAt: live?.updatedAt || note?.createdAt || session?.updatedAt || now(), pendingCount, queuedCount, unreadCount: unread.get(sessionId) || 0, tool: live?.tool || null, errorCode: note?.errorCode ? short(note.errorCode) : null });
      }
      rows.sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.sessionId.localeCompare(b.sessionId));
      this._state = { rows, state: rows[0]?.state || null, updatedAt: now(), stale: false, error: null };
    }
    this.onChange(this.getState());
  }

  _captureOutput(sessionId, live, message, at) {
    if (message?.parentToolCallId || message?.role !== 'assistant' || typeof message.content !== 'string') return;
    const content = message.content.slice(-OUTPUT_LIMIT);
    if (live.outputMessageId === message.id && live.outputContent === content) return;
    live.outputMessageId = message.id;
    live.outputContent = content;
    const text = messageText(message);
    if (!text) {
      if (this._output?.sessionId === sessionId && this._output.messageId === message.id) this._output = null;
      return;
    }
    this._output = { sessionId, messageId: message.id, text, updatedAt: at, expiresAt: Date.now() + OUTPUT_TTL };
  }

  async _desktop(method, input, epoch) {
    if (this._requestCount >= CONCURRENCY) await new Promise((resolve) => this._requestQueue.push(resolve));
    else this._requestCount++;
    try {
      if (epoch != null && !this._alive(epoch)) return null;
      return await this.pi.desktop[method](input);
    } finally {
      const next = this._requestQueue.shift();
      if (next) next();
      else this._requestCount--;
    }
  }

  _invoke(operation, args = []) { return this._desktop('invoke', { operation, args }); }
  _isRunning(session) { return session?.running === true || session?.isRunning === true || runningStatus(session?.status); }
  _alive(epoch) { return this._active && this._epoch === epoch; }

  refresh() { return this._requestRefresh(false); }

  _requestRefresh(hintOnly) {
    if (!this._active) return Promise.resolve(this.getState());
    if (this._refreshing) return this._refreshing;
    const epoch = this._epoch;
    this._refreshing = this._refresh(epoch, hintOnly).catch((error) => {
      if (this._alive(epoch)) this._publish(true, error);
    }).then(() => this.getState()).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  _rotate(values, count, cursorName) {
    if (!values.length) return [];
    const offset = this[cursorName] % values.length;
    const result = Array.from({ length: Math.min(count, values.length) }, (_, i) => values[(offset + i) % values.length]);
    this[cursorName] = (offset + result.length) % values.length;
    return result;
  }

  async _refresh(epoch, hintOnly) {
    const [list, notifications] = await Promise.all([
      this._invoke('session/list', [{ limit: 200 }]),
      this._invoke('notification/list', [{ limit: 1000 }]),
    ]);
    if (!this._alive(epoch)) return;
    if (!Array.isArray(list?.sessions) || !Array.isArray(notifications?.notifications)) throw new Error('宿主活动列表格式无效');
    this._sessions = new Map(list.sessions.filter((s) => s.source !== 'pi-native').map((s) => [s.id, { id: s.id, title: s.title, updatedAt: s.updatedAt, running: s.running, isRunning: s.isRunning, status: s.status }]));
    for (const id of this._live.keys()) if (!this._sessions.has(id)) this._live.delete(id);
    this._notifications = notifications.notifications.map(({ id, kind, sessionId, sessionTitle, turnId, errorCode, createdAt, readAt }) => ({ id, kind, sessionId, sessionTitle, turnId, errorCode, createdAt, readAt }));
    // 公平轮转全部枚举会话；只探测轻量状态，不读空闲会话历史快照。
    this._statusQueue = this._statusQueue.filter((id) => this._sessions.has(id));
    const queued = new Set(this._statusQueue);
    for (const id of this._sessions.keys()) if (!queued.has(id)) this._statusQueue.push(id);
    for (const id of this._statusCandidates) if (!this._sessions.has(id)) this._statusCandidates.delete(id);
    if (!hintOnly) {
      const probes = this._statusQueue.splice(0, STATUS_BATCH);
      this._statusQueue.push(...probes);
      await bounded(probes, async (sessionId) => {
        if (!this._alive(epoch)) return;
        const result = await this._desktop('invoke', { operation: 'agent/getStatus', args: [sessionId] }, epoch);
        if (!this._alive(epoch)) return;
        const status = result?.status;
        if (!status || typeof status !== 'object') throw new Error('宿主运行状态格式无效');
        if (this._isRunning(status) || status.pendingToolConfirmations > 0 || status.planningState === 'awaiting_approval') this._statusCandidates.add(sessionId);
        else this._statusCandidates.delete(sessionId);
      });
    }
    if (!this._alive(epoch)) return;
    const active = [...this._sessions.keys()].filter((id) => {
      const live = this._live.get(id);
      return this._statusCandidates.has(id) || this._isRunning(this._sessions.get(id)) || live?.running || (live && live.approvals.size + live.inputs.size + live.extraPending > 0);
    });
    // 等待会话优先，其余保留现有订阅，避免每轮无意义地换订阅。
    active.sort((a, b) => {
      const pending = (id) => { const s = this._live.get(id); return s ? s.approvals.size + s.inputs.size + s.extraPending : 0; };
      return Number(pending(b) > 0) - Number(pending(a) > 0) || Number(this._subscriptions.has(b)) - Number(this._subscriptions.has(a));
    });
    const selected = new Set(active.slice(0, MAX_SUBSCRIPTIONS));
    await bounded([...this._subscriptions].filter(([id]) => !selected.has(id)), async ([id, subscriptionId]) => {
      if (!this._alive(epoch)) return;
      await this._desktop('unsubscribe', subscriptionId);
      this._subscriptions.delete(id);
    });
    if (!this._alive(epoch)) return;
    const captured = new Set();
    await bounded([...selected].filter((id) => !this._subscriptions.has(id)), async (sessionId) => {
      if (!this._alive(epoch)) return;
      const sequence = this._live.get(sessionId)?.sequence || 0;
      const reply = await this._desktop('subscribe', { sessionId }, epoch);
      if (!reply) return;
      if (!this._alive(epoch)) {
        this._subscriptions.set(sessionId, reply.subscriptionId);
        await this._desktop('unsubscribe', reply.subscriptionId);
        this._subscriptions.delete(sessionId);
        return;
      }
      this._subscriptions.set(sessionId, reply.subscriptionId);
      if (reply.snapshot) { this._snapshot(sessionId, reply.snapshot, sequence); captured.add(sessionId); }
    });
    if (!this._alive(epoch)) return;
    const ids = hintOnly ? new Set() : new Set([
      ...this._subscriptions.keys(),
      ...this._rotate(active.filter((id) => !selected.has(id)), FALLBACK_BATCH, '_fallbackCursor'),
    ]);
    await bounded([...ids].filter((id) => !captured.has(id)), async (sessionId) => {
      if (!this._alive(epoch)) return;
      const sequence = this._live.get(sessionId)?.sequence || 0;
      const snapshot = await this._desktop('getSessionSnapshot', { sessionId }, epoch);
      if (this._alive(epoch)) this._snapshot(sessionId, snapshot, sequence);
    });
    if (this._alive(epoch)) this._publish();
  }

  _snapshot(sessionId, snapshot, sequence) {
    const old = this._live.get(sessionId);
    if ((old?.sequence || 0) !== sequence || (old?.revision != null && snapshot.revision < old.revision)) return;
    const activeTurn = snapshot.activeTurn;
    const status = snapshot.status || snapshot.session?.status;
    const running = runningStatus(status) || (!!activeTurn && !['completed', 'failed', 'aborted', 'canceled'].includes(activeTurn.status));
    const approvals = new Map((snapshot.pendingApprovals || []).map((request) => [request.id, true]));
    const inputs = new Map((snapshot.pendingInputs || []).map((request) => [request.id, true]));
    if (!running && !approvals.size && !inputs.size) this._statusCandidates.delete(sessionId);
    const toolItem = (snapshot.activeItems || []).find((item) => !item.parentToolCallId && (item.content?.toolName || item.content?.message?.toolName));
    const turnId = activeTurn?.id || activeTurn?.turnId || old?.turnId;
    const sameTurn = !old?.turnId || !turnId || old.turnId === turnId;
    if (!sameTurn && this._output?.sessionId === sessionId) this._output = null;
    const live = { sequence, revision: snapshot.revision, running, approvals, inputs, extraPending: 0,
      queuedCount: (snapshot.queuedTurns || []).length, turnId,
      outputMessageId: sameTurn ? old?.outputMessageId : undefined, outputContent: sameTurn ? old?.outputContent : undefined,
      startedAt: activeTurn?.startedAt || old?.startedAt,
      updatedAt: snapshot.generatedAt || now(), tool: short(toolItem?.content?.toolName || toolItem?.content?.message?.toolName) };
    if (running && activeTurn) {
      const items = (snapshot.activeItems || []).filter((item) => !item.parentToolCallId && item.turnId === turnId && item.content?.role === 'assistant');
      const message = items.at(-1)?.content;
      this._captureOutput(sessionId, live, message, snapshot.generatedAt || now());
    }
    this._live.set(sessionId, live);
  }
  _hint() {
    if (this._hintTimer || !this._active) return;
    this._hintTimer = setTimeout(() => {
      this._hintTimer = null;
      if (this._active) void this._requestRefresh(true);
    }, 25);
    this._hintTimer.unref?.();
  }

  _event(frame) {
    if (!this._active) return;
    if (frame.kind === 'session.changed') { this._hint(); return; }
    const payload = frame.payload || {};
    if (payload.parentToolCallId || payload.event?.parentToolCallId) return;
    const sessionId = payload.sessionId || frame.sessionId;
    if (!sessionId || !this._sessions.has(sessionId)) return;
    const live = this._live.get(sessionId) || { sequence: 0, running: false, approvals: new Map(), inputs: new Map(), extraPending: 0, queuedCount: 0 };
    const event = payload.event || {};
    const at = frame.at || (payload.ts ? new Date(payload.ts).toISOString() : now());
    if (frame.kind === 'agent.queueChanged') live.queuedCount = (payload.entries || []).length;
    else if (frame.kind === 'agent.turnEnded' || (frame.kind === 'agent.event' && event.type === 'agent_end')) {
      if (payload.turnId && live.turnId && payload.turnId !== live.turnId) return;
      live.running = false; live.tool = ''; live.approvals.clear(); live.inputs.clear(); live.extraPending = 0;
      this._hint();
    } else if (frame.kind === 'agent.event') {
      if (event.type === 'agent_start') {
        live.running = true; live.turnId = payload.turnId; live.startedAt = at;
        live.approvals.clear(); live.inputs.clear(); live.extraPending = 0; live.tool = '';
        live.outputMessageId = undefined; live.outputContent = undefined;
        if (this._output?.sessionId === sessionId) this._output = null;
      } else if (event.type === 'status') {
        live.running = !!event.status?.isRunning;
        if (event.status?.currentTurnId) live.turnId = event.status.currentTurnId;
        live.extraPending = Math.max(0, (event.status?.pendingToolConfirmations || 0) - live.approvals.size);
        this._hint();
      } else if (event.type === 'tool_start') live.tool = short(event.toolName);
      else if (event.type === 'tool_end') live.tool = '';
      else if (['message_start', 'message_update', 'message_end'].includes(event.type)) {
        if (event.message?.role !== 'assistant' || event.taskSummary || (payload.turnId && live.turnId && payload.turnId !== live.turnId)) return;
        if (event.stream === 'delta') {
          const seed = live.outputMessageId === event.message.id ? live.outputContent || '' : event.message.content || '';
          const content = event.resetText ? event.deltaText || '' : seed + (event.deltaText || '');
          this._captureOutput(sessionId, live, { ...event.message, content }, at);
        } else this._captureOutput(sessionId, live, event.message, at);
      }
      else if (event.type === 'tool_permission_request') { live.approvals.set(event.request.id, true); live.extraPending = 0; }
      else if (event.type === 'asktool_request') live.inputs.set(event.request.id, true);
      else return; // turn_end 只是模型轮结束，不能结束根会话。
    } else return;
    live.sequence++;
    live.updatedAt = at;
    this._live.set(sessionId, live);
    this._publish(this._state.stale, this._state.error);
  }

  async markRead(sessionId) {
    // 先取持久化列表，避免漏掉最近一次刷新之后的结果。
    try {
      const result = await this._invoke('notification/list', [{ limit: 1000 }]);
      await bounded(result.notifications.filter((note) => note.sessionId === sessionId && !note.readAt), async (note) => {
        const reply = await this._invoke('notification/markRead', [{ id: note.id }]);
        if (reply?.ok === false) throw new Error('通知已读写入失败');
      });
      if (this._refreshing) await this._refreshing;
      await this.refresh();
    } catch (error) { this._publish(true, error); throw error; }
    return this.getState();
  }

  async markAllRead() {
    try {
      const result = await this._invoke('notification/markAllRead');
      if (result?.ok === false) throw new Error('通知已读写入失败');
      if (this._refreshing) await this._refreshing;
      await this.refresh();
    } catch (error) { this._publish(true, error); throw error; }
    return this.getState();
  }
}

module.exports = { ActivityMonitor };
