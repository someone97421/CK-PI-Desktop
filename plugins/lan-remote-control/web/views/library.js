/**
 * 项目 / 会话列表（手机主列表 + 宽屏 sidebar 共用）。
 *
 * 数据来源：`projects.list` 与 `sessions.list`（projectId 可省略 = 全部会话）。
 * 搜索是客户端过滤：协议里 `sessions.list` 没有查询参数，因此搜索只过滤已加载的
 * 条目，并在需要时提示“继续加载更多”。不改变桌面的当前项目/会话。
 */

import { button, el, formatRelative, icon, iconButton, inlineSpinner, stateBlock } from "../dom.js";
import { sortSessions } from "../store.js";

const RUNNING_LABEL = { true: "运行中", false: "" };

export function createLibraryView(ctx, { variant = "main" } = {}) {
  const root = el("div", { className: variant === "sidebar" ? "sidebar-body" : "scroll-area" });
  const searchField = el("div", { className: "search-field" });
  const searchIcon = icon("search", { size: 16 });
  const searchInput = el("input", {
    attrs: {
      type: "search",
      placeholder: "搜索项目或会话",
      autocomplete: "off",
      spellcheck: "false",
      enterkeyhint: "search",
    },
  });
  searchInput.addEventListener("input", () => ctx.setLibraryQuery(searchInput.value));
  searchField.append(searchIcon, searchInput);

  const listRoot = el("div", { className: "library-list" });
  root.append(searchField, listRoot);

  function matchesQuery(query, ...values) {
    if (!query) return true;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return values.some((value) => String(value || "").toLowerCase().includes(needle));
  }

  function renderProjectRow(project, state) {
    const entry = state.library.sessions[project.id];
    const active = state.library.projects.activeProjectId === project.id;
    const row = el("button", {
      className: "row",
      attrs: { type: "button", "aria-current": active ? "true" : "false" },
    });
    row.addEventListener("click", () => ctx.selectProject(project.id));
    const main = el("div", { className: "row-main" });
    main.append(el("span", { className: "row-title", text: project.name }));
    const sub = el("div", { className: "row-sub" });
    sub.append(el("span", { className: "mono", text: project.path || "—" }));
    if (project.pinned) {
      sub.append(el("span", { className: "chip", text: "置顶" }));
    }
    main.append(sub);
    row.append(el("span", { className: "row-trailing" }, icon("chevron", { size: 16 })), main);
    row.prepend(icon("folder", { size: 18 }));
    const trailing = el("span", { className: "row-trailing" });
    if (entry && entry.loading) trailing.append(el("span", { className: "spinner" }));
    else if (entry && entry.loaded) trailing.append(el("span", { className: "mono", text: `${entry.items.length}` }));
    row.append(trailing);
    return row;
  }

  function renderSessionRow(session) {
    const row = el("button", {
      className: "row",
      attrs: { type: "button", "aria-current": ctx.state.chat.sessionId === session.id ? "true" : "false" },
    });
    row.addEventListener("click", () => ctx.openSession(session.id));
    const main = el("div", { className: "row-main" });
    main.append(el("span", { className: "row-title", text: session.title }));
    const sub = el("div", { className: "row-sub" });
    sub.append(el("span", { text: formatRelative(session.updatedAt) }));
    if (RUNNING_LABEL[session.running]) {
      sub.append(el("span", { className: "chip chip-success", text: "运行中" }));
    }
    if (session.modelKey) sub.append(el("span", { className: "dot-sep mono", text: session.modelKey }));
    if (session.readOnlyReason) sub.append(el("span", { className: "chip chip-warning", text: "只读" }));
    main.append(sub);
    row.append(main);
    return row;
  }

  function renderProjects(state) {
    const projects = state.library.projects;
    const section = el("section");
    const head = el("div", { className: "section-head" });
    head.append(el("span", { text: "项目" }));
    const actions = el("div", { className: "section-actions" });
    actions.append(
      iconButton("refresh", {
        title: "刷新项目",
        onClick: () => ctx.loadProjects({ force: true }),
      }),
    );
    head.append(actions);
    section.append(head);

    if (projects.loading && !projects.items.length) {
      section.append(stateBlock("loading", "正在载入项目"));
      return section;
    }
    if (projects.error) {
      section.append(
        stateBlock(
          "error",
          "项目列表载入失败",
          projects.error.message || String(projects.error),
          button("重试", { variant: "secondary", size: "sm", onClick: () => ctx.loadProjects({ force: true }) }),
        ),
      );
      return section;
    }
    const items = projects.items.filter((project) => matchesQuery(projects.query, project.name, project.path));
    if (!items.length) {
      section.append(
        stateBlock(
          "empty",
          projects.items.length ? "没有匹配的项目" : "还没有项目",
          projects.items.length ? "换个关键词试试。" : "先在电脑上的这是一个助手里打开一个项目。",
        ),
      );
      return section;
    }
    const list = el("div", { className: "list" });
    for (const project of items) list.append(renderProjectRow(project, state));
    section.append(list);
    return section;
  }

  function renderActiveProjectSessions(state) {
    const projectId = state.library.projects.activeProjectId;
    const entry = projectId ? state.library.sessions[projectId] : null;
    const section = el("section");
    const head = el("div", { className: "section-head" });
    const project = state.library.projects.items.find((item) => item.id === projectId);
    head.append(el("span", { text: project ? project.name : "会话" }));
    const actions = el("div", { className: "section-actions" });
    actions.append(iconButton("plus", { title: "在此项目新建会话", onClick: () => ctx.createSession(projectId) }));
    head.append(actions);
    section.append(head);

    if (!projectId) {
      section.append(stateBlock("empty", "选择一个项目", "点上面的项目即可查看它的会话。"));
      return section;
    }
    if (entry && entry.loading && !entry.items.length) {
      section.append(stateBlock("loading", "正在载入会话"));
      return section;
    }
    if (entry && entry.error) {
      section.append(
        stateBlock("error", "会话列表载入失败", entry.error.message || String(entry.error), button("重试", {
          variant: "secondary",
          size: "sm",
          onClick: () => ctx.loadSessions(projectId, { force: true }),
        })),
      );
      return section;
    }
    const items = (entry ? entry.items : []).filter((session) => matchesQuery(state.library.projects.query, session.title));
    if (!items.length) {
      section.append(stateBlock("empty", "这个项目还没有会话", "点右上角新建一个会话。"));
      return section;
    }
    const list = el("div", { className: "list" });
    for (const session of sortSessions(items).filter((session) => matchesQuery(state.library.projects.query, session.title))) {
      list.append(renderSessionRow(session));
    }
    section.append(list);
    if (entry && entry.nextCursor) {
      const more = el("div", { className: "chat-loading-more" });
      more.append(
        entry.loadingMore
          ? inlineSpinner("载入中…")
          : button("载入更多会话", { variant: "secondary", size: "sm", onClick: () => ctx.loadSessions(projectId, { more: true }) }),
      );
      section.append(more);
    }
    return section;
  }

  function render(state) {
    const query = state.library.projects.query;
    if (searchInput.value !== query) searchInput.value = query;
    listRoot.replaceChildren();

    // 全局搜索：命中会话标题时直接列出（数据来自已加载的项目会话）。
    if (query.trim()) {
      const hits = [];
      for (const [projectId, entry] of Object.entries(state.library.sessions)) {
        for (const session of entry.items) {
          if (matchesQuery(query, session.title)) hits.push({ session, projectId });
        }
      }
      const section = el("section");
      const head = el("div", { className: "section-head" });
      head.append(el("span", { text: `会话搜索：${hits.length} 条` }));
      section.append(head);
      if (!hits.length) {
        section.append(
          stateBlock("empty", "没有匹配的会话", "搜索只覆盖已经载入过的会话；展开项目可以载入更多。"),
        );
      } else {
        const list = el("div", { className: "list" });
        for (const hit of hits.slice(0, 60)) {
          const row = renderSessionRow(hit.session);
          const project = state.library.projects.items.find((item) => item.id === hit.projectId);
          if (project) {
            const sub = row.querySelector(".row-sub");
            if (sub) sub.prepend(el("span", { className: "dot-sep", text: project.name }));
          }
          list.append(row);
        }
        section.append(list);
      }
      listRoot.append(section, renderProjects(state));
      return;
    }

    listRoot.append(renderProjects(state));
    if (state.library.projects.activeProjectId) listRoot.append(renderActiveProjectSessions(state));
    else if (state.library.recent.items.length) {
      const section = el("section");
      const head = el("div", { className: "section-head" });
      head.append(el("span", { text: "最近的会话" }));
      section.append(head);
      const list = el("div", { className: "list" });
      for (const session of sortSessions(state.library.recent.items).slice(0, 20)) list.append(renderSessionRow(session));
      section.append(list);
      listRoot.append(section);
    }
  }

  return { root, update: render, focusSearch: () => searchInput.focus() };
}
