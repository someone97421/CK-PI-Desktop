import { el, button, icon, iconButton, formatRelative } from "./dom.js";

const TEMPORARY_GROUP = "temporary";
const INITIAL_SESSION_LIMIT = 3;
const SESSION_PAGE_SIZE = 5;

export function createProjectHome({ read, openSession, createSession, discardSession, report }) {
  const root = el("main", { className: "remote-home", attrs: { "aria-label": "项目与对话" } });
  const list = el("div", { className: "remote-home-list" });
  const count = el("p", { className: "remote-home-count", attrs: { role: "status" } });
  const expanded = new Set([TEMPORARY_GROUP]);
  let entries = [], generation = 0, loading = false;
  const search = el("input", { attrs: { type: "search", placeholder: "搜索项目、路径或对话", "aria-label": "搜索项目或对话" } });
  const filter = el("select", { attrs: { "aria-label": "对话状态" } },
    el("option", { value: "all", text: "全部对话" }), el("option", { value: "running", text: "运行中" }));
  const sort = el("select", { attrs: { "aria-label": "排序方式" } },
    el("option", { value: "updated", text: "最近更新" }), el("option", { value: "name", text: "项目名称" }));
  const filters = el("div", { className: "remote-home-filters", hidden: true }, search, filter, sort);
  search.title = "搜索与计数包含已加载的对话，可在分组内继续加载。";
  const filterButton = iconButton("filter", { title: "搜索与筛选", onClick: () => {
    filters.hidden = !filters.hidden;
    filterButton.setAttribute("aria-expanded", String(!filters.hidden));
    if (!filters.hidden) search.focus();
  } });
  filterButton.setAttribute("aria-expanded", "false");
  const collapse = iconButton("down", { title: "展开全部分组", onClick: () => {
    const allOpen = entries.length && entries.every(({ project }) => expanded.has(project.id));
    for (const entry of entries) setExpanded(entry, !allOpen);
    render();
  } });
  const refresh = iconButton("refresh", { title: "刷新项目与对话", onClick: () => void load() });
  root.append(
    el("div", { className: "remote-home-heading" }, el("h1", { text: "当前设备上的项目与对话" }),
      el("div", { className: "remote-home-tools" }, collapse, filterButton, refresh)),
    count, filters, list,
  );
  for (const field of [search, filter, sort]) field.addEventListener(field === search ? "input" : "change", render);
  const timestamp = (value) => { const n = new Date(value || 0).getTime(); return Number.isFinite(n) ? n : 0; };
  const latest = (entry) => Math.max(0, ...(entry.items || []).map((s) => timestamp(s.updatedAt)));
  const relative = (value) => value && timestamp(value) ? formatRelative(value) : "暂无更新";
  const scope = (entry) => entry.temporary ? { temporary: true } : { projectId: entry.project.id };
  function setExpanded(entry, open) {
    if (open) expanded.add(entry.project.id);
    else {
      expanded.delete(entry.project.id);
      entry.visibleLimit = INITIAL_SESSION_LIMIT;
    }
  }

  function render() {
    const scroll = root.scrollTop;
    const needle = search.value.trim().toLowerCase();
    list.replaceChildren();
    const total = entries.reduce((n, entry) => n + entry.items.length, 0);
    const partial = entries.some((entry) => entry.nextCursor || entry.error);
    count.textContent = loading ? "正在加载项目与对话…" : `${entries.filter((entry) => !entry.temporary).length} 个项目 · ${partial ? "已加载 " : ""}${total} 个对话`;
    const allOpen = entries.length && entries.every(({ project }) => expanded.has(project.id));
    collapse.replaceChildren(icon(allOpen ? "up" : "down"));
    collapse.title = allOpen ? "收起全部分组" : "展开全部分组";
    collapse.setAttribute("aria-label", collapse.title);
    const ordered = [...entries].sort((a, b) => Number(!!b.temporary) - Number(!!a.temporary)
      || (sort.value === "name" ? a.project.name.localeCompare(b.project.name, "zh-CN") : latest(b) - latest(a)));
    for (const entry of ordered) {
      const { project } = entry;
      const projectMatch = `${project.name} ${project.path || ""}`.toLowerCase().includes(needle);
      const sessions = entry.items.filter((s) => (projectMatch || `${s.title || ""} ${s.temporaryWorkspacePath || ""}`.toLowerCase().includes(needle)) && (filter.value !== "running" || s.running))
        .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
      if ((needle && !projectMatch && !sessions.length) || (filter.value === "running" && !sessions.length && !entry.nextCursor && !entry.error)) continue;
      const open = expanded.has(project.id) || !!needle || filter.value !== "all";
      const card = el("section", { className: "remote-home-project" });
      const toggle = el("button", { className: "remote-home-project-toggle", attrs: { type: "button", "aria-expanded": String(open), "aria-label": `${open ? "收起" : "展开"}${project.name}` } },
        el("span", { className: "remote-home-project-icon" }, icon(entry.temporary ? "sidechat" : "folder", { size: 24 })),
        el("span", { className: "remote-home-project-info" },
          el("span", { className: "remote-home-project-title" }, el("strong", { text: project.name }), el("span", { className: "remote-home-badge", text: entry.temporary ? "临时" : "本地" })),
          ...(entry.temporary ? [] : [el("span", { className: "remote-home-project-path", text: project.path || "本地项目", attrs: { title: project.path || "" } })]),
          el("span", { className: "remote-home-project-time", text: latest(entry) ? `更新于 ${relative(latest(entry))}` : "暂无对话更新" })),
        el("span", { className: "remote-home-project-count", text: `${entry.items.length}${entry.nextCursor ? "+" : ""} 个对话` }),
        icon(open ? "down" : "chevron", { size: 16 }));
      toggle.addEventListener("click", () => {
        if (needle || filter.value !== "all") { search.value = ""; filter.value = "all"; }
        setExpanded(entry, !open);
        render();
      });
      const add = iconButton("plus", { title: entry.temporary ? "新建临时会话" : `在${project.name}新建对话`, className: "remote-home-add", onClick: async () => {
        add.disabled = true;
        try { await createSession(entry.temporary ? null : project.id); } catch (error) { report(error); }
        finally { add.disabled = false; }
      } });
      card.append(el("div", { className: "remote-home-project-header" }, toggle, add));
      if (open) {
        const visibleLimit = entry.visibleLimit ?? INITIAL_SESSION_LIMIT;
        const rows = el("div", { className: "remote-home-sessions" });
        for (const session of sessions.slice(0, visibleLimit)) {
          const row = el("button", { className: "remote-home-session", dataset: { sessionId: session.id }, attrs: { type: "button" } },
            el("span", { className: "remote-home-session-main" }, el("span", { text: session.title || "新对话" }),
              el("small", { text: relative(session.updatedAt) }),
              ...(session.temporaryWorkspacePath ? [el("small", { className: "remote-home-project-path", text: session.temporaryWorkspacePath, attrs: { title: session.temporaryWorkspacePath } })] : [])),
            el("span", { className: `remote-home-status${session.running ? " is-running" : ""}`, text: session.draft ? "草稿" : session.running ? "运行中" : "空闲" }));
          row.addEventListener("click", async () => {
            row.disabled = true;
            try { await openSession(session.id); } catch (error) { report(error); }
            finally { row.disabled = false; }
          });
          if (session.draft) {
            const discard = iconButton("close", { title: "放弃临时草稿", className: "remote-home-discard", onClick: async () => {
              discard.disabled = true;
              try { await discardSession(session.id); await load(); }
              catch (error) { report(error); }
              finally { discard.disabled = false; }
            } });
            rows.append(el("div", { className: "remote-home-draft" }, row, discard));
          } else rows.append(row);
        }
        if (!sessions.length) rows.append(el("p", { className: "remote-home-empty", text: entry.error ? "对话加载失败" : needle || filter.value !== "all" ? "没有匹配的对话" : "暂无对话" }));
        if (entry.error) rows.append(el("p", { className: "remote-home-empty", text: entry.error.message || "请刷新重试" }));
        if (sessions.length > visibleLimit || entry.nextCursor || entry.error) {
          const more = button(entry.error ? "重新加载" : "加载更多对话", { preserveLabel: true, className: "remote-home-more", onClick: async () => {
            if (entry.loadingMore) return;
            const retry = !!entry.error;
            const nextLimit = retry ? INITIAL_SESSION_LIMIT : visibleLimit + SESSION_PAGE_SIZE;
            entry.visibleLimit = nextLimit;
            if (!retry && (sessions.length >= nextLimit || !entry.nextCursor)) { render(); return; }
            entry.loadingMore = true;
            more.disabled = true;
            const version = generation;
            try {
              const page = await read("sessions.list", { ...scope(entry), limit: retry ? INITIAL_SESSION_LIMIT : SESSION_PAGE_SIZE, ...(retry ? {} : { cursor: entry.nextCursor }) });
              if (version !== generation) return;
              entry.items = retry ? page.items || [] : [...new Map([...entry.items, ...(page.items || [])].map((s) => [s.id, s])).values()];
              entry.nextCursor = page.nextCursor;
              entry.error = null;
            } catch (error) {
              if (version === generation) {
                if (entry.visibleLimit === nextLimit) entry.visibleLimit = visibleLimit;
                report(error);
              }
            } finally {
              entry.loadingMore = false;
              if (version === generation) render();
            }
          } });
          more.disabled = !!entry.loadingMore;
          rows.append(more);
        }
        card.append(rows);
      }
      list.append(card);
    }
    if (!list.childElementCount && !loading) list.append(el("p", { className: "remote-home-empty", text: "没有匹配的项目或对话" }));
    root.scrollTop = scroll;
  }
  async function load() {
    const version = ++generation;
    loading = true;
    refresh.disabled = true;
    render();
    try {
      const [projects, temporary] = await Promise.allSettled([
        read("projects.list"), read("sessions.list", { temporary: true, limit: INITIAL_SESSION_LIMIT }),
      ]);
      if (version !== generation) return;
      const next = [{
        project: { id: TEMPORARY_GROUP, name: "临时会话" }, temporary: true,
        items: temporary.status === "fulfilled" ? temporary.value.items || [] : [],
        nextCursor: temporary.status === "fulfilled" ? temporary.value.nextCursor : undefined,
        error: temporary.status === "rejected" ? temporary.reason : null,
      }];
      if (projects.status === "rejected") report(projects.reason);
      for (const project of projects.status === "fulfilled" ? projects.value.items || [] : []) {
        try {
          const page = await read("sessions.list", { projectId: project.id, limit: INITIAL_SESSION_LIMIT });
          next.push({ project, items: page.items || [], nextCursor: page.nextCursor });
        } catch (error) { next.push({ project, items: [], error }); }
        if (version !== generation) return;
      }
      entries = next;
    } catch (error) {
      if (version === generation) report(error);
    } finally {
      if (version === generation) { loading = false; refresh.disabled = false; render(); }
    }
  }
  function reset() {
    generation++;
    entries = [];
    expanded.clear();
    expanded.add(TEMPORARY_GROUP);
    search.value = "";
    filter.value = "all";
    filters.hidden = true;
    filterButton.setAttribute("aria-expanded", "false");
    loading = false;
    refresh.disabled = false;
    render();
  }
  return { root, load, reset };
}
