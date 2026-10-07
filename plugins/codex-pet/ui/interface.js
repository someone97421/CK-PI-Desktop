/* codex-pet UI 交互层。
   契约：createUI({root, request, onAction, onLayout}) →
   { update(state), setBusy(bool), showError(message), focusComposer(), getDraft(), dispose() }
   额外方法（已向主代理报备）：expand(name|null), collapse(), isPreview(), getState()。
   root 中始终保留 #pet-stage（canvas 由主代理挂载，本层不重建）、#pet-hit、#pet-controls。
   控制条 / 展开面板 / 弹层 / 设置面 / 预览横幅均带 data-interactive，供主代理做透明区域穿透。 */
import { createI18n, resolveLocale } from "./i18n.js";

const ICONS = {
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  clip: '<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  star: '<path d="M12 2l2.4 7.2H22l-6 4.4 2.3 7.4-6.3-4.6-6.3 4.6L8 13.6 2 9.2h7.6Z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  wave: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V12m0-4a1.5 1.5 0 0 1 3 0v5c0 4-2.5 7-6 7s-5.5-2-6.5-5.5L4 12c-.5-1.5 1.5-2.5 2.5-1.2L8 13"/>',
  jump: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  crosshair: '<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  eyeOff: '<path d="M2 2l20 20M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-2.16 3.19M6.61 6.61A16 16 0 0 0 2 12s3 8 10 8a9.9 9.9 0 0 0 5.39-1.61"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
};

const STATUS_KEYS = { running: "status.running", "needs-input": "status.needsInput", ready: "status.ready", blocked: "status.blocked" };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
function svgIcon(name) {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return wrap.firstChild;
}
function debounce(fn, ms) {
  let id = 0;
  const wrapped = (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(id);
  wrapped.flush = (...args) => { clearTimeout(id); fn(...args); };
  return wrapped;
}
function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(file.name));
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.readAsDataURL(file);
  });
}
function downloadBase64(name, dataBase64) {
  const mime = name.endsWith(".json") ? "application/json" : name.endsWith(".webp") ? "image/webp" : "image/png";
  const a = document.createElement("a");
  a.href = `data:${mime};base64,${dataBase64}`;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

export function createUI(options) {
  const rootEl = options?.root;
  if (!rootEl) throw new Error("createUI: options.root is required");
  const requestRaw = typeof options.request === "function" ? options.request : null;
  const onAction = typeof options.onAction === "function" ? options.onAction : () => {};
  const onLayout = typeof options.onLayout === "function" ? options.onLayout : () => {};
  const bridge = typeof window !== "undefined" ? window.pluginBridge : null;
  const preview = options.preview === true || !bridge?.invoke;

  const html = document.documentElement;
  const embeddedView = options.embeddedView ?? (html.dataset.piPluginPanelShape === "view");
  const surface = options.surface || (embeddedView || new URLSearchParams(location.search).get("surface") === "settings" ? "settings" : "pet");
  document.body.dataset.surface = surface;
  html.dataset.codexPetSurface = surface;
  if (surface === "pet") window.scrollTo(0, 0);

  let i18n = createI18n(html.lang || navigator.language);
  const t = (key, vars) => i18n.t(key, vars);

  let state = null;
  let disposed = false;
  let busy = false;
  let sending = false;
  let hoverTimer;
  let readingAttachments = 0, draftWrites = Promise.resolve();
  const ioWaiters = [];
  let expanded = null; // 'composer' | 'activity' | null
  let activePop = null; // {trigger, pop}
  let sendError = null;
  let lastStateError = null;
  const seenWarnings = new Set();
  let draftRestored = false;
  const draft = { text: "", modelKey: "", attachments: [], skills: [] };
  const assetCache = new Map();
  const removeConfirmTimers = new Map();
  const cleanups = [];

  /* ---------- 外观（浅深 / locale） ---------- */
  function systemBase() { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; }
  function applyAppearance(a) {
    const base = a?.base === "light" || a?.base === "dark" ? a.base : systemBase();
    html.dataset.base = base;
    if (typeof a?.locale === "string" && a.locale) html.lang = resolveLocale(a.locale);
  }
  applyAppearance(null);
  if (!preview && bridge?.on) {
    try { bridge.on("appearance:changed", applyAppearance); } catch { /* 宿主不支持时忽略 */ }
    try { bridge.invoke("app.getAppearance").then(applyAppearance).catch(() => {}); } catch { /* ignore */ }
  }

  /* ---------- 请求封装 ---------- */
  async function call(channel, payload) {
    if (!requestRaw) throw new Error(t("preview.unavailable"));
    const r = await requestRaw(channel, payload);
    if (r && r.ok === false) throw new Error(r.error?.message || t("error.generic"));
    return r;
  }

  /* ---------- 布局通知 ---------- */
  let layoutRaf = 0;
  function notifyLayout() {
    cancelAnimationFrame(layoutRaf);
    layoutRaf = requestAnimationFrame(() => { if (!disposed) onLayout(); });
  }

  /* ---------- Toast ---------- */
  const toasts = el("div", "pet-toasts");
  toasts.setAttribute("data-interactive", "");
  function toast(message, kind = "info") {
    const item = el("div", "pet-toast");
    item.dataset.kind = kind;
    item.setAttribute("role", kind === "error" ? "alert" : "status");
    item.append(el("span", "", message));
    const close = el("button");
    close.type = "button";
    close.setAttribute("aria-label", t("common.dismiss"));
    close.append(svgIcon("x"));
    close.addEventListener("click", () => item.remove());
    item.append(close);
    toasts.append(item);
    setTimeout(() => item.remove(), 6500);
    notifyLayout();
  }
  function showError(message) { toast(String(message || t("error.generic")), "error"); }

  /* ---------- 根结构 ---------- */
  rootEl.replaceChildren();
  const root = el("div", "pet-root");
  root.dataset.surface = surface;
  root.setAttribute("aria-busy", "true");

  // #pet-stage：canvas 由主代理挂载，本层只创建一次、之后绝不重建
  const stageWrap = el("div", "pet-stage-wrap");
  const stage = el("section");
  stage.id = "pet-stage";
  const hit = el("div");
  hit.id = "pet-hit";
  stage.append(hit);
  stageWrap.append(stage);

  // #pet-controls
  const controls = el("section", "pet-controls-wrap");
  controls.id = "pet-controls";
  controls.setAttribute("data-interactive", "");
  const handle = el("button", "pet-handle");
  handle.type = "button";
  handle.dataset.i18nAria = "bar.expand";
  handle.dataset.i18nTitle = "bar.expand";
  handle.setAttribute("aria-expanded", "false");

  const bar = el("div", "pet-bar pet-busy-lock");
  bar.setAttribute("data-interactive", "");
  bar.hidden = true;

  const composeBtn = el("button", "pet-bar-btn");
  composeBtn.type = "button";
  composeBtn.dataset.i18nAria = "bar.compose";
  composeBtn.dataset.i18nTitle = "bar.compose";
  composeBtn.setAttribute("aria-expanded", "false");
  composeBtn.append(svgIcon("pen"));

  const activityBtn = el("button", "pet-bar-btn");
  activityBtn.type = "button";
  activityBtn.dataset.i18nAria = "bar.activity";
  activityBtn.dataset.i18nTitle = "bar.activity";
  activityBtn.setAttribute("aria-expanded", "false");
  activityBtn.append(svgIcon("bell"));
  const badge = el("span", "pet-badge");
  badge.hidden = true;
  activityBtn.append(badge);

  const status = el("span", "pet-status");
  const statusDot = el("span", "pet-status-dot");
  const statusText = el("span", "", t("status.idle"));
  status.append(statusDot, statusText);

  const menuBtn = el("button", "pet-bar-btn");
  menuBtn.type = "button";
  menuBtn.dataset.i18nAria = "bar.menu";
  menuBtn.dataset.i18nTitle = "bar.menu";
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.append(svgIcon("dots"));

  bar.append(composeBtn, activityBtn, status, menuBtn);

  /* 活动面板 */
  const activityPanel = el("div", "pet-panel pet-busy-lock");
  activityPanel.setAttribute("data-interactive", "");
  activityPanel.hidden = true;
  const activityHead = el("div", "pet-panel-head");
  const activityTitle = el("span", "");
  activityTitle.dataset.i18n = "activity.title";
  const markAllBtn = el("button", "pet-link-btn");
  markAllBtn.type = "button";
  markAllBtn.dataset.i18n = "activity.markAll";
  activityHead.append(activityTitle, markAllBtn);
  const activityList = el("ul", "pet-activity-list");
  const activityNote = el("div", "pet-panel-note");
  activityNote.hidden = true;
  activityPanel.append(activityHead, activityList, activityNote);

  /* 快捷输入面板 */
  const composerPanel = el("div", "pet-panel pet-composer pet-busy-lock");
  composerPanel.setAttribute("data-interactive", "");
  composerPanel.hidden = true;


  const textarea = el("textarea", "pet-textarea");
  textarea.rows = 1;
  textarea.dataset.i18nPh = "composer.placeholder";
  async function packFiles(files) {
    const out = [];
    for (const f of files) {
      out.push({ name: f.name, relativePath: f.webkitRelativePath || f.relPath || f.name, dataBase64: await readFileBase64(f) });
    }
    return out;
  }
  async function filesFromDrop(dataTransfer) {
    const collected = [];
    async function walk(entry, prefix) {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        file.relPath = prefix + file.name;
        collected.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const entries = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!entries.length) break;
          for (const child of entries) await walk(child, `${prefix}${entry.name}/`);
        }
      }
    }
    const items = [...(dataTransfer?.items || [])];
    const entries = items.map((it) => (it.kind === "file" && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await walk(entry, "");
    } else {
      collected.push(...(dataTransfer?.files || []));
    }
    return packFiles(collected);
  }
  function handleImportResult(res) {
    if (!res) return;
    if (res.cancelled) { toast(t("import.cancelled")); return; }
    if (res.state) applyState(res.state); else applyState(res);
    const imported = res.imported?.length ?? 0;
    const errors = res.errors?.length ?? 0;
    if (errors) {
      const detail = res.errors.slice(0, 3).map((e) => (typeof e === "string" ? e : e?.message)).filter(Boolean).join("；");
      showError(`${t("import.summaryWithErrors", { n: imported, m: errors })}${detail ? `：${detail}` : ""}`);
    } else if (imported) {
      toast(t("import.summary", { n: imported }));
    } else {
      toast(t("import.none"));
    }
  }
  textarea.setAttribute("aria-label", "composer");

  const attachList = el("div", "pet-attach-list");

  const inputWrap = el("div", "pet-input-wrap");
  inputWrap.append(attachList, textarea);
  const composerError = el("span", "pet-composer-error");
  composerError.setAttribute("role", "alert");
  const sendBtn = el("button", "pet-send-btn");
  sendBtn.type = "button";
  sendBtn.dataset.i18n = "composer.send";
  composerPanel.append(inputWrap, sendBtn, composerError);

  /* 主菜单弹层 */
  const menuPop = el("div", "pet-pop pet-menu");
  menuPop.setAttribute("data-interactive", "");
  menuPop.setAttribute("role", "menu");
  menuPop.hidden = true;

  controls.append(handle, bar, activityPanel, composerPanel, menuPop);

  /* 预览横幅 */
  const previewBanner = el("div", "pet-preview-banner");
  previewBanner.setAttribute("data-interactive", "");
  previewBanner.dataset.i18n = "preview.banner";
  previewBanner.hidden = !preview;

  /* 加载占位 */
  const loading = el("div", "pet-loading");
  const loadingSpinner = el("span", "pet-spinner");
  const loadingText = el("span", "");
  loadingText.dataset.i18n = "common.loading";
  loading.append(loadingSpinner, loadingText);

  root.append(stageWrap, controls, previewBanner, loading);
  rootEl.append(root, toasts);

  /* ---------- settings surface ---------- */
  let settingsEls = null;
  if (surface === "settings") settingsEls = buildSettings();

  function buildSettings() {
    const wrap = el("main", "pet-settings");
    wrap.setAttribute("data-interactive", "");

    const head = el("header", "pet-settings-head");
    const h1 = el("h1"); h1.dataset.i18n = "settings.title";
    const sub = el("p"); sub.dataset.i18n = "settings.subtitle";
    const heading = el("div");
    heading.append(h1, sub);
    head.append(heading);
    if (!embeddedView) {
      const closeBtn = el("button", "pet-icon-btn pet-settings-close");
      closeBtn.type = "button";
      closeBtn.dataset.i18nAria = "common.close";
      closeBtn.dataset.i18nTitle = "common.close";
      closeBtn.append(svgIcon("x"));
      closeBtn.addEventListener("click", () => onAction("close"));
      head.append(closeBtn);
    }

    /* 宠物库 */
    const lib = el("section", "pet-section pet-busy-lock");
    const libH2 = el("h2"); libH2.dataset.i18n = "settings.library";
    const toolbar = el("div", "pet-toolbar");
    toolbar.style.position = "relative";

    const importBtn = el("button", "pet-btn");
    importBtn.type = "button";
    importBtn.dataset.i18n = "settings.import";
    importBtn.setAttribute("aria-expanded", "false");
    importBtn.prepend(svgIcon("download"));

    const createBtn = el("button", "pet-btn");
    createBtn.type = "button";
    createBtn.dataset.i18n = "settings.create";
    createBtn.setAttribute("aria-expanded", "false");
    createBtn.prepend(svgIcon("plus"));

    const refreshBtn = el("button", "pet-btn");
    refreshBtn.type = "button";
    refreshBtn.dataset.i18n = "settings.refresh";
    refreshBtn.prepend(svgIcon("refresh"));

    const revealBtn = el("button", "pet-btn");
    revealBtn.type = "button";
    revealBtn.dataset.i18n = "settings.reveal";
    revealBtn.prepend(svgIcon("folder"));

    toolbar.append(importBtn, createBtn, refreshBtn, revealBtn);

    const importPop = el("div", "pet-pop pet-menu");
    importPop.setAttribute("data-interactive", "");
    importPop.hidden = true;
    const importDirItem = menuItem("settings.importDir", "folder");
    const importFilesItem = menuItem("settings.importFiles", "file");
    const importLinkItem = menuItem("settings.importLink", "link");
    importPop.append(importDirItem, importFilesItem, importLinkItem);
    toolbar.append(importPop);

    const importInput = el("input");
    importInput.type = "file";
    importInput.multiple = true;
    importInput.accept = ".json,image/*";
    importInput.hidden = true;
    toolbar.append(importInput);

    const dropzone = el("div", "pet-dropzone");
    dropzone.dataset.i18n = "settings.dropHint";

    const grid = el("div", "pet-grid");
    const libEmpty = el("div", "pet-empty");
    libEmpty.hidden = true;

    /* 链接安装子表单 */
    const linkForm = el("form", "pet-subform");
    linkForm.hidden = true;
    const linkH3 = el("h3"); linkH3.dataset.i18n = "link.title";
    const linkHint = el("p"); linkHint.dataset.i18n = "link.hint";
    const linkRow = el("div", "pet-form-foot");
    const linkInput = el("input", "pet-input");
    linkInput.type = "text";
    linkInput.inputMode = "url";
    linkInput.dataset.i18nPh = "link.placeholder";
    linkInput.style.flex = "1";
    const linkSubmit = el("button", "pet-btn");
    linkSubmit.type = "submit";
    linkSubmit.dataset.variant = "primary";
    linkSubmit.dataset.i18n = "link.submit";
    const linkCancel = el("button", "pet-btn");
    linkCancel.type = "button";
    linkCancel.dataset.i18n = "common.cancel";
    linkRow.append(linkInput, linkSubmit, linkCancel);
    const linkError = el("div", "pet-form-error");
    linkError.setAttribute("role", "alert");
    linkForm.append(linkH3, linkHint, linkRow, linkError);

    /* 新建子表单 */
    const createForm = el("form", "pet-subform");
    createForm.hidden = true;
    const createH3 = el("h3"); createH3.dataset.i18n = "create.title";
    const createHint = el("p"); createHint.dataset.i18n = "create.hint";
    const createGrid = el("div", "pet-form-grid");

    const fId = field("create.id", "create.idHint");
    const idInput = el("input", "pet-input");
    idInput.type = "text"; idInput.maxLength = 64; idInput.autocomplete = "off";
    fId.append(idInput);

    const fName = field("create.name", "create.nameHint");
    const nameInput = el("input", "pet-input");
    nameInput.type = "text"; nameInput.maxLength = 64;
    fName.append(nameInput);

    const fDesc = field("create.description");
    fDesc.dataset.span = "2";
    const descInput = el("input", "pet-input");
    descInput.type = "text"; descInput.maxLength = 200;
    fDesc.append(descInput);

    const fVer = field("create.version", "create.versionHint");
    fVer.dataset.span = "2";
    const verRow = el("div", "pet-radio-row");
    const v1 = radio("spriteVersion", "1", "create.v1", true);
    const v2 = radio("spriteVersion", "2", "create.v2");
    verRow.append(v1, v2);
    fVer.append(verRow);

    const fFile = field("create.file", "create.fileHint");
    fFile.dataset.span = "2";
    const filePickBtn = el("button", "pet-btn");
    filePickBtn.type = "button";
    filePickBtn.prepend(svgIcon("file"));
    const fileNameText = el("span", "", "");
    fileNameText.style.cssText = "font-size:12px;color:var(--pet-muted)";
    const fileInput = el("input");
    fileInput.type = "file"; fileInput.accept = "image/png,image/webp,image/gif"; fileInput.hidden = true;
    const fileRow = el("div", "pet-field-inline");
    fileRow.append(filePickBtn, fileNameText, fileInput);
    fFile.append(fileRow);

    createGrid.append(fId, fName, fDesc, fVer, fFile);
    const createError = el("div", "pet-form-error");
    createError.setAttribute("role", "alert");
    const createFoot = el("div", "pet-form-foot");
    const createSubmit = el("button", "pet-btn");
    createSubmit.type = "submit";
    createSubmit.dataset.variant = "primary";
    createSubmit.dataset.i18n = "create.submit";
    const createCancel = el("button", "pet-btn");
    createCancel.type = "button";
    createCancel.dataset.i18n = "common.cancel";
    createFoot.append(createSubmit, createCancel);
    createForm.append(createH3, createHint, createGrid, createError, createFoot);

    lib.append(libH2, toolbar, dropzone, libEmpty, grid, linkForm, createForm);

    function field(labelKey, hintKey) {
      const f = el("label", "pet-field");
      const s = el("span"); s.dataset.i18n = labelKey;
      f.append(s);
      if (hintKey) { const h = el("small"); h.dataset.i18n = hintKey; f.append(h); }
      return f;
    }
    function radio(name, value, labelKey, checked) {
      const l = el("label", "pet-radio");
      const input = el("input");
      input.type = "radio"; input.name = name; input.value = value; input.checked = !!checked;
      const s = el("span"); s.dataset.i18n = labelKey;
      l.append(input, s);
      return l;
    }
    function menuItem(i18nKey, iconName) {
      const b = el("button", "pet-menu-item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      const s = el("span"); s.dataset.i18n = i18nKey;
      b.append(svgIcon(iconName), s);
      return b;
    }

    /* 浮窗偏好 */
    const pref = el("section", "pet-section pet-busy-lock");
    const prefH2 = el("h2"); prefH2.dataset.i18n = "settings.preferences";
    const prefGrid = el("div", "pet-pref-grid");

    const sizeField = el("label", "pet-field");
    const sizeLabel = el("span"); sizeLabel.dataset.i18n = "settings.size";
    const sizeRow = el("div", "pet-field-inline");
    const sizeRange = el("input", "pet-range");
    sizeRange.type = "range"; sizeRange.min = "32"; sizeRange.max = "256"; sizeRange.step = "4";
    const sizeOut = el("output");
    sizeRow.append(sizeRange, sizeOut);
    sizeField.append(sizeLabel, sizeRow);

    const filterField = el("label", "pet-field");
    const filterLabel = el("span"); filterLabel.dataset.i18n = "settings.filter";
    const filterSelect = el("select");
    filterSelect.append(option("pixelated", "settings.filterPixelated"), option("smooth", "settings.filterSmooth"));
    filterField.append(filterLabel, filterSelect);

    const motionField = el("label", "pet-field");
    const motionLabel = el("span"); motionLabel.dataset.i18n = "settings.motion";
    const motionSelect = el("select");
    motionSelect.append(option("system", "settings.motionSystem"), option("reduce", "settings.motionReduce"), option("full", "settings.motionFull"));
    motionField.append(motionLabel, motionSelect);

    const pollField = el("label", "pet-field");
    const pollLabel = el("span"); pollLabel.dataset.i18n = "settings.poll";
    const pollRow = el("div", "pet-field-inline");
    const pollInput = el("input", "pet-input");
    pollInput.type = "number"; pollInput.min = "2"; pollInput.max = "60"; pollInput.step = "1";
    const pollUnit = el("span", ""); pollUnit.dataset.i18n = "settings.pollUnit";
    pollRow.append(pollInput, pollUnit);
    pollField.append(pollLabel, pollRow);

    const topRow = el("label", "pet-check-row");
    const topCheck = el("input", "pet-switch"); topCheck.type = "checkbox";
    const topText = el("span"); topText.dataset.i18n = "settings.alwaysOnTop";
    topRow.append(topCheck, topText);

    const visibleRow = el("label", "pet-check-row");
    const visibleCheck = el("input", "pet-switch"); visibleCheck.type = "checkbox";
    const visibleText = el("span"); visibleText.dataset.i18n = "settings.visible";
    visibleRow.append(visibleCheck, visibleText);

    const shortcutField = el("div", "pet-field");
    const shortcutLabel = el("span"); shortcutLabel.dataset.i18n = "settings.shortcut";
    const shortcutRow = el("div", "pet-field-inline");
    const shortcutInput = el("input", "pet-input");
    shortcutInput.type = "text"; shortcutInput.readOnly = true;
    shortcutInput.placeholder = "—";
    shortcutInput.style.flex = "1";
    const recordBtn = el("button", "pet-btn"); recordBtn.type = "button"; recordBtn.dataset.i18n = "settings.shortcutRecord";
    const clearBtn = el("button", "pet-btn"); clearBtn.type = "button"; clearBtn.dataset.i18n = "settings.shortcutClear";
    shortcutRow.append(shortcutInput, recordBtn, clearBtn);
    const shortcutHint = el("small"); shortcutHint.dataset.i18n = "settings.shortcutHint";
    shortcutField.append(shortcutLabel, shortcutRow, shortcutHint);

    prefGrid.append(sizeField, filterField, motionField, pollField, shortcutField, topRow, visibleRow);
    pref.append(prefH2, prefGrid);

    wrap.append(head, lib, pref);
    root.append(wrap);

    function option(value, i18nKey) {
      const o = el("option"); o.value = value; o.dataset.i18n = i18nKey; return o;
    }

    /* ---- settings 事件 ---- */
    importBtn.addEventListener("click", () => togglePop(importBtn, importPop));
    importDirItem.addEventListener("click", async () => {
      closePops();
      await guard(async () => handleImportResult(await call("pet.importDirectory")));
    });
    importFilesItem.addEventListener("click", () => { closePops(); importInput.click(); });
    importLinkItem.addEventListener("click", () => {
      closePops();
      toggleSubform(linkForm, null);
      linkInput.focus();
    });
    importInput.addEventListener("change", async () => {
      const files = [...importInput.files];
      importInput.value = "";
      if (!files.length) return;
      await guard(async () => handleImportResult(await call("pet.importFiles", { files: await packFiles(files) })));
    });
    createBtn.addEventListener("click", () => toggleSubform(createForm, createBtn));
    createCancel.addEventListener("click", () => toggleSubform(createForm, createBtn, true));
    linkCancel.addEventListener("click", () => toggleSubform(linkForm, null, true));
    refreshBtn.addEventListener("click", () => guard(async () => applyState(await call("pet.refresh"))));
    revealBtn.addEventListener("click", () => guard(() => call("pet.revealLibrary")));
    filePickBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => { fileNameText.textContent = fileInput.files[0]?.name || ""; });

    linkForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const url = linkInput.value.trim();
      if (!url) { linkError.textContent = t("link.invalid"); return; }
      linkError.textContent = "";
      guard(async () => {
        linkSubmit.disabled = true;
        try {
          handleImportResult(await call("pet.importLink", { url }));
          linkInput.value = "";
          toggleSubform(linkForm, null, true);
        } finally { linkSubmit.disabled = false; }
      });
    });

    createForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const file = fileInput.files[0];
      const name = nameInput.value.trim();
      const version = createForm.querySelector('input[name="spriteVersion"]:checked')?.value === "1" ? 1 : 2;
      if (!file) { createError.textContent = t("create.invalid"); return; }
      createError.textContent = "";
      guard(async () => {
        createSubmit.disabled = true;
        try {
          const res = await call("pet.create", {
            id: idInput.value.trim() || undefined,
            displayName: name || undefined,
            description: descInput.value.trim() || undefined,
            spriteVersionNumber: version,
            filename: file.name,
            dataBase64: await readFileBase64(file),
          });
          applyState(res?.state || res);
          toast(t("create.done", { name: name || file.name }));
          idInput.value = ""; nameInput.value = ""; descInput.value = ""; fileInput.value = ""; fileNameText.textContent = "";
          toggleSubform(createForm, createBtn, true);
        } catch (err) { createError.textContent = err.message; }
        finally { createSubmit.disabled = false; }
      });
    });

    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.dataset.over = "true"; });
    dropzone.addEventListener("dragleave", () => { dropzone.dataset.over = "false"; });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.dataset.over = "false";
      guard(async () => {
        const files = await filesFromDrop(e.dataTransfer);
        if (!files.length) { toast(t("import.none")); return; }
        handleImportResult(await call("pet.importFiles", { files }));
      });
    });

    const patch = (p) => guard(async () => applyState(await call("pet.settings", { patch: p })));
    const patchDebounced = debounce(patch, 350);
    sizeRange.addEventListener("input", () => { sizeOut.textContent = `${sizeRange.value} ${t("settings.sizeUnit")}`; patchDebounced({ size: Number(sizeRange.value) }); });
    filterSelect.addEventListener("change", () => patch({ filter: filterSelect.value }));
    motionSelect.addEventListener("change", () => patch({ motion: motionSelect.value }));
    pollInput.addEventListener("change", () => {
      const v = Math.min(60, Math.max(2, Number(pollInput.value) || 8));
      pollInput.value = String(v);
      patch({ pollSeconds: v });
    });
    topCheck.addEventListener("change", () => patch({ alwaysOnTop: topCheck.checked }));
    visibleCheck.addEventListener("change", () => guard(async () => applyState(await call(visibleCheck.checked ? "pet.show" : "pet.hide"))));

    let recording = false;
    recordBtn.addEventListener("click", () => {
      if (recording) return;
      recording = true;
      recordBtn.textContent = t("settings.shortcutRecording");
      const onKey = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
        if (e.key === "Escape") {
          window.removeEventListener("keydown", onKey, true);
          recording = false;
          recordBtn.textContent = t("settings.shortcutRecord");
          return;
        }
        const parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push(navigator.platform.includes("Mac") ? "Command" : "Super");
        if (!parts.length) return;
        parts.push(e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key);
        window.removeEventListener("keydown", onKey, true);
        recording = false;
        recordBtn.textContent = t("settings.shortcutRecord");
        shortcutInput.value = parts.join("+");
        patch({ shortcut: shortcutInput.value });
      };
      window.addEventListener("keydown", onKey, true);
      cleanups.push(() => window.removeEventListener("keydown", onKey, true));
    });
    clearBtn.addEventListener("click", () => { shortcutInput.value = ""; patch({ shortcut: "" }); });

    return {
      wrap, grid, libEmpty,
      sizeRange, sizeOut, filterSelect, motionSelect, pollInput, topCheck, visibleCheck, shortcutInput,
      gridSignature: "",
    };
  }

  /* ---------- 弹层管理 ---------- */
  function revealControls() {
    clearTimeout(hoverTimer);
    if (surface !== "pet") return;
    controls.dataset.revealed = "true";
    handle.setAttribute("aria-expanded", "true");
    bar.hidden = false;
    notifyLayout();
  }
  function queueHideControls() {
    clearTimeout(hoverTimer);
    if (surface !== "pet") return;
    hoverTimer = setTimeout(() => {
      const editing = !composerPanel.hidden && document.hasFocus() && document.activeElement === textarea;
      if (controls.matches(":hover") || activePop?.pop.matches(":hover") || editing || sending || readingAttachments) return;
      setExpanded(null);
      bar.hidden = true;
      controls.dataset.revealed = "false";
      handle.setAttribute("aria-expanded", "false");
      notifyLayout();
    }, 350);
  }
  controls.addEventListener("pointerenter", revealControls);
  controls.addEventListener("pointerleave", queueHideControls);
  controls.addEventListener("focusin", revealControls);
  controls.addEventListener("focusout", queueHideControls);
  handle.addEventListener("click", revealControls);
  window.addEventListener("blur", queueHideControls);
  cleanups.push(() => { clearTimeout(hoverTimer); window.removeEventListener("blur", queueHideControls); });
  function positionPop() {
    if (!activePop) return;
    const { trigger, pop } = activePop;
    const rect = trigger.getBoundingClientRect();
    const margin = 8, gap = 6;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    pop.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    pop.style.maxHeight = "240px";
    const below = Math.max(0, height - rect.bottom - gap - margin);
    const above = Math.max(0, rect.top - gap - margin);
    const naturalHeight = Math.min(240, pop.scrollHeight + 2);
    const useBelow = below >= naturalHeight || below >= above;
    const available = useBelow ? below : above;
    pop.style.maxHeight = `${Math.min(240, available)}px`;
    const bounds = pop.getBoundingClientRect();
    const x = Math.max(margin, Math.min(width - bounds.width - margin, rect.right - bounds.width));
    const y = useBelow ? rect.bottom + gap : rect.top - gap - bounds.height;
    pop.style.left = `${x}px`;
    pop.style.top = `${Math.max(margin, Math.min(height - bounds.height - margin, y))}px`;
  }
  function openPop(trigger, pop) {
    closePops();
    revealControls();
    if (!pop.dataset.hoverHook) {
      pop.dataset.hoverHook = "true";
      pop.addEventListener("pointerenter", revealControls);
      pop.addEventListener("pointerleave", queueHideControls);
    }
    root.append(pop);
    pop.setAttribute("popover", "manual");
    pop.hidden = false;
    pop.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    activePop = { trigger, pop };
    positionPop();
    notifyLayout();
  }
  function closePops() {
    if (!activePop) return;
    activePop.pop.hidePopover();
    activePop.pop.hidden = true;
    activePop.trigger.setAttribute("aria-expanded", "false");
    activePop = null;
    queueHideControls();
    notifyLayout();
  }
  function togglePop(trigger, pop) {
    if (activePop?.pop === pop) closePops(); else openPop(trigger, pop);
  }
  window.addEventListener("resize", positionPop);
  const onScroll = (event) => { if (!activePop?.pop.contains(event.target)) positionPop(); };
  document.addEventListener("scroll", onScroll, true);
  cleanups.push(() => { window.removeEventListener("resize", positionPop); document.removeEventListener("scroll", onScroll, true); closePops(); });
  function toggleSubform(form, btn, forceClose) {
    const show = forceClose ? false : form.hidden;
    form.hidden = !show;
    btn?.setAttribute("aria-expanded", String(show));
    notifyLayout();
  }

  /* ---------- 展开面板 ---------- */
  function setExpanded(name, opts = {}) {
    const next = expanded === name ? null : name;
    if (name) revealControls();
    expanded = next;
    closePops();
    activityPanel.hidden = expanded !== "activity";
    composerPanel.hidden = expanded !== "composer";
    activityBtn.setAttribute("aria-expanded", String(expanded === "activity"));
    composeBtn.setAttribute("aria-expanded", String(expanded === "composer"));
    if (expanded === "composer") {
      onAction("focus-composer");
      if (!opts.noFocus) textarea.focus({ preventScroll: true });
    }
    notifyLayout();
  }

  composeBtn.addEventListener("click", () => setExpanded("composer"));
  activityBtn.addEventListener("click", () => setExpanded("activity"));
  menuBtn.addEventListener("click", () => togglePop(menuBtn, menuPop));

  /* ---------- 主菜单内容 ---------- */
  function buildMenu() {
    menuPop.replaceChildren();
    const items = [
      ["menu.settings", "gear", () => onAction("settings")],
      ["menu.wave", "wave", () => onAction("wave")],
      ["menu.jump", "jump", () => onAction("jump")],
      null,
      ["menu.resetPosition", "crosshair", () => onAction("reset-position")],
      ["menu.hide", "eyeOff", () => onAction("hide")],
    ];
    for (const item of items) {
      if (!item) { menuPop.append(el("div", "pet-menu-sep")); continue; }
      const [key, iconName, fn] = item;
      const b = el("button", "pet-menu-item");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      const s = el("span"); s.dataset.i18n = key;
      b.append(svgIcon(iconName), s);
      b.addEventListener("click", () => { closePops(); fn(); });
      menuPop.append(b);
    }
  }
  buildMenu();

  /* ---------- 快捷输入 ---------- */
  function syncSendState() {
    if (!sending && !readingAttachments) for (const resolve of ioWaiters.splice(0)) resolve();
    const canSend = !sending && !busy && !readingAttachments && (draft.text.trim().length > 0 || draft.attachments.length > 0);
    sendBtn.disabled = !canSend;
    sendBtn.textContent = sending ? t("composer.sending") : t("composer.send");
    textarea.disabled = sending;
  }
  function autosize() {
    textarea.style.height = "32px";
    notifyLayout();
  }
  function renderAttachments() {
    attachList.replaceChildren();
    attachList.hidden = draft.attachments.length === 0;
    draft.attachments.forEach((a, idx) => {
      const chip = el("span", "pet-attach-chip");
      chip.append(el("span", "", a.name));
      chip.title = a.name;
      if (a.mimeType?.startsWith("image/")) {
        const thumbnail = el("img");
        thumbnail.src = `data:${a.mimeType};base64,${a.dataBase64}`;
        thumbnail.alt = a.name;
        chip.prepend(thumbnail);
      }
      const x = el("button", "pet-attach-x");
      x.type = "button";
      x.textContent = "×";
      x.setAttribute("aria-label", t("composer.removeFile", { name: a.name }));
      x.addEventListener("click", () => { draft.attachments.splice(idx, 1); renderAttachments(); syncSendState(); saveDraft(); });
      chip.append(x);
      attachList.append(chip);
    });
  }
  function renderComposerError() {
    composerError.textContent = sendError || state?.draft?.sendError || "";
  }

  function saveDraft() {
    const snapshot = { text: draft.text, attachments: draft.attachments.map((item) => ({ ...item })), skills: [...draft.skills], modelKey: draft.modelKey };
    const task = draftWrites.catch(() => {}).then(() => call("pet.draft", snapshot));
    draftWrites = task;
    task.catch((error) => { if (!disposed) showError(error.message); });
    return task;
  }
  saveDraft.cancel = () => {};
  async function flushDraft() {
    if (sending || readingAttachments) await new Promise((resolve) => ioWaiters.push(resolve));
    return saveDraft();
  }

  textarea.addEventListener("input", () => { draft.text = textarea.value; sendError = null; renderComposerError(); autosize(); syncSendState(); saveDraft(); });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  async function receiveFiles(files) {
    if (sending || !files.length) return;
    readingAttachments += 1;
    syncSendState();
    try {
      for (const file of files) {
        draft.attachments.push({ name: file.name || `pasted-${Date.now()}`, mimeType: file.type || "application/octet-stream", dataBase64: await readFileBase64(file) });
      }
    } catch (error) { showError(error.message); }
    finally {
      readingAttachments -= 1;
      renderAttachments(); syncSendState(); saveDraft(); notifyLayout();
    }
  }
  textarea.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) { textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end"); draft.text = textarea.value; }
    void receiveFiles(files);
  });
  composerPanel.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
  composerPanel.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    void receiveFiles(files);
  });
  sendBtn.addEventListener("click", () => send());

  async function send() {
    if (sending || busy || readingAttachments) return;
    if (!draft.text.trim() && draft.attachments.length === 0) {
      composerError.textContent = t("composer.empty");
      return;
    }
    sending = true;
    // 发送前等待已排队的草稿保存，防止迟到的保存覆盖成功后的清空。
    sendError = null;
    renderComposerError();
    syncSendState();
    const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await draftWrites;
      const res = await call("pet.send", {
        text: draft.text,
        modelKey: draft.modelKey,
        attachments: draft.attachments,
        skills: [...draft.skills],
        requestId,
      });
      draft.text = ""; draft.attachments = []; draft.skills = [];
      textarea.value = "";
      autosize(); renderAttachments();
      await saveDraft();
      if (res?.state) applyState(res.state);
      if (res?.sessionId) setExpanded(null);
    } catch (err) {
      sendError = err.message || t("composer.sendFailed");
      renderComposerError();
    } finally {
      sending = false;
      syncSendState();
      queueHideControls();
    }
  }

  /* ---------- 活动 ---------- */
  function relTime(ts) {
    if (!ts) return "";
    const stamp = typeof ts === "number" ? ts : Date.parse(ts);
    if (!Number.isFinite(stamp)) return "";
    const min = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
    if (min < 1) return t("activity.justNow");
    if (min < 60) return t("activity.minutesAgo", { n: min });
    const h = Math.floor(min / 60);
    if (h < 24) return t("activity.hoursAgo", { n: h });
    return t("activity.daysAgo", { n: Math.floor(h / 24) });
  }
  function unreadCount() {
    const rows = state?.activity?.rows || [];
    return rows.reduce((n, r) => n + (r.unreadCount || 0), 0);
  }
  function renderActivity() {
    const activity = state?.activity;
    const rows = activity?.rows || [];
    activityList.replaceChildren();
    if (!rows.length) {
      const empty = el("div", "pet-empty");
      empty.append(el("strong", "", t("activity.empty")), el("span", "", t("activity.emptyHint")));
      activityList.append(empty);
    }
    rows.forEach((r, i) => {
      const li = el("li", "pet-activity-row");
      li.style.setProperty("--i", i);
      const main = el("button", "pet-activity-main");
      main.type = "button";
      main.title = t("activity.open");
      const chip = el("span", "pet-chip", t(STATUS_KEYS[r.state] || "status.idle"));
      chip.dataset.state = r.state || "";
      const text = el("span", "pet-activity-text");
      const detail = i18n.locale === "en" ? (r.tool && r.state === "running" ? t("activity.using", { name: r.tool }) : r.errorCode && r.state === "blocked" ? `${t("status.blocked")}: ${r.errorCode}` : t(STATUS_KEYS[r.state] || "status.idle")) : r.detail || "";
      text.append(el("span", "pet-activity-title", r.title || r.sessionId), el("span", "pet-activity-detail", detail));
      main.append(chip, text);
      main.addEventListener("click", () => guard(async () => {
        const res = await call("pet.openSession", { sessionId: r.sessionId });
        applyState(res?.state || res);
      }));
      li.append(main);
      const meta = el("div", "pet-activity-meta");
      meta.append(el("span", "", relTime(r.updatedAt)));
      if (r.pendingCount) meta.append(el("span", "", t("activity.pending", { n: r.pendingCount })));
      if (r.queuedCount) meta.append(el("span", "", t("activity.queued", { n: r.queuedCount })));
      if (r.unreadCount) {
        const mark = el("button", "pet-link-btn");
        mark.type = "button";
        mark.textContent = t("activity.markRead");
        mark.addEventListener("click", () => guard(async () => {
          const res = await call("pet.markRead", { sessionId: r.sessionId });
          applyState(res?.state || res);
        }));
        meta.append(mark);
      }
      li.append(meta);
      activityList.append(li);
    });
    // 状态提示：过期 / 错误
    activityNote.replaceChildren();
    activityNote.hidden = true;
    if (activity?.error) {
      activityNote.dataset.tone = "error";
      activityNote.append(el("span", "", `${t("activity.loadError")}：${activity.error}`));
      const retry = el("button", "pet-link-btn");
      retry.type = "button"; retry.textContent = t("common.retry");
      retry.addEventListener("click", () => guard(async () => applyState(await call("pet.refresh"))));
      activityNote.append(retry);
      activityNote.hidden = false;
    } else if (activity?.stale) {
      activityNote.dataset.tone = "warn";
      activityNote.append(el("span", "", t("status.stale")));
      activityNote.hidden = false;
    }
    // 徽标 / 状态点
    const n = unreadCount();
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
    const agg = activity?.state || (rows.find((r) => r.state === "running") ? "running" : rows.find((r) => r.state === "needs-input") ? "needs-input" : rows.find((r) => r.state === "blocked") ? "blocked" : rows.find((r) => r.state === "ready") ? "ready" : null);
    statusDot.dataset.state = agg || "";
    statusText.textContent = t(STATUS_KEYS[agg] || "status.idle");
    markAllBtn.disabled = n === 0;
    if (expanded === "activity") notifyLayout();
  }
  markAllBtn.addEventListener("click", () => guard(async () => applyState(await call("pet.markAllRead"))));

  /* ---------- 宠物库网格 ---------- */
  function renderGrid() {
    if (!settingsEls) return;
    const pets = state?.pets || [];
    const selected = state?.settings?.selectedPetId ?? null;
    const filter = state?.settings?.filter || "pixelated";
    const sig = pets.map((p) => `${p.id}:${p.importedAt}:${p.displayName}`).join("|") + `#${selected}#${filter}`;
    if (sig === settingsEls.gridSignature) return;
    settingsEls.gridSignature = sig;
    settingsEls.grid.replaceChildren();
    const none = el("button", "pet-btn", t("common.none"));
    none.type = "button";
    none.disabled = selected === null;
    none.addEventListener("click", () => guard(async () => applyState(await call("pet.select", { id: null }))));
    settingsEls.grid.append(none);
    settingsEls.libEmpty.hidden = pets.length > 0;
    if (!pets.length) {
      settingsEls.libEmpty.replaceChildren(
        el("strong", "", t("settings.emptyLibrary")),
        el("span", "", t("settings.emptyLibraryHint")),
      );
      return;
    }
    pets.forEach((p, i) => {
      const card = el("article", "pet-card");
      card.style.setProperty("--i", i);
      card.dataset.selected = String(p.id === selected);
      const thumb = el("div", "pet-thumb", t("pet.noPreview"));
      card.append(thumb);
      loadThumb(thumb, p, filter);
      const name = el("div", "pet-card-name", p.displayName || p.id);
      name.title = p.displayName || p.id;
      const desc = el("div", "pet-card-desc", p.description || "");
      const chips = el("div", "pet-card-chips");
      chips.append(
        el("span", "pet-chip", t("pet.version", { n: p.spriteVersionNumber })),
        el("span", "pet-chip", t("pet.dimensions", { w: p.width, h: p.height })),
      );
      if (p.importedAt) chips.append(el("span", "pet-chip", t("pet.importedAt", { date: new Date(p.importedAt).toLocaleDateString(i18n.locale) })));
      const actions = el("div", "pet-card-actions");
      const useBtn = el("button", "pet-btn", p.id === selected ? t("pet.using") : t("pet.use"));
      useBtn.type = "button";
      useBtn.dataset.variant = "primary";
      useBtn.disabled = p.id === selected;
      useBtn.addEventListener("click", () => guard(async () => {
        applyState(await call("pet.select", { id: p.id }));
        onAction("choose-pet", { id: p.id });
      }));
      const exportBtn = el("button", "pet-btn", t("pet.export"));
      exportBtn.type = "button";
      exportBtn.addEventListener("click", () => guard(async () => {
        exportBtn.disabled = true;
        try {
          const res = await call("pet.export", { id: p.id });
          const files = res?.files || [];
          const metadataFile = files.find((f) => f.name === "pet.json");
          if (metadataFile) {
            const manifest = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(metadataFile.dataBase64), (c) => c.charCodeAt(0))));
            const atlas = files.find((f) => f.name === manifest.spritesheetPath);
            if (!atlas) throw new Error(t("pet.assetFailed"));
            manifest.spritesheetPath = atlas.name.replaceAll("\\", "/").split("/").pop();
            const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");
            downloadBase64("pet.json", btoa(Array.from(json, (c) => String.fromCharCode(c)).join("")));
            downloadBase64(manifest.spritesheetPath, atlas.dataBase64);
          }
        } finally { exportBtn.disabled = false; }
      }));
      const removeBtn = el("button", "pet-btn", t("pet.remove"));
      removeBtn.type = "button";
      removeBtn.dataset.variant = "danger";
      removeBtn.addEventListener("click", () => {
        if (removeBtn.dataset.armed === "true") {
          clearTimeout(removeConfirmTimers.get(p.id));
          removeConfirmTimers.delete(p.id);
          guard(async () => applyState(await call("pet.remove", { id: p.id })));
          return;
        }
        removeBtn.dataset.armed = "true";
        removeBtn.textContent = t("pet.removeConfirm");
        removeConfirmTimers.set(p.id, setTimeout(() => {
          removeBtn.dataset.armed = "false";
          removeBtn.textContent = t("pet.remove");
          removeConfirmTimers.delete(p.id);
        }, 3000));
      });
      actions.append(useBtn, exportBtn, removeBtn);
      card.append(name, desc, chips, actions);
      settingsEls.grid.append(card);
    });
  }
  async function loadThumb(thumb, p, filter) {
    try {
      const cacheKey = `${p.id}:${p.importedAt}`;
      if (!assetCache.has(cacheKey)) assetCache.set(cacheKey, call("pet.asset", { id: p.id }));
      const asset = await assetCache.get(cacheKey);
      if (!asset?.dataUrl) throw new Error("empty");
      const img = new Image();
      img.src = asset.dataUrl;
      await img.decode();
      const spec = globalThis.CodexPetFormat.makeSpec(asset.manifest);
      const cell = globalThis.CodexPetFormat.cellFor(spec.animations.idle.frames[0].index, spec.geometry);
      const canvas = el("canvas");
      canvas.width = cell.width; canvas.height = cell.height;
      canvas.setAttribute("aria-label", p.displayName || p.id);
      canvas.style.width = "96px"; canvas.style.height = `${96 * cell.height / cell.width}px`;
      canvas.style.imageRendering = filter === "smooth" ? "auto" : "pixelated";
      canvas.getContext("2d").drawImage(img, cell.x, cell.y, cell.width, cell.height, 0, 0, cell.width, cell.height);
      thumb.replaceChildren(canvas);
    } catch {
      assetCache.delete(`${p.id}:${p.importedAt}`);
      thumb.textContent = t("pet.assetFailed");
    }
  }

  /* ---------- 偏好回填 ---------- */
  function renderSettings() {
    if (!settingsEls || !state?.settings) return;
    const s = state.settings;
    const setIfIdle = (elx, value) => { if (document.activeElement !== elx) elx.value = value; };
    setIfIdle(settingsEls.sizeRange, s.size ?? 96);
    settingsEls.sizeOut.textContent = `${s.size ?? 96} ${t("settings.sizeUnit")}`;
    setIfIdle(settingsEls.filterSelect, s.filter || "pixelated");
    setIfIdle(settingsEls.motionSelect, s.motion || "system");
    setIfIdle(settingsEls.pollInput, s.pollSeconds ?? 8);
    settingsEls.topCheck.checked = s.alwaysOnTop !== false;
    settingsEls.visibleCheck.checked = s.visible !== false;
    setIfIdle(settingsEls.shortcutInput, s.shortcut || "");
  }

  /* ---------- stage 视觉同步 ---------- */
  function renderStage() {
    const s = state?.settings;
    if (!s) return;
    root.style.setProperty("--pet-size", `${s.size ?? 96}px`);
    stage.dataset.filter = s.filter || "pixelated";
    stage.dataset.visible = String(s.visible !== false);
    const motion = s.motion || "system";
    if (motion === "system") delete html.dataset.motion; else html.dataset.motion = motion;
  }

  /* ---------- 文本同步 ---------- */
  function syncTexts() {
    html.lang = i18n.locale;
    for (const n of rootEl.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
    for (const n of rootEl.querySelectorAll("[data-i18n-ph]")) n.placeholder = t(n.dataset.i18nPh);
    for (const n of rootEl.querySelectorAll("[data-i18n-aria]")) n.setAttribute("aria-label", t(n.dataset.i18nAria));
    for (const n of rootEl.querySelectorAll("[data-i18n-title]")) n.title = t(n.dataset.i18nTitle);
  }

  /* ---------- 状态应用 ---------- */
  function applyState(next) {
    if (next && typeof next === "object" && (next.settings || next.pets || next.activity)) update(next);
  }
  function update(next) {
    if (disposed || !next || typeof next !== "object") return;
    const prevLocale = i18n.locale;
    state = next;
    i18n = createI18n(next.locale || html.lang);
    const localeChanged = i18n.locale !== prevLocale;
    if (localeChanged) {
      syncTexts();
      settingsEls && (settingsEls.gridSignature = "");
    }
    // 首次恢复草稿（文本/附件/技能/模型），之后不覆盖用户输入
    if (!draftRestored && next.draft) {
      draftRestored = true;
      draft.text = next.draft.text || "";
      draft.modelKey = "";
      draft.attachments = Array.isArray(next.draft.attachments) ? next.draft.attachments.filter((a) => a && a.name) : [];
      draft.skills = [];
      textarea.value = draft.text;
      autosize();
    }
    renderStage();
    renderActivity();
    renderAttachments();
    renderComposerError();
    syncSendState();
    renderSettings();
    renderGrid();
    loading.hidden = true;
    root.setAttribute("aria-busy", "false");
    for (const warning of next.warnings || []) {
      if (!seenWarnings.has(warning)) { seenWarnings.add(warning); toast(warning, "error"); }
    }
    if (next.error && next.error !== lastStateError) { lastStateError = next.error; showError(next.error); }
  }

  /* ---------- 全局事件 ---------- */
  const onDocPointerDown = (e) => {
    if (!activePop) return;
    if (activePop.pop.contains(e.target) || activePop.trigger.contains(e.target)) return;
    closePops();
  };
  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    if (activePop) { const trig = activePop.trigger; closePops(); trig.focus(); return; }
    if (expanded) { setExpanded(null); composeBtn.focus(); }
    else if (surface === "settings" && !embeddedView) { e.preventDefault(); onAction("close"); }
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  cleanups.push(() => {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
  });

  async function guard(fn) {
    try { await fn(); } catch (err) { showError(err?.message || t("error.generic")); }
  }

  /* ---------- API ---------- */
  const api = {
    update,
    setBusy(value) {
      busy = !!value;
      root.dataset.busy = String(busy);
      syncSendState();
    },
    showError,
    focusComposer() {
      if (surface !== "pet") return;
      if (expanded !== "composer") setExpanded("composer");
      revealControls();
      textarea.focus({ preventScroll: true });
    },
    flushDraft,
    getDraft() {
      return {
        text: draft.text,
        modelKey: draft.modelKey,
        attachments: draft.attachments.map((a) => ({ ...a })),
        skills: [...draft.skills],
      };
    },
    // 契约外补充方法
    expand(name) { setExpanded(name === "composer" || name === "activity" ? name : null); },
    collapse() { setExpanded(null); closePops(); },
    isPreview() { return preview; },
    getState() { return state; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of cleanups) fn();
      for (const id of removeConfirmTimers.values()) clearTimeout(id);
      cancelAnimationFrame(layoutRaf);
      saveDraft.cancel();
      assetCache.clear();
      rootEl.replaceChildren();
      if (window.__codexPetUI === api) delete window.__codexPetUI;
    },
  };
  syncTexts();
  syncSendState();
  window.__codexPetUI = api;
  return api;
}
