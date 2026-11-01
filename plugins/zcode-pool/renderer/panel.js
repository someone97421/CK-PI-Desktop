(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const bridge = window.pluginBridge;
  const connected = typeof bridge?.invoke === 'function';
  const paths = ['cliPath', 'nodePath', 'dataBaseDir'];
  const phases = { stopped: '已停止', starting: '启动中', ready: '运行中', error: '运行异常', stopping: '停止中' };
  let status = null;
  let busy = '';
  let testing = false;
  let dirty = false;
  let loading = connected;
  let operationError = '';
  let connectionError = '';
  let epoch = 0;
  let polling = false;
  let disposed = false;
  let timer;
  let modelSignature = '';
  let logSignature = '';
  const rows = new Map();
  const number = (value) => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const message = (error) => String(error?.message || error || '操作失败，请重试');
  const text = (id, value) => { $(id).textContent = value; };
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const hint = (id, value) => { text(id, value); $(id).hidden = !value; };
  const applyAppearance = (appearance) => {
    const base = appearance?.base;
    if (base === 'light' || base === 'dark') document.documentElement.dataset.base = base;
    else delete document.documentElement.dataset.base;
  };
  const date = (value, timeOnly = false) => {
    if (!Number.isFinite(value)) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return timeOnly ? parsed.toLocaleTimeString('zh-CN', { hour12: false }) : parsed.toLocaleString('zh-CN', { hour12: false });
  };
  function accept(next) {
    if (!next || !Object.hasOwn(phases, next.phase) || !Array.isArray(next.models) || !next.settings) {
      throw new Error('宿主返回的状态不完整，请刷新重试');
    }
    status = next;
    loading = false;
    connectionError = '';
    if (!dirty) {
      for (const key of paths) $(key).value = next.settings[key] || '';
      $('allowTools').checked = next.settings.allowTools === true;
    }
    render();
  }
  function renderModels() {
    const models = status?.models || [];
    const signature = JSON.stringify(models);
    if (signature !== modelSignature) {
      modelSignature = signature;
      const ids = new Set(models.map((model) => model.id));
      for (const [id, row] of rows) {
        if (!ids.has(id)) { row.root.remove(); rows.delete(id); }
      }
      $('models').querySelector('.empty')?.remove();
      for (const model of models) {
        let row = rows.get(model.id);
        if (!row) {
          const root = node('div', 'model-row');
          const info = node('div', 'model-info');
          const name = node('span', 'model-name');
          const detail = node('div', 'model-detail');
          const label = node('label', 'model-toggle');
          const state = node('span');
          const input = node('input');
          input.type = 'checkbox';
          input.setAttribute('role', 'switch');
          input.addEventListener('change', () => {
            const enabled = input.checked;
            input.checked = status?.models.find((item) => item.id === model.id)?.enabled === true;
            void action('zc.model', { id: model.id, enabled }, '模型设置已更新');
          });
          info.append(name, detail);
          label.append(state, input);
          root.append(info, label);
          row = { root, name, detail, state, input };
          rows.set(model.id, row);
        }
        row.name.textContent = model.name || model.id;
        row.name.title = model.id;
        row.detail.textContent = `上下文 ${number(model.contextWindow)} · 输出 ${number(model.maxTokens)} · 思考 ${model.thinkingLevels?.join(' / ') || '无'}`;
        row.input.setAttribute('aria-label', `启用 ${model.name || model.id}`);
        row.input.checked = model.enabled === true;
        row.state.textContent = model.enabled ? '已启用' : '已关闭';
        if (row.root.parentNode !== $('models')) $('models').append(row.root);
      }
      const previous = $('test-model').value;
      const options = models.filter((model) => model.enabled).map((model) => {
        const option = node('option', '', model.name || model.id);
        option.value = model.id;
        return option;
      });
      if (!options.length) {
        const option = node('option', '', '暂无已启用模型');
        option.value = '';
        options.push(option);
      }
      $('test-model').replaceChildren(...options);
      if (models.some((model) => model.enabled && model.id === previous)) $('test-model').value = previous;
    }
    if (!models.length) {
      let empty = $('models').querySelector('.empty');
      if (!empty) { empty = node('div', 'empty'); $('models').append(empty); }
      empty.textContent = !connected ? '暂无模型 · 连接宿主后读取' : loading ? '正在读取模型…' : !status ? '模型读取失败，请刷新重试' : '未发现 StartPlan 模型';
    }
    text('model-count', status ? `${models.length}` : '');
    for (const row of rows.values()) row.input.disabled = !connected || !!busy || testing || !!connectionError;
  }
  function renderLogs() {
    const logs = status?.logs || [];
    text('log-count', number(logs.length));
    const signature = JSON.stringify(logs);
    if (signature === logSignature) return;
    logSignature = signature;
    const entries = logs.map((log) => {
      const item = node('li', 'log-row');
      item.dataset.level = log.level;
      const time = node('time', '', date(log.at, true));
      time.title = date(log.at);
      item.append(time, node('span', '', { info: '信息', warn: '警告', error: '错误' }[log.level] || log.level), node('span', '', log.message));
      return item;
    });
    $('logs').replaceChildren(...(entries.length ? entries : [node('li', 'empty', '暂无日志')]));
  }
  function render() {
    const running = status?.phase === 'ready' || status?.enabled === true;
    const transitioning = ['starting', 'stopping'].includes(status?.phase);
    const unavailable = !connected || !status || !!connectionError;
    const locked = unavailable || !!busy || testing;
    const phase = !connected ? '预览模式' : loading ? '加载中' : connectionError ? '连接异常' : phases[status?.phase] || '状态未知';
    text('phase', phase);
    $('phase').dataset.phase = connectionError ? 'error' : status?.phase || '';
    const progress = { 'zc.start': '正在启动桥接…', 'zc.stop': '正在停止桥接…', 'zc.refresh': '正在刷新本机状态…', 'zc.model': '正在保存模型设置…', 'zc.settings': '正在保存设置…', 'zc.logs.clear': '正在清空日志…' };
    text('activity', !connected ? '未连接宿主' : busy ? progress[busy] : loading ? '正在读取本机状态…' : connectionError ? '状态未同步，可刷新重试' : `${number(status?.activeRequests)} 个请求进行中`);
    hint('error', operationError || connectionError || status?.lastError || '');
    $('refresh').disabled = !connected || !!busy || testing;
    text('refresh', busy === 'zc.refresh' ? '刷新中…' : '刷新');
    const canStop = running || testing || busy === 'zc.start' || status?.phase === 'starting';
    $('toggle').disabled = canStop ? !connected || disposed || busy === 'zc.stop' || status?.phase === 'stopping' : locked || transitioning || !status?.client?.found || !status?.account?.available;
    text('toggle', busy === 'zc.stop' || status?.phase === 'stopping' ? '停止中…' : canStop ? '停止' : '启动');
    $('toggle').title = !connected ? '预览模式不可操作' : canStop ? '取消启动或当前请求，停止桥接' : !status ? '等待宿主状态' : !status.client?.found || !status.account?.available ? '请先在本机 ZCode 登录，再刷新状态' : '启动本地桥接';
    text('account-state', !status ? '未读取' : status.account?.available ? '凭据可读' : '未就绪');
    text('account-label', status?.account?.available ? status.account.label || '本机当前账号' : loading ? '正在读取登录信息…' : '未读取到可用账号');
    text('expiry', status?.account?.available ? status.account.expiresAt ? `登录有效期至 ${date(status.account.expiresAt)}` : '有效期未提供' : !connected ? '预览模式' : loading ? '—' : '在本机 ZCode 登录后刷新');
    text('client', !status ? loading ? '检测中' : '未读取' : status.client?.found ? `ZCode ${status.client.version || ''}`.trim() : '未检测到 ZCode CLI');
    $('client').title = status?.client?.path || '';
    text('endpoint', status?.endpoint || '—');
    for (const key of ['requests', 'inputTokens', 'outputTokens']) text(key, number(status?.stats?.[key]));
    text('outcomes', status ? `${number(status.stats?.successes)} / ${number(status.stats?.failures)}` : '—');
    $('reload').hidden = !status?.requiresReload;
    renderModels();
    $('test-model').disabled = locked || status?.phase !== 'ready' || !$('test-model').value;
    $('test').disabled = $('test-model').disabled;
    text('test', testing ? '测试中…' : '测试');
    const editable = !locked && !running && !transitioning;
    $('settings-fields').disabled = !editable;
    $('save').disabled = !editable || !dirty;
    text('save', busy === 'zc.settings' ? '保存中…' : '保存设置');
    text('settings-hint', !connected ? '预览模式不可修改。' : !status ? '读取状态后可修改。' : running || transitioning ? '停止桥接后可修改设置。' : dirty ? '有未保存的修改。' : '留空使用自动检测或默认目录。');
    $('clear-logs').disabled = locked || !status?.logs?.length;
    text('clear-logs', busy === 'zc.logs.clear' ? '清空中…' : '清空日志');
    renderLogs();
  }
  async function poll() {
    if (!connected || polling || disposed || (busy && !['zc.start', 'zc.stop'].includes(busy))) return;
    polling = true;
    const version = epoch;
    try {
      const next = await bridge.invoke('zc.status');
      if (version === epoch && !disposed) accept(next);
    } catch (error) {
      if (version === epoch && !disposed) { loading = false; connectionError = message(error); render(); }
    } finally { polling = false; }
  }
  async function action(command, payload, success) {
    if (!connected || busy || testing || disposed) return;
    busy = command;
    const operation = ++epoch;
    operationError = '';
    hint('notice', '');
    render();
    try {
      const next = payload === undefined ? await bridge.invoke(command) : await bridge.invoke(command, payload);
      if (operation !== epoch || disposed) return;
      accept(next);
      if (command === 'zc.settings') {
        dirty = false;
        for (const key of paths) $(key).value = status.settings[key] || '';
        $('allowTools').checked = status.settings.allowTools === true;
      }
      hint('notice', success || '');
    } catch (error) { if (operation === epoch) operationError = message(error); }
    finally { if (operation === epoch) { busy = ''; epoch++; render(); void poll(); } }
  }
  async function stop() {
    if (!connected || disposed || busy === 'zc.stop') return;
    const operation = ++epoch;
    busy = 'zc.stop';
    operationError = '';
    if (testing) {
      testing = false;
      $('test-result').setAttribute('aria-busy', 'false');
      text('test-state', '已取消');
      text('test-text', '正在停止当前请求。');
    }
    render();
    try {
      const next = await bridge.invoke('zc.stop');
      if (operation === epoch && !disposed) accept(next);
    } catch (error) { if (operation === epoch) operationError = message(error); }
    finally { if (operation === epoch) { busy = ''; epoch++; render(); void poll(); } }
  }
  $('refresh').addEventListener('click', () => { void action('zc.refresh', undefined, '状态已刷新'); });
  $('toggle').addEventListener('click', () => {
    if (testing || busy === 'zc.start' || status?.enabled || ['ready', 'starting'].includes(status?.phase)) void stop();
    else void action('zc.start');
  });
  $('clear-logs').addEventListener('click', () => { void action('zc.logs.clear', undefined, '日志已清空'); });
  $('test-model').addEventListener('change', render);
  $('settings-form').addEventListener('input', () => { dirty = true; hint('notice', ''); render(); });
  $('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('save').disabled) return;
    const settings = Object.fromEntries(paths.map((key) => [key, $(key).value.trim()]));
    settings.allowTools = $('allowTools').checked;
    void action('zc.settings', settings, '设置已保存');
  });
  $('test').addEventListener('click', async () => {
    if ($('test').disabled) return;
    const model = $('test-model').value;
    const operation = ++epoch;
    testing = true;
    operationError = '';
    hint('notice', '');
    $('test-result').hidden = false;
    $('test-result').setAttribute('aria-busy', 'true');
    $('test-state').classList.remove('error');
    text('test-state', `正在测试 ${$('test-model').selectedOptions[0].textContent}…`);
    text('test-metrics', '');
    text('test-text', '等待 ZCode 返回…');
    render();
    try {
      const result = await bridge.invoke('zc.test', { model });
      if (operation !== epoch || disposed) return;
      if (!result || typeof result.ok !== 'boolean') throw new Error('宿主返回的测试结果不完整');
      text('test-state', result.ok ? '测试成功' : '测试失败');
      $('test-state').classList.toggle('error', !result.ok);
      text('test-text', result.ok ? result.text || '请求完成，返回内容为空。' : result.error || result.text || '请求失败，请查看运行日志。');
      text('test-metrics', `${number(result.elapsedMs)} ms · 输入 ${number(result.inputTokens)} / 输出 ${number(result.outputTokens)}`);
    } catch (error) {
      if (operation !== epoch || disposed) return;
      text('test-state', '测试失败');
      $('test-state').classList.add('error');
      text('test-text', message(error));
    } finally {
      if (operation === epoch) {
        testing = false;
        $('test-result').setAttribute('aria-busy', 'false');
        epoch++;
        render();
        void poll();
      }
    }
  });
  let unsubscribe;
  if (connected) {
    unsubscribe = bridge.on?.('appearance:changed', applyAppearance);
    Promise.resolve().then(() => bridge.invoke('app.getAppearance')).then(applyAppearance).catch(() => {});
    void poll();
    timer = window.setInterval(() => { if (!document.hidden || testing) void poll(); }, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  }
  window.addEventListener('pagehide', () => {
    disposed = true;
    clearInterval(timer);
    if (typeof unsubscribe === 'function') unsubscribe();
  }, { once: true });
  render();
})();
