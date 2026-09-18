import { createLoginView } from "./views/connect.js";
import { el, button, copyText } from "./dom.js";
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
  projects = [],
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
let capabilities = {};
const positions = new Map();
// UI 状态独立于流式替换的消息对象，按会话和稳定 ID 保存。
const disclosureState = new Map();
const processVisibility = new Map();
let drawer = null;
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
function closeLibrary() {
  drawer?.remove();
}
function openLibrary() {
  if (drawer || loginVisible) return;
  drawer = el("dialog", { className: "remote-drawer", dataset: { persistent: "true" }, attrs: { "aria-label": "项目与会话" } },
    el("div", { className: "remote-drawer-heading" }, el("strong", { text: "项目与会话" }),
      button("返回对话", { iconName: "back", preserveLabel: true, onClick: closeLibrary })), library);
  drawer.addEventListener("cancel", (event) => { event.preventDefault(); closeLibrary(); });
  const panel = drawer;
  const remove = panel.remove.bind(panel);
  panel.remove = () => {
    if (drawer === panel) {
      document.querySelector(".remote-layout")?.prepend(library);
      drawer = null;
    }
    remove();
  };
  document.body.append(drawer);
  drawer.showModal();
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
  button("项目列表", { className: "library-toggle", onClick: openLibrary }),
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
    },
  }),
);
const library = el("aside", { className: "remote-library" }),
  transcript = el("main", { className: "remote-transcript" }),
  composer = el("form", { className: "remote-composer" });
const chatHeading = el("div", { className: "remote-chat-heading row-actions" });
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
  if (atBottom) requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
}
window.visualViewport?.addEventListener("resize", updateViewport);
window.addEventListener("resize", updateViewport);
updateViewport();
const input = el("textarea", {
  attrs: { placeholder: "发送消息…", "aria-label": "消息", rows: 2 },
});
const attachmentList = el("div"),
  annotationList = el("div");
const toolbar = el("div", { className: "row-actions" });
const send = button("发送", { variant: "primary", type: "submit" });
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
      onClick: () => {
        if (confirm("仅在核对电脑会话、确认不会重复提交后解除。不会自动重发。"))
          action(() => recovery.acknowledge());
      },
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
      library,
      el("section", { className: "remote-chat" }, chatHeading, transcript, jumpLatest, composer),
    ),
  );
  drawRecovery();
  delete document.documentElement.dataset.booting;
}
function showLogin() {
  if (loginVisible) return;
  loginVisible = true;
  closeLibrary();
  subagentObserver.close();
  chatHeading.replaceChildren();
  jumpLatest.hidden = true;
  root.dataset.authenticated = "false";
  renderVersion++; refreshVersion++;
  current = null; snapshot = null; messages = []; liveTools.clear(); recentEvents.length = 0;
  socket?.close?.();
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  layout();
  document.querySelector(".remote-layout").dataset.view = "chat";
  library.replaceChildren(); library.hidden = true; composer.hidden = true;
  recoveryPanel.hidden = true;
  history.replaceState(null, "", location.pathname);
  transcript.replaceChildren(createLoginView({
    login: (password, name) => api.login(password, name),
    onSuccess: async (result) => { token = result.token; storeToken(token); await start(); },
    onError: report,
  }));
}
async function loadLibrary() {
  const p = await api.read("projects.list");
  projects = p.items || [];
  const search = el("input", {
      attrs: { placeholder: "搜索项目或会话", "aria-label": "搜索" },
    }),
    list = el("div");
  library.replaceChildren(
    search,
    button("刷新", { onClick: () => action(loadLibrary) }),
    list,
  );
  let drawing = 0;
  const cache = new Map();
  async function draw() {
    const version = ++drawing;
    list.replaceChildren();
    for (const project of projects) {
      const group = el("section", { className: "remote-project" });
      let sessions = cache.get(project.id);
      if (!sessions) {
        sessions = await api.read("sessions.list", {
          projectId: project.id,
          limit: 100,
        });
        cache.set(project.id, sessions);
      }
      if (version !== drawing) return;
      const needle = search.value.toLowerCase();
      const visible = (sessions.items || []).filter((s) =>
        `${project.name} ${s.title}`.toLowerCase().includes(needle),
      );
      if (needle && !visible.length) continue;
      group.append(
        el("h3", { text: project.name }),
        button("＋ 新对话", {
          onClick: () =>
            action(async () => {
              const r = await mutate("sessions.create", {
                projectId: project.id,
              });
              await openSession(r.session.id);
              await loadLibrary();
            }),
        }),
      );
      for (const s of visible) {
        const row = button(`${s.running ? "● " : ""}${s.title || "新对话"}`, {
          preserveLabel: true,
          onClick: () => action(() => openSession(s.id)),
        });
        row.dataset.sessionId = s.id;
        row.setAttribute("aria-current", s.id === current ? "page" : "false");
        group.append(row);
      }
      if (sessions.nextCursor)
        group.append(
          button("加载更多会话", {
            onClick: () =>
              action(async () => {
                const page = await api.read("sessions.list", {
                  projectId: project.id,
                  cursor: sessions.nextCursor,
                  limit: 100,
                });
                cache.set(project.id, {
                  items: [...sessions.items, ...page.items],
                  nextCursor: page.nextCursor,
                });
                await draw();
              }),
          }),
        );
      list.append(group);
    }
    if (!list.childElementCount) list.append(el("p", { className: "connection-banner", text: search.value ? "没有匹配的项目或会话。" : "电脑端尚无可用项目。" }));
  }
  search.addEventListener("input", () => action(draw));
  await draw();
}
async function openSession(id) {
  renderVersion++;
  closeLibrary();
  subagentObserver.close();
  saveDraft();
  if (current) positions.set(current, transcript.scrollTop);
  socket?.unsubscribe(current);
  current = id;
  for (const row of library.querySelectorAll("[data-session-id]"))
    row.setAttribute("aria-current", row.dataset.sessionId === id ? "page" : "false");
  composer.hidden = false;
  transcript.replaceChildren(el("p", { className: "connection-banner", text: "正在加载会话…", attrs: { role: "status" } }));
  document.querySelector(".remote-layout").dataset.view = "chat";
  liveTools.clear();
  snapshotRevision = -1;
  recentEvents.length = 0;
  snapshot = null;
  resetHistory = true;
  messages = [];
  const draft = drafts.get(id) || {};
  input.value = draft.text || "";
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
  const top = el(
    "div",
    { className: "row-actions" },
    el("h2", { text: snapshot?.session?.title || "对话" }),
    button("刷新", { onClick: () => action(refresh) }),
  );
  if (parents.has(current))
    top.append(
      button("返回主对话", {
        onClick: () => action(() => openSession(parents.get(current))),
      }),
    );
  for (const [child, parent] of parents)
    if (parent === current)
      top.append(
        button("打开侧边对话", {
          onClick: () => action(() => openSession(child)),
        }),
      );
  const processToggle = button(processVisibility.get(current) ? "收起过程" : "展开过程", {
    preserveLabel: true,
    onClick: () => {
      const open = !processVisibility.get(current);
      processVisibility.set(current, open);
      for (const entry of timeline.entries) if (entry.rows) disclosureState.set(`${current}:task:${entry.key}`, open);
      action(drawChat);
    },
  });
  processToggle.setAttribute("aria-pressed", String(!!processVisibility.get(current)));
  top.append(processToggle);
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
      el("small", {
        text:
          m.role === "user" ? "你" : m.role === "assistant" ? "助手" : m.role,
      }),
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
          input.focus();
        },
      }),
    );
    if (m.role === "assistant") {
      actions.append(
        button("批注", {
          onClick: () => {
            const selection = window.getSelection()?.toString() || m.content;
            const note = prompt("批注内容");
            if (note === null) return;
            annotations.push({
              messageId: m.id,
              text: selection.slice(0, 2000),
              annotation: note,
            });
            renderAttachments();
          },
        }),
        button("侧边对话", {
          onClick: () =>
            action(async () => {
              const parent = current;
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
              await openSession(r.session.id);
            }),
        }),
      );
    }
    if (m.role === "user")
      actions.append(
        button("编辑重发", {
          onClick: () =>
            action(async () => {
              const value = prompt(
                "编辑消息并重新生成（后续消息会被替换）",
                m.content,
              );
              if (value === null) return;
              await mutate("chat.edit", {
                sessionId: current,
                messageId: m.id,
                text: value,
              });
              await refresh();
            }),
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
    card.append(actions);
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
  top.append(button(subagentObserver.buttonLabel(), { iconName: "sidechat", preserveLabel: true, onClick: () => subagentObserver.open() }));
  const scroll = transcript.scrollTop;
  const nearBottom = transcript.scrollHeight - scroll - transcript.clientHeight < 100;
  const focusedDisclosure = document.activeElement?.closest("details")?.dataset.disclosureKey;
  const pendingCount = ["plans", "approvals", "questions"].reduce((count, key) => count + (snapshot?.pending?.[key]?.length || 0), 0);
  if (pendingCount) top.append(button(`待处理 ${pendingCount}`, { preserveLabel: true, onClick: () => {
    transcript.querySelector(".approval-card")?.scrollIntoView({ block: "start" });
  } }));
  chatHeading.replaceChildren(top);
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
function showText(title, text) {
  const dialog = el(
    "dialog",
    {},
    el("h3", { text: title }),
    el("pre", { text }),
    button("返回对话", { iconName: "back", preserveLabel: true, onClick: () => dialog.remove() }),
  );
  document.body.append(dialog);
  dialog.showModal();
}
function renderPending() {
  for (const plan of snapshot?.pending?.plans || []) {
    const box = el(
      "section",
      { className: "approval-card" },
      el("strong", { text: plan.title || "计划审批" }),
      el("pre", { text: plan.markdown || plan.content || plan.plan || "" }),
      el("p", { text: "提交决议后仍需电脑确认" }),
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
      el("p", { text: "提交后仍需电脑原生确认" }),
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
      el("strong", { text: "智能体提问（需电脑确认）" }),
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
        a.name,
        button("预览", {
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
fileInput.addEventListener("change", () =>
  action(async () => {
    if (!current) throw new Error("请先选择会话");
    const sessionId = current;
    for (const file of fileInput.files) {
      try {
        const a = await api.upload(file, sessionId);
        if (current === sessionId) {
          uploaded.push(a);
          renderAttachments();
        } else {
          const draft = drafts.get(sessionId) || {};
          draft.uploaded = [...(draft.uploaded || []), a];
          drafts.set(sessionId, draft);
        }
      } catch (error) {
        report(error);
        const retry = button(`重试上传 ${file.name}`, {
          iconName: "retry",
          onClick: () =>
            action(async () => {
              const a = await api.upload(file, sessionId);
              if (current === sessionId) {
                uploaded.push(a);
                renderAttachments();
              } else {
                const draft = drafts.get(sessionId) || {};
                draft.uploaded = [...(draft.uploaded || []), a];
                drafts.set(sessionId, draft);
              }
              retry.remove();
            }),
        });
        notice.after(retry);
      }
    }
    fileInput.value = "";
  }),
);
async function modelOptions() {
  const models = (await api.read("models.list")).items || [];
  const dialog = el(
    "dialog",
    {},
    el("h3", { text: "会话模型" }),
    el("p", { text: "变更模型与思考强度需要电脑确认" }),
  );
  const select = el("select", { attrs: { "aria-label": "模型" } }),
    thinking = el("select", { attrs: { "aria-label": "思考强度" } }),
    mode = el("select", { attrs: { "aria-label": "工作模式" } }),
    permission = el("select", { attrs: { "aria-label": "权限模式" } });
  for (const value of ["agent", "plan", "goal"])
    mode.append(
      el("option", {
        value,
        text: value,
        selected: value === snapshot?.session?.mode,
      }),
    );
  for (const value of ["inherit", "ask", "accept-edits", "auto"])
    permission.append(
      el("option", {
        value,
        text: value,
        selected: value === snapshot?.session?.permissionMode,
      }),
    );
  for (const m of models)
    select.append(
      el("option", {
        value: m.key,
        text: m.label,
        selected: m.key === snapshot?.session?.modelKey,
      }),
    );
  function levels() {
    thinking.replaceChildren(
      ...(
        models.find((m) => m.key === select.value)?.thinkingLevels || ["off"]
      ).map((x) =>
        el("option", {
          value: x,
          text: x,
          selected: x === snapshot?.session?.thinkingLevel,
        }),
      ),
    );
  }
  select.addEventListener("change", levels);
  levels();
  dialog.append(
    select,
    thinking,
    el("label", {}, "工作模式", mode),
    el("label", {}, "权限模式（需电脑确认）", permission),
    button("应用", {
      onClick: () =>
        action(async () => {
          await mutate("models.configure", {
            sessionId: current,
            modelKey: select.value,
            thinkingLevel: thinking.value,
            mode: mode.value,
            permissionMode: permission.value,
          });
          dialog.remove();
          await refresh();
        }),
    }),
    button("取消", { onClick: () => dialog.remove() }),
  );
  document.body.append(dialog);
  dialog.showModal();
}
async function commands() {
  const r = await api.read("commands.list", { sessionId: current });
  const dialog = el("dialog", {}, el("h3", { text: "命令与技能" }));
  for (const c of r.items || [])
    dialog.append(
      button(
        `/${c.name} · ${c.title || c.description || ""}${c.supported === false ? "（桌面专属）" : ""}`,
        {
          preserveLabel: true,
          disabled: c.supported === false,
          onClick: () => {
            input.value += `/${c.name} `;
            dialog.remove();
            input.focus();
          },
        },
      ),
    );
  const agents = await api.read("subagents.list", { sessionId: current });
  dialog.append(
    el("h3", { text: "子智能体委派建议" }),
    el("p", { text: "选择后插入委派请求，由当前智能体按工具权限执行。" }),
  );
  for (const agent of agents.items || [])
    dialog.append(
      button(agent.name, {
        preserveLabel: true,
        onClick: () => {
          input.value += `${input.value ? "\n" : ""}请使用 ${agent.name} 子智能体处理以下任务：`;
          dialog.remove();
          input.focus();
        },
      }),
    );
  dialog.append(button("关闭", { onClick: () => dialog.remove() }));
  document.body.append(dialog);
  dialog.showModal();
}
async function queue() {
  const r = await api.read("queue.list", { sessionId: current });
  const dialog = el("dialog", {}, el("h3", { text: "待发消息" }));
  for (const item of r.items || []) {
    const row = el(
      "section",
      {},
      el("p", { text: item.content }),
      el("small", { text: item.locked ? "优先组已锁定" : "" }),
    );
    for (const [label, op, extra] of [
      ["立即发送", "queue.prioritize", {}],
      ["上移", "queue.reorder", { direction: "up" }],
      ["下移", "queue.reorder", { direction: "down" }],
      ["编辑", "queue.edit", {}],
      ["移除", "queue.remove", {}],
    ])
      row.append(
        button(label, {
          disabled: item.locked,
          onClick: () =>
            action(async () => {
              if (op === "queue.edit") assertQueueDraftAvailable(queuedDraftId);
              if (
                op === "queue.edit" &&
                input.value.trim() &&
                !confirm("当前草稿不为空，将把队列内容追加到草稿，继续？")
              )
                return;
              const result = await mutate(op, {
                sessionId: current,
                turnId: item.turnId,
                ...extra,
              });
              if (result.draft) {
                input.value += (input.value ? "\n\n" : "") + result.draft.text;
                queuedDraftId = result.draft.id;
                queuedAttachments = result.draft.attachments || [];
                omittedQueuedRefs = [];
                renderAttachments();
              }
              dialog.remove();
              if (!result.draft) await queue();
            }),
        }),
      );
    dialog.append(row);
  }
  dialog.append(button("关闭", { onClick: () => dialog.remove() }));
  document.body.append(dialog);
  dialog.showModal();
}
composer.append(annotationList, attachmentList, input, toolbar, fileInput);
toolbar.append(
  button("附件", { onClick: () => fileInput.click() }),
  button("命令/技能", { onClick: () => action(commands) }),
  button("模型", { onClick: () => action(modelOptions) }),
  button("队列", { onClick: () => action(queue) }),
  button("停止", {
    onClick: () =>
      action(async () => {
        await mutate("chat.stop", { sessionId: current });
        await refresh();
      }),
  }),
  send,
);
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    if (busy || !current) return;
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
      drafts.delete(sendingSession);
      if (current !== sendingSession) return;
      if (input.value === submitted.text) input.value = "";
      uploaded = uploaded.filter((a) => !submitted.uploaded.includes(a));
      annotations = annotations.filter(
        (a) => !submitted.annotations.includes(a),
      );
      queuedDraftId = "";
      queuedAttachments = [];
      omittedQueuedRefs = [];
      saveDraft();
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
  library.hidden = false;
  composer.hidden = true;
  notice.textContent = "已授权 · 正在连接实时事件";
  capabilities = await api.read("capabilities");
  if (!capabilities.events?.subscribe)
    notice.textContent = "宿主缺少实时订阅能力，请安装包含远程接口的版本。";
  await loadLibrary();
  if (matchMedia("(max-width: 700px)").matches) openLibrary();
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
    onResync: () => action(refresh),
    onFrame: (frame) => {
      if (frame.type === "subscribed") action(refresh);
    },
  });
  socket.connect();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current) action(refresh);
});
if (token) action(start);
else showLogin();
