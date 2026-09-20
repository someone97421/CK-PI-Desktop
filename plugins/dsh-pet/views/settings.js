/**
 * dsh-pet 桌宠设置 —— 同一个设置卡片，两处复用：
 *   1. 右侧工作面板的停靠视图 `views/settings.html`（宿主给的整页画布）；
 *   2. 宠物的「设置…」菜单开出来的 widget 窗口 `widget/index.html?settings=1`（透明窗口里画的卡片，
 *      表头可拖动，右上角关闭）。
 * 两处都只经 `pluginBridge.invoke('pet.settings.*')` 与插件主进程通信，不与宿主做别的事。
 *
 * 语言：中文为主，关键项附英文（插件的界面语言跟随系统太粗，这里给双语标签更省事）。
 */
'use strict';

(function () {
  const CSS = `
  .pet-set *{box-sizing:border-box}
  .pet-set{--pet-set-bg:#fdf9f3;--pet-set-card:#ffffff;--pet-set-fg:#3b332c;--pet-set-dim:#8a7f74;
    --pet-set-line:#e8ded1;--pet-set-accent:#e08b4b;--pet-set-accent-soft:#fbe9d9;
    color:var(--pet-set-fg);font-family:'Microsoft YaHei UI','Segoe UI',system-ui,sans-serif;
    font-size:13px;line-height:1.6}
  .pet-set-shell{display:flex;flex-direction:column;height:100%;background:var(--pet-set-bg)}
  .pet-set-card{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--pet-set-card);
    border:1px solid var(--pet-set-line);border-radius:14px;overflow:hidden}
  .pet-set-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--pet-set-line);
    background:linear-gradient(180deg,#fff8ef,#fff)}
  .pet-set-head h1{margin:0;font-size:14px;font-weight:700;flex:1}
  .pet-set-head .pet-set-sub{color:var(--pet-set-dim);font-size:11px}
  .pet-set-body{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:14px}
  .pet-set-sec{border:1px solid var(--pet-set-line);border-radius:12px;padding:12px;background:#fffdfa}
  .pet-set-sec>h2{margin:0 0 8px;font-size:12px;font-weight:700;color:var(--pet-set-accent)}
  .pet-set-row{display:flex;align-items:center;gap:10px;padding:4px 0}
  .pet-set-row>label{flex:1;min-width:0}
  .pet-set-row .pet-set-hint{display:block;color:var(--pet-set-dim);font-size:11px;line-height:1.45}
  .pet-set input[type=text],.pet-set input[type=number],.pet-set select,.pet-set textarea{
    border:1px solid var(--pet-set-line);border-radius:8px;padding:5px 8px;background:#fff;color:inherit;
    font:inherit;font-size:12px}
  .pet-set input[type=number]{width:72px}
  .pet-set textarea{width:100%;min-height:64px;resize:vertical}
  .pet-set input[type=range]{flex:1;accent-color:var(--pet-set-accent)}
  .pet-set button{border:1px solid var(--pet-set-line);border-radius:9px;padding:6px 12px;background:#fff;
    color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease}
  .pet-set button:hover{background:var(--pet-set-accent-soft)}
  .pet-set button.pet-set-primary{background:var(--pet-set-accent);border-color:var(--pet-set-accent);color:#fff}
  .pet-set button.pet-set-primary:hover{filter:brightness(1.05)}
  .pet-set button.pet-set-danger{color:#b4443a}
  .pet-set-pets{display:flex;flex-direction:column;gap:10px}
  .pet-set-pet{border:1px solid var(--pet-set-line);border-radius:10px;padding:10px;display:flex;
    flex-direction:column;gap:6px;background:#fff}
  .pet-set-pet-head{display:flex;align-items:center;gap:8px}
  .pet-set-pet-head input[type=text]{flex:1}
  .pet-set-pet-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px;align-items:center}
  .pet-set-foot{display:flex;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid var(--pet-set-line);
    background:#fffdfa}
  .pet-set-foot .pet-set-status{flex:1;min-width:0;color:var(--pet-set-dim);font-size:11px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pet-set-status.is-error{color:#b4443a}
  .pet-set-status.is-ok{color:#2e7d4f}
  .pet-set-close{border:0;background:transparent;font-size:16px;line-height:1;padding:2px 6px;cursor:pointer}
  .pet-set-close:hover{color:#b4443a;background:transparent}
  .pet-set-handle{cursor:move;user-select:none}
  .pet-set-logs{max-height:150px;overflow:auto;font-size:11px;color:var(--pet-set-dim);white-space:pre-wrap}
  @media (prefers-color-scheme: dark) {
    .pet-set{--pet-set-bg:#2a2622;--pet-set-card:#332e29;--pet-set-fg:#f0e9e1;--pet-set-dim:#a89c8f;
      --pet-set-line:#463f38;--pet-set-accent:#e6a06a;--pet-set-accent-soft:#43372c}
    .pet-set-sec,.pet-set-pet{background:#302b26}
    .pet-set-head{background:linear-gradient(180deg,#38322c,#332e29)}
    .pet-set-foot{background:#302b26}
    .pet-set input[type=text],.pet-set input[type=number],.pet-set select,.pet-set textarea,.pet-set button{background:#2b2621}
  }
  `;

  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/settings';
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  function invoke(channel, payload) {
    if (!window.pluginBridge || typeof window.pluginBridge.invoke !== 'function') {
      return Promise.reject(new Error('宿主未提供 pluginBridge'));
    }
    return window.pluginBridge.invoke(channel, payload || {});
  }

  const CORNERS = [
    { value: 'top-left', label: '左上 top-left' },
    { value: 'top-right', label: '右上 top-right' },
    { value: 'bottom-left', label: '左下 bottom-left' },
    { value: 'bottom-right', label: '右下 bottom-right' },
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function row(labelText, hintText) {
    const wrap = el('div', 'pet-set-row');
    const label = el('label');
    label.appendChild(el('span', null, labelText));
    if (hintText) label.appendChild(el('span', 'pet-set-hint', hintText));
    wrap.appendChild(label);
    return { wrap, label };
  }

  function checkbox(labelText, hintText, value, onToggle) {
    const { wrap, label } = row(labelText, hintText);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!value;
    input.addEventListener('change', () => onToggle(input.checked));
    label.prepend(input);
    label.style.display = 'flex';
    label.style.gap = '8px';
    label.style.alignItems = 'flex-start';
    return wrap;
  }

  function mount(container, options) {
    injectCss();
    const opts = options || {};
    container.replaceChildren();
    container.classList.add('pet-set');

    const shell = el('div', 'pet-set-shell');
    const card = el('div', 'pet-set-card');
    const head = el('div', 'pet-set-head');
    if (opts.movable) head.setAttribute('data-pet-drag-handle', '');
    head.classList.toggle('pet-set-handle', !!opts.movable);
    head.appendChild(el('h1', null, '桌面宠物 dsh-pet'));
    head.appendChild(el('span', 'pet-set-sub', 'Desktop Pet'));
    if (opts.onClose) {
      const close = el('button', 'pet-set-close', '✕');
      close.type = 'button';
      close.title = '关闭 Close';
      close.addEventListener('click', () => opts.onClose());
      head.appendChild(close);
    }
    const body = el('div', 'pet-set-body');
    const foot = el('div', 'pet-set-foot');
    const status = el('span', 'pet-set-status', '正在读取设置…');
    foot.appendChild(status);
    card.append(head, body, foot);
    shell.appendChild(card);
    container.appendChild(shell);

    if (!window.pluginBridge || typeof window.pluginBridge.invoke !== 'function') {
      const notice = el('div', 'pet-set-sec');
      notice.appendChild(el('h2', null, '请从宠物菜单打开设置'));
      notice.appendChild(el('p', null, '右键点击桌面宠物 → 设置，即可调整大小、添加宠物和保存偏好。'));
      notice.appendChild(el('p', 'pet-set-hint', '当前是浏览器文件预览，无法连接桌面宠物。也可从应用的插件视图打开「桌面宠物设置」。'));
      body.appendChild(notice);
      status.textContent = '文件预览 · 请使用插件设置入口';
      return;
    }

    /** 当前设置（保存时整体回写，避免多字段竞态） */
    let state = null;
    let animations = [];
    let models = [];
    /** 可选角色（插件主进程给的清单：id / 显示名 / kind / 是否可用） */
    let characters = [];

    const setStatus = (text, kind) => {
      status.textContent = text;
      status.className = 'pet-set-status' + (kind ? ' is-' + kind : '');
    };

    const markDirty = () => {
      setStatus('有未保存的改动', null);
    };

    async function save(patch) {
      if (patch) Object.assign(state, patch);
      setStatus('正在保存…');
      try {
        const res = await invoke('pet.settings.set', {
          patch: {
            showOnStartup: state.showOnStartup,
            roaming: state.roaming,
            workStatus: state.workStatus,
            whisper: state.whisper,
            whisperIntervalSec: state.whisperIntervalSec,
            modelKey: state.modelKey,
            petCollision: state.petCollision,
            alwaysOnTop: state.alwaysOnTop,
            size: state.size,
            pets: state.pets,
          },
        });
        if (!res || !res.ok) {
          const message = res && res.error && res.error.message ? res.error.message : '保存失败';
          setStatus(message, 'error');
          return false;
        }
        state = res.settings;
        animations = res.animations || animations;
        characters = Array.isArray(res.characters) ? res.characters : characters;
        render();
        setStatus('已保存（宠物窗口会自动重挂）', 'ok');
        return true;
      } catch (error) {
        setStatus('保存失败：' + ((error && error.message) || error), 'error');
        return false;
      }
    }

    // ---- 各分区 ----
    function sizeSection() {
      const sec = el('div', 'pet-set-sec');
      sec.appendChild(el('h2', null, '大小 Size'));
      const { wrap, label } = row('宠物大小（120–600）', '高度按 9:16 自动计算；窗口比宠物四周各多半个身位');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '120';
      range.max = '600';
      range.step = '10';
      range.value = String(state.size);
      const number = document.createElement('input');
      number.type = 'number';
      number.min = '120';
      number.max = '600';
      number.value = String(state.size);
      const apply = (value) => {
        const size = Math.max(120, Math.min(600, Math.round(Number(value) || 120)));
        state.size = size;
        range.value = String(size);
        number.value = String(size);
        // 第一只宠物跟随这个尺寸（插件设置里的「宠物大小」与宠物表首项是同一个值）
        if (state.pets.length) state.pets[0].size = size;
        markDirty();
      };
      range.addEventListener('input', () => apply(range.value));
      number.addEventListener('change', () => apply(number.value));
      label.parentElement.append(range, number);
      sec.appendChild(wrap);
      return sec;
    }

    function petsSection() {
      const sec = el('div', 'pet-set-sec');
      sec.appendChild(el('h2', null, '多宠物 Pets'));
      sec.appendChild(
        el(
          'p',
          'pet-set-hint',
          '每只宠物一个独立的透明窗口：各自位置、各自大小、各自开关。收起某只后可用下面的「重新显示全部」再叫回来。',
        ),
      );
      const list = el('div', 'pet-set-pets');
      state.pets.forEach((pet, index) => {
        const box = el('div', 'pet-set-pet');
        const headRow = el('div', 'pet-set-pet-head');
        const name = document.createElement('input');
        name.type = 'text';
        name.value = pet.name || pet.id;
        name.addEventListener('change', () => {
          pet.name = name.value.trim() || pet.id;
          markDirty();
        });
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = pet.enabled !== false;
        enabled.title = '显示 In window';
        enabled.addEventListener('change', () => {
          pet.enabled = enabled.checked;
          markDirty();
        });
        const enabledLabel = el('label', null, '显示');
        enabledLabel.prepend(enabled);
        const remove = el('button', 'pet-set-danger', '删除');
        remove.type = 'button';
        remove.disabled = state.pets.length <= 1;
        remove.addEventListener('click', () => {
          state.pets.splice(index, 1);
          void save();
        });
        headRow.append(name, enabledLabel, remove);
        box.appendChild(headRow);

        const grid = el('div', 'pet-set-pet-grid');
        const sizeInput = document.createElement('input');
        sizeInput.type = 'number';
        sizeInput.min = '120';
        sizeInput.max = '600';
        sizeInput.value = String(pet.size);
        sizeInput.addEventListener('change', () => {
          pet.size = Math.max(120, Math.min(600, Math.round(Number(sizeInput.value) || 120)));
          if (index === 0) state.size = pet.size;
          markDirty();
        });
        grid.append(el('span', null, '大小 Size'), sizeInput);

        const corner = document.createElement('select');
        for (const option of CORNERS) {
          const node = document.createElement('option');
          node.value = option.value;
          node.textContent = option.label;
          corner.appendChild(node);
        }

        corner.value = pet.corner;
        corner.addEventListener('change', () => {
          pet.corner = corner.value;
          markDirty();
        });
        grid.append(el('span', null, '初始角落 Corner'), corner);

        // 角色：决定这只宠物用哪套素材与动作池（女仆 = 逐段透明 webm；Xiao Dino = Codex v2 图集）
        const character = document.createElement('select');
        for (const entry of characters) {
          const node = document.createElement('option');
          node.value = entry.id;
          node.textContent = entry.label || entry.id;
          node.disabled = entry.available === false;
          character.appendChild(node);
        }
        // 存着的角色这份配置里没有了（素材被删/换了包）：保留占位项，不静默改成别的角色
        if (pet.character && !characters.some((entry) => entry.id === pet.character)) {
          const node = document.createElement('option');
          node.value = pet.character;
          node.textContent = pet.character + '（当前不可用）';
          character.appendChild(node);
        }
        character.value = pet.character || 'maid';
        character.addEventListener('change', () => {
          pet.character = character.value;
          markDirty();
        });
        grid.append(el('span', null, '角色 Character'), character);

        const marginX = document.createElement('input');
        marginX.type = 'number';
        marginX.value = String(pet.marginX);
        marginX.addEventListener('change', () => {
          pet.marginX = Number(marginX.value) || 0;
          markDirty();
        });
        grid.append(el('span', null, '水平边距 Margin X'), marginX);

        const marginY = document.createElement('input');
        marginY.type = 'number';
        marginY.value = String(pet.marginY);
        marginY.addEventListener('change', () => {
          pet.marginY = Number(marginY.value) || 0;
          markDirty();
        });
        grid.append(el('span', null, '垂直边距 Margin Y'), marginY);

        const whisper = document.createElement('input');
        whisper.type = 'checkbox';
        whisper.checked = pet.whisperEnabled === true;
        whisper.addEventListener('change', () => {
          pet.whisperEnabled = whisper.checked;
          markDirty();
        });
        const whisperLabel = el('label', null, '碎碎念 Whisper');
        whisperLabel.prepend(whisper);
        grid.appendChild(whisperLabel);

        const work = document.createElement('input');
        work.type = 'checkbox';
        work.checked = pet.workStatusEnabled !== false;
        work.addEventListener('change', () => {
          pet.workStatusEnabled = work.checked;
          markDirty();
        });
        const workLabel = el('label', null, '会话状态 Session');
        workLabel.prepend(work);
        grid.appendChild(workLabel);

        box.appendChild(grid);
        list.appendChild(box);
      });
      sec.appendChild(list);

      const actions = el('div', 'pet-set-row');
      const add = el('button', null, '+ 添加宠物 Add pet');
      add.type = 'button';
      add.disabled = state.pets.length >= 8;
      add.addEventListener('click', () => {
        const template = state.pets[0] || { size: 320, corner: 'bottom-right', marginX: 24, marginY: 24, character: 'maid' };
        const index = state.pets.length + 1;
        state.pets.push({
          id: `pet-${index}-${Math.random().toString(36).slice(2, 6)}`,
          name: template.name || `宠物 ${index}`,
          size: template.size || 320,
          corner: template.corner || 'bottom-right',
          marginX: (template.marginX || 24) + index * 24,
          marginY: (template.marginY || 24) + index * 24,
          whisperEnabled: false,
          workStatusEnabled: true,
          character: template.character || 'maid',
          enabled: true,
        });
        void save();
      });
      const reopen = el('button', null, '重新显示全部 Reopen all');
      reopen.type = 'button';
      reopen.addEventListener('click', async () => {
        await invoke('pet.settings.set', { patch: { reopenAll: true } });
        await invoke('pet.show', {});
        setStatus('已请求重新显示全部宠物', 'ok');
      });
      actions.append(add, reopen);
      sec.appendChild(actions);
      return sec;
    }

    function behaviorSection() {
      const sec = el('div', 'pet-set-sec');
      sec.appendChild(el('h2', null, '行为 Behaviour'));
      sec.appendChild(
        checkbox('屏幕漫游 Roaming', '随机走动、转身、播放大动作；关掉只做原地待机与点击回应。', state.roaming, (v) => {
          state.roaming = v;
          void save();
        }),
      );
      sec.appendChild(
        checkbox(
          '会话状态联动 Session status',
          '跟随这是一个助手的会话状态切换思考 / 干活 / 整理 / 等待 / 完成 / 出错动画与气泡。',
          state.workStatus,
          (v) => {
            state.workStatus = v;
            void save();
          },
        ),
      );
      sec.appendChild(
        checkbox('启动时显示宠物 Show on startup', '关掉后只在你手动执行「显示宠物」命令时才出现。', state.showOnStartup, (v) => {
          state.showOnStartup = v;
          void save();
        }),
      );
      sec.appendChild(
        checkbox('窗口置顶 Always on top', '桌宠默认浮在所有窗口上面。', state.alwaysOnTop, (v) => {
          state.alwaysOnTop = v;
          void save();
        }),
      );
      sec.appendChild(
        checkbox('多宠物互相碰撞 Pet collision', '飞行中的宠物撞到别的宠物时按动量弹开（默认关闭，互相穿过）。', state.petCollision, (v) => {
          state.petCollision = v;
          void save();
        }),
      );
      return sec;
    }

    function whisperSection() {
      const sec = el('div', 'pet-set-sec');
      sec.appendChild(el('h2', null, '碎碎念 Whisper'));
      sec.appendChild(
        el(
          'p',
          'pet-set-hint',
          '开启后按周期调用你选择的模型生成一句话（会消耗 token）。原版的余额联动依赖 DSH 服务商接口，本移植未实现。',
        ),
      );
      sec.appendChild(
        checkbox('启用碎碎念 Enable whisper', '右键菜单里的「碎碎念一句」不受这个开关限制。', state.whisper, (v) => {
          state.whisper = v;
          void save();
        }),
      );
      const { wrap, label } = row('周期（秒）', '最小 60 秒；每只开启碎碎念的宠物各生成一句');
      const interval = document.createElement('input');
      interval.type = 'number';
      interval.min = '60';
      interval.max = '86400';
      interval.value = String(state.whisperIntervalSec);
      interval.addEventListener('change', () => {
        state.whisperIntervalSec = Math.max(60, Math.min(86400, Math.round(Number(interval.value) || 600)));
        interval.value = String(state.whisperIntervalSec);
        markDirty();
      });
      label.parentElement.appendChild(interval);
      sec.appendChild(wrap);

      const modelWrap = row('模型 Model', '留空 = 用当前会话的模型，再退回默认模型');
      const model = document.createElement('select');
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = '自动（当前会话 → 默认模型）';
      model.appendChild(auto);
      for (const entry of models) {
        const option = document.createElement('option');
        option.value = entry.key;
        option.textContent = entry.label ? `${entry.label}（${entry.key}）` : entry.key;
        model.appendChild(option);
      }
      model.value = state.modelKey || '';
      model.addEventListener('change', () => {
        state.modelKey = model.value;
        markDirty();
      });
      modelWrap.label.parentElement.appendChild(model);
      sec.appendChild(modelWrap.wrap);

      const promptWrap = row('人设提示词 Prompt', '来自 assets/config.jsonc 的 whisperPrompt（只读）');
      const prompt = document.createElement('textarea');
      prompt.value = state.whisperPrompt || '';
      prompt.readOnly = true;
      promptWrap.wrap.style.flexDirection = 'column';
      promptWrap.wrap.style.alignItems = 'stretch';
      promptWrap.wrap.appendChild(prompt);
      sec.appendChild(promptWrap.wrap);
      return sec;
    }

    function miscSection() {
      const sec = el('div', 'pet-set-sec');
      sec.appendChild(el('h2', null, '诊断 Diagnostics'));
      const info = el(
        'p',
        'pet-set-hint',
        `可用动作 ${animations.length} 段（右键宠物 → 动作 → 分类 → 具体动画，可逐个点播）`,
      );
      sec.appendChild(info);
      if (state.configError) {
        sec.appendChild(el('p', 'pet-set-hint', '配置读取失败：' + state.configError));
      }
      const logs = el('div', 'pet-set-logs', '');
      logs.textContent = (state.logs || []).map((line) => `${line.at} [${line.level}] ${line.message}`).join('\n') || '（暂无日志）';
      sec.appendChild(logs);
      const refresh = el('button', null, '刷新 Refresh');
      refresh.type = 'button';
      refresh.addEventListener('click', () => void load());
      sec.appendChild(refresh);
      return sec;
    }

    function render() {
      body.replaceChildren(
        sizeSection(),
        petsSection(),
        behaviorSection(),
        whisperSection(),
        miscSection(),
      );
    }

    async function load() {
      setStatus('正在读取设置…');
      try {
        const res = await invoke('pet.settings.get', {});
        if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || '读取失败');
        state = res.settings;
        animations = res.animations || [];
        characters = Array.isArray(res.characters) ? res.characters : [];
        state.logs = res.logs || [];
        state.configError = res.configError || null;
        try {
          const modelList = await invoke('pet.models', {});
          models = (modelList && modelList.models) || [];
        } catch {
          models = [];
        }
        render();
        setStatus('设置已载入', null);
      } catch (error) {
        setStatus('读取设置失败：' + ((error && error.message) || error), 'error');
      }
    }

    const saveBtn = el('button', 'pet-set-primary', '保存 Save');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => void save());
    foot.insertBefore(saveBtn, status);
    void load();
    return { reload: load };
  }

  window.PetSettings = { mount };
})();
