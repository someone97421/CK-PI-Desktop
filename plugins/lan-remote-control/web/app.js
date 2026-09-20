import { createLoginView } from "./views/connect.js";
import { el, button, copyText, iconButton, createSheet, closeAllSheets, confirmAction, autoGrow, inlineSpinner } from "./dom.js";
import { createProjectHome } from "./home.js";
import { RemoteClient, EventSocket } from "./transport.js";
import { uuid, TOKEN_STORAGE_KEY, describeError } from "./protocol.js";
import { renderMarkdown } from "./markdown.js";
import {
  responseAnnotationPrompt,
  buildQuoteText,
  requestTextWithoutAnnotations,
} from "./composition.js";
import { mergeLiveEvent } from "./live.js";
import { mergeSnapshot, assertQueueDraftAvailable } from "./recovery.js";
import { createMutationRecovery } from "./mutation-recovery.js";
import { buildProcessTimeline, processSummary } from "./process.js";
import { createSubagentObserver } from "./subagents.js";
import { openModelSettings } from "./model-settings.js";

const subagentObserver = createSubagentObserver();

const liveTools = new Map();
const recentEvents = [];
let snapshotRevision = -1;
let refreshVersion = 0,
  renderVersion = 0,
  eventVersion = 0;
function scheduleRefresh() {
  if (!refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      action(refresh);
    }, 300);
}
function onEvent(frame) {
  if (frame.type !== "event") return;
  const wrapper = frame.event;
  if (wrapper.sessionId !== current) return;
  const event = wrapper.event || wrapper;
  const revision = event.payload?.hostRevision;
  if (Number.isFinite(revision) && revision <= snapshotRevision) return;
  recentEvents.push(wrapper);
  if (recentEvents.length > 2000) recentEvents.shift();
  eventVersion++;
  if (mergeLiveEvent(messages, liveTools, wrapper)) action(drawChat);
  else scheduleRefresh();
}

const root = document.querySelector("#app");
function readToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) || sessionStorage.getItem(TOKEN_STORAGE_KEY) || ""; } catch { return ""; }
}
function storeToken(value) {
  try { localStorage.setItem(TOKEN_STORAGE_KEY, value); }
  catch { try { sessionStorage.setItem(TOKEN_STORAGE_KEY, value); } catch { /* 浏览器禁用存储时，本标签页仍可登录。 */ } }
}
function clearToken() {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); sessionStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
}
let loginVisible = false;
let token = readToken(),
  current = null,
  snapshot = null,
  messages = [],
  uploaded = [],
  annotations = [],
  queuedDraftId = "",
  queuedAttachments = [],
  omittedQueuedRefs = [],
  socket,
  refreshTimer,
  cursor,
  busy = false;
const drafts = new Map(),
  parents = new Map();
const uploadJobs = new Set();
let uploadEpoch = 0;
let capabilities = {};
const positions = new Map();
// UI 状态独立于流式替换的消息对象，按会话和稳定 ID 保存。
const disclosureState = new Map();
let navigationVersion = 0;
const processVisibility = new Map();
function openSheetPanel({ title, subtitle, onClose } = {}) {
  const sheet = createSheet({
    title,
    subtitle,
    onClose: () => {
      sheet.root.remove();
      onClose?.();
    },
  });
  document.body.append(sheet.root);
  sheet.open();
  return sheet;
}
function closeOverlays() {
  closeAllSheets();
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
}
function disclosure(key, label, excerpt, ...children) {
  const stateKey = `${current}:${key}`;
  const details = el("details", { className: "remote-process", open: disclosureState.get(stateKey) || false },
    el("summary", {}, el("span", { className: "remote-process-label", text: label }),
      el("span", { className: "remote-process-excerpt", text: String(excerpt || "").replace(/\s+/g, " ") })),
    el("div", { className: "remote-process-body" }, ...children));
  details.dataset.disclosureKey = stateKey;
  details.querySelector("summary").addEventListener("click", (event) => {
    event.preventDefault();
    details.open = !details.open;
    disclosureState.set(stateKey, details.open);
  });
  details.addEventListener("toggle", () => {
    if (details.isConnected) disclosureState.set(stateKey, details.open);
  });
  return details;
}
function setPage(page) {
  navigationVersion++;
  root.dataset.page = page;
  header.querySelector("strong").textContent = page === "chat" ? "任务会话" : "这是一个助手 · 远程控制";
}
function showHome({ reload = true } = {}) {
  if (loginVisible) return;
  saveDraft();
  if (current) positions.set(current, transcript.scrollTop);
  socket?.unsubscribe(current);
  subagentObserver.close();
  closeOverlays();
  renderVersion++; refreshVersion++;
  current = null; snapshot = null; messages = []; liveTools.clear(); recentEvents.length = 0;
  setPage("home");
  if (reload) void home.load();
}
function backHome() {
  if (history.state?.remotePage === "chat") history.back();
  else showHome();
}
function saveDraft() {
  if (!current) return;
  drafts.set(current, {
    text: input.value,
    uploaded,
    annotations,
    queuedDraftId,
    queuedAttachments,
    omittedQueuedRefs,
  });
  persistDrafts();
}
function persistDrafts() {
  try {
    sessionStorage.setItem(
      "lan-remote-drafts",
      JSON.stringify([...drafts].slice(-30)),
    );
  } catch {}
}
try {
  for (const [id, draft] of JSON.parse(
    sessionStorage.getItem("lan-remote-drafts") || "[]",
  ))
    drafts.set(id, draft);
} catch {}
try {
  for (const [id, parent] of JSON.parse(
    sessionStorage.getItem("lan-remote-parents") || "[]",
  ))
    parents.set(id, parent);
} catch {}
window.addEventListener("pagehide", saveDraft);
const notice = el("p", {
  className: "connection-banner",
  attrs: { role: "status" },
});
const header = el(
  "header",
  { className: "topbar" },
  button("返回项目与对话", { iconName: "back", className: "home-back", onClick: backHome }),
  el("strong", { text: "这是一个助手 · 远程" }),
  button("退出登录", {
    className: "logout-button",
    onClick: () => action(async () => {
      await api.logout();
      token = ""; clearToken(); showLogin(); notice.textContent = "已退出登录";
    }),
  }),
  button("主题", {
    onClick: () => {
      document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === "light" ? "dark" : "light";
      try { localStorage.setItem("lan-remote-theme", document.documentElement.dataset.theme); } catch {}
    },
  }),
);
const transcript = el("main", { className: "remote-transcript" }),
  composer = el("form", { className: "remote-composer" });
const chatHeading = el("div", { className: "remote-chat-heading" });
const jumpLatest = button("回到最新消息 ↓", { className: "remote-jump", preserveLabel: true,
  onClick: () => { transcript.scrollTop = transcript.scrollHeight; updateJump(); } });
jumpLatest.hidden = true;
function updateJump() {
  jumpLatest.hidden = !current || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
}
transcript.addEventListener("scroll", updateJump, { passive: true });
function updateViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale !== 1) return;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
  document.documentElement.style.setProperty("--rc-visible-height", `${viewport?.height || window.innerHeight}px`);
  document.documentElement.style.setProperty("--rc-visible-top", `${viewport?.offsetTop || 0}px`);
  // 软键盘占位：底部面板与输入区据此避开键盘（iOS 不改变布局视口高度）。
  const keyboard = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  document.documentElement.style.setProperty("--rc-keyboard-inset", `${keyboard}px`);
  if (atBottom) requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
}
window.visualViewport?.addEventListener("resize", updateViewport);
window.visualViewport?.addEventListener("scroll", updateViewport, { passive: true });
window.addEventListener("resize", updateViewport);
window.addEventListener("pageshow", updateViewport);
updateViewport();
const input = el("textarea", {
  attrs: { placeholder: "发送消息…", "aria-label": "消息", rows: 1 },
});
// 输入框随内容自适应增高；程序化改写 value 后需手动调用一次。
const growInput = autoGrow(input, {
  maxHeight: () => Math.min(240, (window.visualViewport?.height || window.innerHeight) * 0.28),
});
window.visualViewport?.addEventListener("resize", growInput);
window.addEventListener("resize", growInput);
const attachmentList = el("div"),
  annotationList = el("div");
const send = button("发送", { variant: "primary", type: "submit", className: "composer-send" });
const attachButton = iconButton("attach", { title: "添加附件", className: "composer-attach", onClick: () => fileInput.click() });
const stopButton = button("停止", {
  className: "composer-stop",
  onClick: () => action(async () => {
    if (!current || stopButton.disabled) return;
    const sessionId = current;
    stopButton.disabled = true;
    try {
      await mutate("chat.stop", { sessionId });
      if (current === sessionId) await refresh();
    } finally {
      stopButton.disabled = false;
    }
  }),
});
stopButton.hidden = true;
const modelChip = button("模型", {
  iconName: "model",
  preserveLabel: true,
  className: "composer-model",
  onClick: openSessionSettings,
});
const moreButton = iconButton("more", { title: "更多操作", className: "composer-more", onClick: openComposerMore });
const modelLabels = new Map();
function currentModelLabel() {
  const key = snapshot?.session?.modelKey;
  return (key && modelLabels.get(key)) || key || "";
}
function updateComposerState() {
  const running = !!(snapshot?.session?.running || snapshot?.status?.running);
  stopButton.hidden = !running;
  const label = currentModelLabel();
  const text = label ? `模型：${label}` : "模型";
  modelChip.querySelector(".btn-label").textContent = text;
  modelChip.title = label ? text : "模型设置";
  modelChip.setAttribute("aria-label", modelChip.title);
}
function openComposerMore() {
  if (!current) return;
  const sheet = openSheetPanel({ title: "更多操作", subtitle: "命令、技能与待发队列" });
  const list = el("div", { className: "sheet-list" },
    button("命令/技能", { preserveLabel: true, iconName: "commands", onClick: () => { sheet.close(); action(commands); } }),
    button("队列", { preserveLabel: true, iconName: "queue", onClick: () => { sheet.close(); action(queue); } }));
  sheet.body.append(list);
}
const api = new RemoteClient({
  getToken: () => token,
  onUnauthorized: () => {
    token = "";
    clearToken();
    socket?.close?.();
    showLogin();
    notice.textContent = "登录已失效，请重新输入主机密码。";
  },
});
function report(error) {
  notice.textContent = describeError(error) || String(error?.message || error);
}
async function action(fn) {
  try {
    return await fn();
  } catch (e) {
    report(e);
    return undefined;
  }
}
const home = createProjectHome({
  read: (...args) => api.read(...args),
  openSession,
  createSession: async (projectId) => {
    const version = navigationVersion;
    const result = await mutate("sessions.create", { projectId });
    if (version === navigationVersion && !loginVisible) await openSession(result.session.id);
  },
  report,
});
window.addEventListener("popstate", (event) => {
  if (loginVisible) return;
  if (event.state?.remotePage === "chat" && event.state.sessionId)
    action(() => openSession(event.state.sessionId, { navigate: false }));
  else showHome();
});
try {
  const theme = localStorage.getItem("lan-remote-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
const recoveryPanel = el("section", { className: "connection-banner" });
const recovery = createMutationRecovery({
  api,
  storage: sessionStorage,
  uuid,
  onPending: drawRecovery,
});
function drawRecovery() {
  recoveryPanel.replaceChildren();
  if (!recovery.pending) return;
  recoveryPanel.append(
    el("p", { text: "存在未确认提交；已暂停新的变更请求。" }),
    button("查询原提交", {
      onClick: () =>
        action(async () => {
          const settled = await recovery.resolve();
          if (settled) {
            if (settled.operation === "queue.edit" && settled.result?.draft) {
              const d = settled.result.draft;
              const target = settled.input.sessionId;
              const existing = drafts.get(target) || {};
              drafts.set(target, {
                ...existing,
                text:
                  (existing.text
                    ? existing.text + String.fromCharCode(10, 10)
                    : "") + d.text,
                queuedDraftId: d.id,
                queuedAttachments: d.attachments || [],
                omittedQueuedRefs: [],
              });
              if (current === target) {
                const restored = drafts.get(target);
                input.value = restored.text;
                queuedDraftId = d.id;
                queuedAttachments = d.attachments || [];
                omittedQueuedRefs = [];
                renderAttachments();
                saveDraft();
              } else await openSession(target);
            }
            if (["chat.edit", "chat.retry"].includes(settled.operation))
              resetHistory = true;
            if (settled.operation === "chat.send") {
              drafts.delete(settled.input.sessionId);
              if (current === settled.input.sessionId) {
                if(responseAnnotationPrompt(input.value,annotations)===settled.input.text){input.value='';annotations=[];}
                uploaded=uploaded.filter(a=>!settled.input.attachmentIds?.includes(a.id));
                if(queuedDraftId===settled.input.queuedDraftId){queuedDraftId='';queuedAttachments=[];omittedQueuedRefs=[];}
                saveDraft();
                renderAttachments();
              }
            }
            await refresh();
          }
        }),
    }),
    button("已核对，解除未决状态", {
      onClick: () =>
        action(async () => {
          const ok = await confirmAction({
            title: "解除未决状态",
            detail: "核对当前会话后解除未决状态？此操作不会重发消息。",
            confirmLabel: "解除",
          });
          if (ok) await recovery.acknowledge();
        }),
    }),
  );
}
async function mutate(op, data) {
  if (capabilities.operations?.[op]?.supported === false)
    throw new Error("宿主不支持此功能");
  if (op === "queue.edit") assertQueueDraftAvailable(queuedDraftId);
  const result = await recovery.mutate(op, data);
  if (["chat.edit", "chat.retry"].includes(op)) resetHistory = true;
  return result;
}
let resetHistory = false;

function layout() {
  root.replaceChildren(
    header,
    notice,
    recoveryPanel,
    el(
      "div",
      { className: "remote-layout" },
      home.root,
      el("section", { className: "remote-chat" }, chatHeading, transcript, jumpLatest, composer),
    ),
  );
  drawRecovery();
  delete document.documentElement.dataset.booting;
}
function showLogin() {
  if (loginVisible) return;
  saveDraft();
  uploadEpoch++;
  for (const draft of drafts.values()) {
    draft.uploaded = (draft.uploaded || []).map((attachment) => ({ ...attachment, expired: true }));
  }
  persistDrafts();
  loginVisible = true;
  subagentObserver.close();
  chatHeading.replaceChildren();
  jumpLatest.hidden = true;
  root.dataset.authenticated = "false";
  renderVersion++; refreshVersion++;
  current = null; snapshot = null; messages = []; liveTools.clear(); recentEvents.length = 0;
  socket?.close?.();
  closeOverlays();
  layout();
  setPage("login");
  home.reset(); composer.hidden = true;
  recoveryPanel.hidden = true;
  history.replaceState(null, "", location.pathname);
  transcript.replaceChildren(createLoginView({
    login: (password, name) => api.login(password, name),
    onSuccess: async (result) => { token = result.token; storeToken(token); await start(); },
    onError: report,
  }));
}
async function openSession(id, { navigate = true } = {}) {
  if (loginVisible || !token) return;
  renderVersion++;
  subagentObserver.close();
  closeOverlays();
  saveDraft();
  if (current) positions.set(current, transcript.scrollTop);
  socket?.unsubscribe(current);
  current = id;
  if (navigate) {
    const state = { remotePage: "chat", sessionId: id };
    if (root.dataset.page === "home") history.pushState(state, "", location.pathname);
    else history.replaceState(state, "", location.pathname);
  }
  setPage("chat");
  composer.hidden = false;
  transcript.replaceChildren(el("p", { className: "connection-banner", text: "正在加载会话…", attrs: { role: "status" } }));
  liveTools.clear();
  chatHeading.replaceChildren();
  snapshotRevision = -1;
  recentEvents.length = 0;
  snapshot = null;
  resetHistory = true;
  messages = [];
  const draft = drafts.get(id) || {};
  input.value = draft.text || "";
  growInput();
  updateComposerState();
  uploaded = draft.uploaded || [];
  annotations = draft.annotations || [];
  queuedDraftId = draft.queuedDraftId || "";
  queuedAttachments = draft.queuedAttachments || [];
  omittedQueuedRefs = draft.omittedQueuedRefs || [];
  renderAttachments();
  socket?.subscribe(id);
  await refresh();
  if (current === id) {
    transcript.scrollTop = positions.has(id) ? positions.get(id) : transcript.scrollHeight;
    updateJump();
  }
}
async function refresh() {
  if (!current || !token) return;
  const id = current,
    version = ++refreshVersion,
    events = eventVersion;
  const r = await api.read("sessions.get", { sessionId: id });
  if (current !== id || version !== refreshVersion) return;
  if (events !== eventVersion && !Number.isFinite(r.snapshot?.revision)) {
    scheduleRefresh();
    return;
  }
  const previousCursor = cursor,
    previousHasMore = snapshot?.messages?.hasMoreBefore;
  const reset = resetHistory;
  const merged = mergeSnapshot(messages, r, { reset });
  snapshot = r;
  snapshotRevision = r.snapshot?.revision ?? -1;
  messages = merged.messages;
  liveTools.clear();
  for (const [id, tool] of merged.tools) liveTools.set(id, tool);
  resetHistory = false;
  const keepHistory =
    !reset &&
    Number.isFinite(previousCursor) &&
    previousCursor < (r.messages?.cursor ?? 0);
  if (keepHistory) snapshot.messages.hasMoreBefore = previousHasMore;
  for (const frame of recentEvents) {
    const revision = (frame.event || frame).payload?.hostRevision;
    if (Number.isFinite(revision) && revision > snapshotRevision)
      mergeLiveEvent(messages, liveTools, frame);
  }
  const revisions = recentEvents
    .map((frame) => (frame.event || frame).payload?.hostRevision)
    .filter(Number.isFinite);
  snapshotRevision = Math.max(snapshotRevision, ...revisions);
  recentEvents.length = 0;
  cursor = keepHistory ? previousCursor : r.messages?.cursor;
  await drawChat();
}
async function drawChat() {
  const renderedSession = current;
  const version = ++renderVersion;
  const container = document.createDocumentFragment();
  const timeline = buildProcessTimeline(messages, liveTools);
  const cards = new Map();
  const processToggle = button(processVisibility.get(current) ? "收起过程" : "展开过程", {
    iconName: "info",
    preserveLabel: true,
    onClick: () => {
      const open = !processVisibility.get(current);
      processVisibility.set(current, open);
      for (const entry of timeline.entries) if (entry.rows) disclosureState.set(`${current}:task:${entry.key}`, open);
      action(drawChat);
    },
  });
  processToggle.setAttribute("aria-pressed", String(!!processVisibility.get(current)));
  if (snapshot?.messages?.hasMoreBefore)
    container.append(
      button("加载更早消息", {
        onClick: () =>
          action(async () => {
            const sessionId = current;
            const page = await api.read("sessions.messages", {
              sessionId,
              before: cursor,
            });
            if (current !== sessionId) return;
            messages = [
              ...new Map(
                [...(page.items || []), ...messages].map((m) => [m.id, m]),
              ).values(),
            ];
            cursor = page.cursor;
            snapshot.messages.hasMoreBefore = page.hasMoreBefore;
            await drawChat();
          }),
      }),
    );
  for (const m of timeline.rows) {
    if (m.role === "tool") {
      const name = m.toolName || "工具";
      const label = /bash|terminal|exec/i.test(name) ? "›_ 终端" : /^Task|agent/i.test(name) ? "◇ 子代理" : "⌘ 工具";
      const state = m.toolStatus === "running" ? "执行中" : m.isError || m.toolStatus === "error" ? "失败" : "完成";
      const detail = disclosure(`tool:${m.toolCallId || m.id}`, label, `${state} · ${name} · ${JSON.stringify(m.toolArgs || {})}`,
        el("pre", { text: JSON.stringify(m.toolArgs || {}, null, 2) }),
        el("pre", { text: typeof m.toolResult === "string" ? m.toolResult : JSON.stringify(m.toolResult ?? m.content ?? "等待工具输出…", null, 2) }));
      detail.id = `message-${m.id}`;
      detail.dataset.error = String(!!m.isError || m.toolStatus === "error");
      if (/^Task|agent/i.test(name)) detail.lastElementChild.append(button("观测子代理", {
        preserveLabel: true, onClick: () => subagentObserver.open(m.toolCallId || m.id),
      }));
      cards.set(m.id, detail);
      continue;
    }
    const card = el(
      "article",
      { className: `remote-message ${m.role}` },
      el("div", { className: "remote-message-heading" },
        el("small", {
          text: m.role === "user" ? "你" : m.role === "assistant" ? "助手" : m.role,
        })),
    );
    card.id = `message-${m.id}`;
    card.append(
      await renderMarkdown(
        m.role === "user"
          ? requestTextWithoutAnnotations(m.content || "")
          : m.content || "",
      ),
    );
    if (m.role === "assistant") {
      const prior = timeline.rows
        .slice(0, timeline.rows.indexOf(m))
        .reverse()
        .find((x) => x.role === "user");
      const block = prior?.content?.match(
        /<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/,
      );
      if (block)
        try {
          const sources = JSON.parse(block[1]);
          for (const match of (m.content || "").matchAll(
            /:codex-annotation\{index="(\d+)"\}/g,
          )) {
            const a = sources[Number(match[1]) - 1];
            if (!a) continue;
            card.append(
              button(`批注 ${match[1]}`, {
                onClick: () => {
                  const source = document.getElementById(
                    `message-${a.source?.messageId}`,
                  );
                  if (source) {
                    for (let parent = source.parentElement; parent; parent = parent.parentElement)
                      if (parent.tagName === "DETAILS") {
                        parent.open = true;
                        if (parent.dataset.disclosureKey) disclosureState.set(parent.dataset.disclosureKey, true);
                      }
                    source.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
                  } else
                    showText(
                      `批注 ${match[1]}`,
                      `${a.text}\n\n${a.annotation || ""}`,
                    );
                },
              }),
            );
          }
        } catch {}
    }
    if (m.thinking)
      card.append(disclosure(`thinking:${m.id}`, "◇ 思考", m.thinking, el("pre", { text: m.thinking })));
    for (const a of m.attachments || [])
      card.append(
        button(a.name || "附件", {
          preserveLabel: true,
          iconName: "attach",
          onClick: () =>
            action(async () => {
              const p = await api.read("attachments.read", {
                sessionId: current,
                ref: a.ref,
              });
              if (p.kind === "image") {
                const dialog = el(
                  "dialog",
                  {},
                  el("img", {
                    attrs: {
                      src: p.dataUrl,
                      alt: a.name,
                      style: "max-width:100%",
                    },
                  }),
                  button("关闭", { onClick: () => dialog.remove() }),
                );
                document.body.append(dialog);
                dialog.showModal();
              } else showText(a.name, p.content || "此附件无法在线预览");
            }),
        }),
      );
    const actions = el(
      "div",
      { className: "row-actions" },
      button("复制", { onClick: () => copyText(m.content || "") }),
      button("引用", {
        onClick: () => {
          input.value += `${input.value ? "\n\n" : ""}${buildQuoteText(window.getSelection()?.toString() || m.content, `引用自 ${snapshot.session.title || "会话"}`)}\n`;
          growInput();
          input.focus();
        },
      }),
    );
    if (m.role === "assistant") {
      actions.append(
        button("批注", {
          onClick: () => openAnnotationSheet(m),
        }),
        button("侧边对话", {
          onClick: () =>
            action(async () => {
              const parent = current;
              const version = navigationVersion;
              const r = await mutate("sessions.fork", {
                sessionId: parent,
                throughMessageId: m.id,
                title: "侧边对话",
              });
              parents.set(r.session.id, parent);
              sessionStorage.setItem(
                "lan-remote-parents",
                JSON.stringify([...parents]),
              );
              if (version === navigationVersion && !loginVisible) await openSession(r.session.id);
            }),
        }),
      );
    }
    if (m.role === "user")
      actions.append(
        button("编辑重发", {
          onClick: () => openEditSheet(m),
        }),
        button("重试", {
          onClick: () =>
            action(async () => {
              await mutate("chat.retry", {
                sessionId: current,
                messageId: m.id,
              });
              await refresh();
            }),
        }),
      );
    let menuSheet = null;
    // 先关闭面板解除焦点占用，再让按钮处理复制或将焦点交给输入框。
    actions.addEventListener("click", (event) => {
      if (event.target.closest("button")) menuSheet?.close();
    }, { capture: true });
    for (const item of actions.children) item.classList.remove("btn-icon-action");
    card.querySelector(".remote-message-heading").append(iconButton("more", {
      title: "消息操作",
      className: "remote-message-more",
      onClick: () => {
        menuSheet = openSheetPanel({ title: "消息操作" });
        menuSheet.body.append(el("div", { className: "sheet-list" }, actions));
      },
    }));
    cards.set(m.id, card);
  }
  for (const entry of timeline.entries) {
    if (entry.message) { container.append(cards.get(entry.message.id)); continue; }
    const process = entry.rows.filter((m) => m.id !== entry.finalId).map((m) => cards.get(m.id));
    const finalCard = entry.finalId ? cards.get(entry.finalId) : null;
    const thinking = finalCard?.querySelector(".remote-process");
    if (thinking) process.push(thinking);
    if (process.length || entry.task) {
      const summary = processSummary(entry.task);
      const detail = disclosure(`task:${entry.key}`, summary.label, summary.detail,
        ...(summary.breakdown ? [el("p", { className: "connection-banner", text: summary.breakdown })] : []),
        ...process);
      detail.classList.add("remote-task-process");
      detail.dataset.error = String(entry.task?.status === "failed");
      container.append(detail);
    }
    if (finalCard) container.append(finalCard);
  }
  if (version !== renderVersion || current !== renderedSession) return;
  subagentObserver.update(current, messages, liveTools);
  const scroll = transcript.scrollTop;
  const nearBottom = transcript.scrollHeight - scroll - transcript.clientHeight < 100;
  const focusedDisclosure = document.activeElement?.closest("details")?.dataset.disclosureKey;
  const title = snapshot?.session?.title || "对话";
  chatHeading.replaceChildren(el("div", { className: "remote-chat-titlebar" },
    el("h2", { text: title, attrs: { title } }),
    processToggle,
    iconButton("more", { title: "会话操作", onClick: openChatMore })));
  const pendingCount = ["plans", "approvals", "questions"].reduce((count, key) => count + (snapshot?.pending?.[key]?.length || 0), 0);
  const running = !!(snapshot?.session?.running || snapshot?.status?.running);
  const statusRow = el("div", { className: "remote-chat-status" },
    el("span", { className: `remote-run-status${running ? " is-running" : ""}`, text: running ? "正在处理" : "就绪" }),
    button(subagentObserver.buttonLabel(), { iconName: "sidechat", preserveLabel: true, onClick: () => subagentObserver.open() }));
  if (pendingCount) statusRow.append(button(`待处理 ${pendingCount}`, {
    iconName: "warning", preserveLabel: true, className: "remote-pending-chip",
    onClick: () => transcript.querySelector(".approval-card")?.scrollIntoView({ block: "start" }),
  }));
  chatHeading.append(statusRow);
  updateComposerState();
  transcript.replaceChildren(container);
  renderPending();
  if (focusedDisclosure) {
    const matching = [...transcript.querySelectorAll("details")].find((node) => node.dataset.disclosureKey === focusedDisclosure);
    matching?.querySelector("summary")?.focus({ preventScroll: true });
  }
  if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
  else transcript.scrollTop = scroll;
  updateJump();
}
function openChatMore() {
  if (!current) return;
  const sheet = openSheetPanel({ title: snapshot?.session?.title || "会话", subtitle: "会话操作" });
  const list = el("div", { className: "sheet-list" });
  const add = (label, options) =>
    list.append(button(label, {
      preserveLabel: true,
      ...options,
      onClick: () => { sheet.close(); options.onClick(); },
    }));
  add("刷新", { iconName: "refresh", onClick: () => action(refresh) });
  if (parents.has(current))
    add("返回主对话", { iconName: "back", onClick: () => action(() => openSession(parents.get(current))) });
  for (const [child, parent] of parents)
    if (parent === current)
      add("打开侧边对话", { iconName: "sidechat", onClick: () => action(() => openSession(child)) });
  add(subagentObserver.buttonLabel(), { iconName: "sidechat", onClick: () => subagentObserver.open() });
  const pendingCount = ["plans", "approvals", "questions"].reduce((count, key) => count + (snapshot?.pending?.[key]?.length || 0), 0);
  if (pendingCount)
    add(`待处理 ${pendingCount}`, { iconName: "warning", onClick: () => {
      transcript.querySelector(".approval-card")?.scrollIntoView({ block: "start" });
    } });
  sheet.body.append(list);
}
function showText(title, text) {
  const sheet = openSheetPanel({ title });
  sheet.body.append(el("pre", { className: "sheet-text", text }));
}
function openAnnotationSheet(m) {
  const sessionId = current;
  const selection = (window.getSelection()?.toString() || m.content || "").slice(0, 2000);
  const sheet = openSheetPanel({ title: "添加批注", subtitle: "批注随下一条消息一起发送" });
  const noteInput = el("textarea", { attrs: { "aria-label": "批注内容", placeholder: "批注内容…" } });
  sheet.body.append(
    el("p", { className: "sheet-quote", text: selection }),
    el("label", { className: "sheet-field" }, "批注内容", noteInput),
  );
  const submit = button("添加批注", {
    variant: "primary",
    onClick: () => {
      if (current !== sessionId || loginVisible) { sheet.close(); return; }
      annotations.push({ messageId: m.id, text: selection, annotation: noteInput.value });
      renderAttachments();
      saveDraft();
      sheet.close();
    },
  });
  sheet.panel.append(el("div", { className: "sheet-foot" },
    button("取消", { variant: "secondary", onClick: () => sheet.close() }), submit));
}
function openEditSheet(m) {
  const sessionId = current, navigation = navigationVersion;
  const sheet = openSheetPanel({ title: "编辑重发", subtitle: "修改后重新生成，后续消息会被替换" });
  const editInput = el("textarea", { value: m.content || "", attrs: { "aria-label": "消息内容" } });
  sheet.body.append(el("label", { className: "sheet-field" }, "消息内容", editInput));
  const submit = button("重新生成", { variant: "primary" });
  submit.addEventListener("click", () => {
    if (submit.disabled || !sheet.isOpen()) return;
    const text = editInput.value;
    sheet.setBusy(true);
    void (async () => {
      try {
        if (current !== sessionId || navigation !== navigationVersion || loginVisible) { sheet.close({ force: true }); return; }
        await mutate("chat.edit", { sessionId, messageId: m.id, text });
        sheet.setBusy(false);
        sheet.close();
        if (current === sessionId && navigation === navigationVersion) await refresh();
      } catch (error) {
        sheet.setBusy(false);
        sheet.showError(describeError(error));
        report(error);
      }
    })();
  });
  sheet.panel.append(el("div", { className: "sheet-foot" },
    button("取消", { variant: "secondary", onClick: () => sheet.close() }), submit));
}
function renderPending() {
  for (const plan of snapshot?.pending?.plans || []) {
    const box = el(
      "section",
      { className: "approval-card" },
      el("strong", { text: plan.title || "计划审批" }),
      el("pre", { text: plan.markdown || plan.content || plan.plan || "" }),
      el("p", { text: "在此批准或拒绝本次操作。" }),
    );
    for (const [label, decision] of [
      ["批准", "approve"],
      ["拒绝", "reject"],
    ])
      box.append(
        button(label, {
          onClick: () =>
            action(async () => {
              await mutate("plans.resolve", {
                sessionId: current,
                proposalId: plan.id || plan.proposalId,
                action: decision,
                version: plan.version,
                targetPermissionMode:
                  snapshot?.session?.permissionMode === "inherit"
                    ? "ask"
                    : snapshot?.session?.permissionMode || "ask",
              });
              await refresh();
            }),
        }),
      );
    transcript.append(box);
  }
  for (const a of snapshot?.pending?.approvals || []) {
    const box = el(
      "section",
      { className: "approval-card" },
      el("strong", { text: a.summary || a.toolName || "需要确认" }),
      el("p", { text: "选择处理方式后立即提交。" }),
    );
    for (const decision of a.allowedDecisions || []) {
      box.append(
        button(decision, {
          iconName: /deny|reject|cancel/.test(decision) ? "close" : /always|session/.test(decision) ? "shield" : "check",
          onClick: () =>
            action(async () => {
              if (a.kind !== "tool") {
                report(new Error("计划审批请使用下方计划列表，或回到电脑处理"));
                return;
              }
              await mutate("approval.resolve", {
                sessionId: current,
                approvalId: a.approvalId,
                decision,
              });
              await refresh();
            }),
        }),
      );
    }
    transcript.append(box);
  }
  for (const q of snapshot?.pending?.questions || []) {
    const box = el(
      "section",
      { className: "approval-card" },
      el("strong", { text: "智能体提问" }),
    );
    const fields = q.questions.map((question, index) => {
      const group = el(
        "fieldset",
        {},
        el("legend", { text: question.question }),
      );
      const choices = (question.options || []).map((option) => {
        const label = typeof option === "string" ? option : option.label;
        const field = el("input", {
          type: question.multiSelect ? "checkbox" : "radio",
          value: label,
          attrs: { name: `ask-${q.inputId}-${index}` },
        });
        group.append(el("label", {}, field, label));
        return field;
      });
      const other = el("textarea", {
        attrs: { placeholder: "其他回答（留空且不选择表示跳过）" },
      });
      group.append(other);
      box.append(group);
      return () => {
        const values = choices
          .filter((field) => field.checked)
          .map((field) => field.value);
        if (other.value.trim()) {
          if (!question.multiSelect) return [other.value.trim()];
          values.push(other.value.trim());
        }
        return values.length ? values : null;
      };
    });
    box.append(
      button("提交回答", {
        onClick: () =>
          action(async () => {
            await mutate("ask.resolve", {
              sessionId: current,
              inputId: q.inputId,
              answers: fields.map((read) => read()),
            });
            await refresh();
          }),
      }),
    );
    transcript.append(box);
  }
}
function renderAttachments() {
  attachmentList.replaceChildren(
    ...[...uploadJobs].filter((job) => job.sessionId === current).map((job) =>
      el("span", { className: "attachment-chip", attrs: { role: "status" } },
        job.error ? `${job.file.name}：${job.error}` : `正在上传 ${job.file.name}…`,
        job.error ? button("重试上传", { preserveLabel: true, onClick: () => action(() => uploadFile(job)) }) : null,
        job.error ? button("移除", { onClick: () => { uploadJobs.delete(job); renderAttachments(); } }) : null)),
    ...queuedAttachments
      .filter((a) => !omittedQueuedRefs.includes(a.ref))
      .map((a) =>
        el(
          "span",
          { className: "attachment-chip" },
          a.name,
          button("移除", {
            onClick: () => {
              omittedQueuedRefs.push(a.ref);
              renderAttachments();
            },
          }),
        ),
      ),
    ...uploaded.map((a) =>
      el(
        "span",
        { className: "attachment-chip" },
        a.expired ? `${a.name}（登录已更换，请移除后重新选择）` : a.name,
        a.expired ? null : button("预览", {
          onClick: () =>
            action(async () => {
              const blob = await api.fetchAttachmentBlob(a.id);
              if (a.kind === "image") {
                const url = URL.createObjectURL(blob);
                const dialog = el(
                  "dialog",
                  {},
                  el("img", {
                    attrs: { src: url, alt: a.name, style: "max-width:100%" },
                  }),
                );
                const close = () => {
                  URL.revokeObjectURL(url);
                  dialog.remove();
                };
                dialog.append(button("关闭", { onClick: close }));
                dialog.addEventListener("close", close, { once: true });
                document.body.append(dialog);
                dialog.showModal();
              } else
                showText(
                  a.name,
                  blob.type.startsWith("text/") ||
                    blob.type === "application/json"
                    ? await blob.text()
                    : "PDF 附件已上传，将交给电脑处理",
                );
            }),
        }),
        button("移除", {
          onClick: () => {
            uploaded = uploaded.filter((x) => x !== a);
            renderAttachments();
          },
        }),
      ),
    ),
  );
  annotationList.replaceChildren(
    ...annotations.map((a, i) =>
      el(
        "div",
        {},
        `批注 ${i + 1}：${a.annotation}`,
        button("移除", {
          onClick: () => {
            annotations.splice(i, 1);
            renderAttachments();
          },
        }),
      ),
    ),
  );
}
const fileInput = el("input", {
  type: "file",
  attrs: {
    multiple: true,
    accept:
      "image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,.csv,.json",
    hidden: true,
  },
});
async function uploadFile(job) {
  if (job.running) return;
  job.running = true;
  job.error = "";
  renderAttachments();
  const epoch = uploadEpoch;
  try {
    if (loginVisible || !token) throw new Error("请先重新登录，再重试上传。");
    const attachment = await api.upload(job.file, job.sessionId);
    if (epoch !== uploadEpoch) throw new Error("登录已更换，请重试上传。");
    if (current === job.sessionId) {
      uploaded.push(attachment);
      saveDraft();
    } else {
      const draft = drafts.get(job.sessionId) || {};
      draft.uploaded = [...(draft.uploaded || []), attachment];
      drafts.set(job.sessionId, draft);
      persistDrafts();
    }
    uploadJobs.delete(job);
  } catch (error) {
    job.error = describeError(error) || String(error?.message || error);
  } finally {
    job.running = false;
    renderAttachments();
  }
}
fileInput.addEventListener("change", () => {
  // 原生文件选择器返回后立即快照，允许再次选择同一张图，不跨 await 读取活动 FileList。
  const files = Array.from(fileInput.files || []);
  fileInput.value = "";
  if (!files.length) return;
  if (!current) { report(new Error("请先选择会话")); return; }
  const sessionId = current;
  const jobs = files.map((file) => ({ file, sessionId, error: "", running: false }));
  for (const job of jobs) uploadJobs.add(job);
  renderAttachments();
  void action(async () => { for (const job of jobs) await uploadFile(job); });
});
function openSessionSettings() {
  const sessionId = current, navigation = navigationVersion;
  if (!sessionId || loginVisible) return;
  openModelSettings({
    sessionId,
    read: (...args) => api.read(...args),
    save: mutate,
    openSheet: openSheetPanel,
    isCurrent: () => current === sessionId && navigationVersion === navigation && !loginVisible,
    onCatalog: (models) => {
      modelLabels.clear();
      for (const model of models) modelLabels.set(model.key, model.alias || model.label);
      updateComposerState();
    },
    onSaved: (session) => {
      // 使已经在途的旧快照失效，当前显示以配置回执为准。
      refreshVersion++;
      if (snapshot) snapshot.session = { ...snapshot.session, ...session };
      updateComposerState();
      scheduleRefresh();
    },
  });
}
async function commands() {
  const sessionId = current;
  const navigation = navigationVersion;
  const sheet = openSheetPanel({ title: "命令与技能", subtitle: "选择后插入输入框，补充要求后发送。" });
  const stale = () => current !== sessionId || navigation !== navigationVersion || loginVisible || !sheet.isOpen();
  const list = el("div", { className: "sheet-list" }, el("p", { className: "sheet-hint", text: "正在加载…" }));
  sheet.body.append(list);
  function insert(text) {
    if (stale()) { sheet.close(); return; }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const separator = start > 0 && !/\s/.test(input.value[start - 1]) ? " " : "";
    sheet.close();
    input.setRangeText(`${separator}${text}`, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    saveDraft();
    input.focus({ preventScroll: true });
  }
  let r, agents;
  try {
    r = await api.read("commands.list", { sessionId });
    if (stale()) { sheet.close(); return; }
    agents = await api.read("subagents.list", { sessionId });
    if (stale()) { sheet.close(); return; }
  } catch (error) {
    if (stale()) { sheet.close(); return; }
    list.replaceChildren(el("p", { className: "sheet-hint", text: describeError(error) || "加载失败" }),
      button("重试", { preserveLabel: true, onClick: () => { sheet.close(); void action(commands); } }));
    return;
  }
  list.replaceChildren();
  if (!(r.items || []).length) list.append(el("p", { className: "sheet-hint", text: "暂无可用命令" }));
  for (const c of r.items || [])
    list.append(button(
      `/${c.name} · ${c.title || c.description || ""}${c.supported === false ? "（桌面专属）" : ""}`,
      { preserveLabel: true, disabled: c.supported === false, onClick: () => insert(`/${c.name} `) },
    ));
  list.append(el("p", { className: "sheet-section", text: "子智能体委派建议 · 选择后插入委派请求，由当前智能体按工具权限执行" }));
  for (const agent of agents.items || [])
    list.append(button(agent.name, {
      preserveLabel: true,
      onClick: () => insert(`请使用 ${agent.name} 子智能体处理以下任务：`),
    }));
}
async function queue() {
  const sessionId = current, navigation = navigationVersion;
  const sheet = openSheetPanel({ title: "待发消息", subtitle: "会话运行时提交的消息在此排队" });
  const stale = () => current !== sessionId || navigation !== navigationVersion || loginVisible || !sheet.isOpen();
  const list = el("div", { className: "sheet-list" });
  sheet.body.append(list);
  async function reload() {
    if (stale()) return;
    list.replaceChildren(el("p", { className: "sheet-hint", text: "正在加载…" }));
    let response;
    try { response = await api.read("queue.list", { sessionId }); }
    catch (error) {
      if (!stale()) list.replaceChildren(
        el("p", { className: "sheet-hint", text: describeError(error) }),
        button("重试", { preserveLabel: true, onClick: () => void reload() }));
      return;
    }
    if (stale()) return;
    list.replaceChildren();
    if (!response.items?.length) list.append(el("p", { className: "sheet-hint", text: "暂无待发消息" }));
    for (const item of response.items || []) {
      const row = el("section", { className: "queue-item" },
        el("p", { className: "sheet-quote", text: item.content }),
        item.locked ? el("small", { className: "sheet-hint", text: "优先组已锁定" }) : null);
      const actions = el("div", { className: "row-actions" });
      for (const [label, op, extra] of [
        ["立即发送", "queue.prioritize", {}], ["上移", "queue.reorder", { direction: "up" }],
        ["下移", "queue.reorder", { direction: "down" }], ["编辑", "queue.edit", {}], ["移除", "queue.remove", {}],
      ]) actions.append(button(label, { disabled: item.locked, preserveLabel: true, onClick: () => {
        if (stale() || sheet.panel.getAttribute("aria-busy") === "true") return;
        sheet.setBusy(true);
        void (async () => {
          try {
            if (op === "queue.edit") {
              assertQueueDraftAvailable(queuedDraftId);
              if (input.value.trim() && !await confirmAction({ title: "追加到草稿", detail: "当前草稿不为空，将把队列内容追加到草稿，继续？", confirmLabel: "继续" })) return;
            }
            if (stale()) return;
            const result = await mutate(op, { sessionId, turnId: item.turnId, ...extra });
            if (result.draft) {
              // 回执到达前导航离开时，仍将取回的队列草稿保存在原会话。
              const draft = current === sessionId ? (saveDraft(), drafts.get(sessionId)) : (drafts.get(sessionId) || {});
              draft.text = (draft.text ? `${draft.text}\n\n` : "") + result.draft.text;
              draft.queuedDraftId = result.draft.id;
              draft.queuedAttachments = result.draft.attachments || [];
              draft.omittedQueuedRefs = [];
              drafts.set(sessionId, draft);
              persistDrafts();
              if (current === sessionId && !loginVisible) {
                input.value = draft.text;
                queuedDraftId = draft.queuedDraftId;
                queuedAttachments = draft.queuedAttachments;
                omittedQueuedRefs = [];
                growInput();
                renderAttachments();
                if (!stale()) {
                  sheet.setBusy(false);
                  sheet.close();
                  input.focus({ preventScroll: true });
                }
              }
            } else {
              sheet.setBusy(false);
              await reload();
            }
          } catch (error) {
            sheet.setBusy(false);
            sheet.showError(describeError(error));
            report(error);
          } finally {
            if (sheet.panel.getAttribute("aria-busy") === "true") sheet.setBusy(false);
          }
        })();
      } }));
      row.append(actions);
      list.append(row);
    }
  }
  await reload();
}
composer.append(
  annotationList,
  attachmentList,
  el("div", { className: "remote-composer-main" }, attachButton, input, stopButton, send),
  el("div", { className: "remote-composer-tools" }, modelChip, moreButton),
  fileInput,
);
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    if (busy || !current) return;
    const pendingUploads = [...uploadJobs].filter((job) => job.sessionId === current);
    if (pendingUploads.length) {
      throw new Error(pendingUploads.some((job) => job.error)
        ? "附件上传失败，请重试或移除失败附件后发送。"
        : "附件正在上传，完成后即可发送。");
    }
    if (uploaded.some((attachment) => attachment.expired)) {
      throw new Error("登录已更换，请移除标记失效的附件并重新选择后发送。");
    }
    busy = true;
    const sendingSession = current;
    const submitted = {
      text: input.value,
      uploaded: [...uploaded],
      annotations: [...annotations],
      queuedDraftId,
      queuedAttachments: [...queuedAttachments],
      omittedQueuedRefs: [...omittedQueuedRefs],
    };
    saveDraft();
    send.disabled = true;
    try {
      await mutate("chat.send", {
        sessionId: sendingSession,
        text: responseAnnotationPrompt(input.value, annotations),
        attachmentIds: uploaded.map((a) => a.id),
        ...(queuedDraftId
          ? { queuedDraftId, omitQueuedAttachmentRefs: omittedQueuedRefs }
          : {}),
      });
      if (current === sendingSession) saveDraft();
      const remaining = drafts.get(sendingSession);
      if (remaining) {
        if (remaining.text === submitted.text) remaining.text = "";
        const sentIds = new Set(submitted.uploaded.map((attachment) => attachment.id));
        remaining.uploaded = (remaining.uploaded || []).filter((attachment) => !sentIds.has(attachment.id));
        remaining.annotations = (remaining.annotations || []).filter((annotation) => !submitted.annotations.includes(annotation));
        if (remaining.queuedDraftId === submitted.queuedDraftId) {
          remaining.queuedDraftId = "";
          remaining.queuedAttachments = [];
          remaining.omittedQueuedRefs = [];
        }
        persistDrafts();
      }
      if (current !== sendingSession) return;
      input.value = remaining?.text || "";
      growInput();
      uploaded = remaining?.uploaded || [];
      annotations = remaining?.annotations || [];
      queuedDraftId = remaining?.queuedDraftId || "";
      queuedAttachments = remaining?.queuedAttachments || [];
      omittedQueuedRefs = remaining?.omittedQueuedRefs || [];
      renderAttachments();
      await refresh();
    } finally {
      busy = false;
      send.disabled = false;
    }
  });
});
async function start() {
  loginVisible = false;
  root.dataset.authenticated = "true";
  recoveryPanel.hidden = false;
  transcript.replaceChildren(el("p", { text: "选择项目或会话开始使用。" }));
  layout();
  setPage("home");
  composer.hidden = true;
  notice.textContent = "已授权 · 正在连接实时事件";
  capabilities = await api.read("capabilities");
  if (!capabilities.events?.subscribe)
    notice.textContent = "宿主缺少实时订阅能力，请安装包含远程接口的版本。";
  if (loginVisible) return;
  history.replaceState({ remotePage: "home" }, "", location.pathname);
  showHome({ reload: false });
  await home.load();
  if (loginVisible) return;
  socket?.close?.();
  socket = new EventSocket({
    getToken: () => token,
    onStatus: (status) => {
      if (status === "unauthorized") { token = ""; clearToken(); showLogin(); }
      notice.textContent = `连接状态：${status}`;
    },
    onReady: () => {
      notice.textContent = "已连接电脑";
      if (current) socket.subscribe(current);
    },
    onEvent,
    onError: report,
    onResync: () => { if (!loginVisible) action(() => current ? refresh() : home.load()); },
    onFrame: (frame) => {
      if (frame.type === "subscribed") action(refresh);
    },
  });
  socket.connect();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !loginVisible) action(() => current ? refresh() : home.load());
});
if (token) action(start);
else showLogin();
