import { el, button, icon, iconButton, formatRelative } from "./dom.js";

/** 手机首页：项目卡片内选择对话，不再使用侧栏或抽屉。 */
export function createProjectHome({ read, openSession, createSession, report }) {
  const root = el("main", { className: "remote-home", attrs: { "aria-label": "项目与对话" } });
  const list = el("div", { className: "remote-home-list" });
  const count = el("p", { className: "remote-home-count", attrs: { role: "status" } });
  const expanded = new Set();
  let entries = [], generation = 0, loading = false;
  const search = el("input", { attrs: { type: "search", placeholder: "搜索项目、路径或对话", "aria-label": "搜索项目或对话" } });
  const filter = el("select", { attrs: { "aria-label": "对话状态" } },
    el("option", { value: "all", text: "全部对话" }), el("option", { value: "running", text: "运行中" }));
  const sort = el("select", { attrs: { "aria-label": "排序方式" } },
    el("option", { value: "updated", text: "最近更新" }), el("option", { value: "name", text: "项目名称" }));
  const filters = el("div", { className: "remote-home-filters", hidden: true }, search, filter, sort,
    el("small", { text: "搜索与计数包含已加载的对话，可在项目内继续加载。" }));
  const filterButton = iconButton("filter", { title: "搜索与筛选", onClick: () => {
    filters.hidden = !filters.hidden;
    filterButton.setAttribute("aria-expanded", String(!filters.hidden));
    if (!filters.hidden) search.focus();
  } });
  filterButton.setAttribute("aria-expanded", "false");
  const collapse = iconButton("down", { title: "展开全部项目", onClick: () => {
    const allOpen = entries.length && entries.every(({ project }) => expanded.has(project.id));
    for (const { project } of entries) allOpen ? expanded.delete(project.id) : expanded.add(project.id);
    render();
  } });
  const refresh = iconButton("refresh", { title: "刷新项目与对话", onClick: () => void load() });
  root.append(
    el("div", { className: "remote-home-intro", text: "查看这台电脑上的项目和对话。展开项目选择已有对话，或点 ＋ 开始新对话。" }),
    el("div", { className: "remote-home-heading" }, el("h1", { text: "当前设备上的项目与对话" }),
      el("div", { className: "remote-home-tools" }, collapse, filterButton, refresh)),
    count, filters, list,
  );
  for (const field of [search, filter, sort]) field.addEventListener(field === search ? "input" : "change", render);
  const timestamp = (value) => { const n = new Date(value || 0).getTime(); return Number.isFinite(n) ? n : 0; };
  const latest = (entry) => Math.max(0, ...(entry.items || []).map((s) => timestamp(s.updatedAt)));
  const relative = (value) => value && timestamp(value) ? formatRelative(value) : "暂无更新";

  function render() {
    const scroll = root.scrollTop;
    const needle = search.value.trim().toLowerCase();
    list.replaceChildren();
    const total = entries.reduce((n, entry) => n + entry.items.length, 0);
    const partial = entries.some((entry) => entry.nextCursor || entry.error);
    count.textContent = loading ? "正在加载项目与对话…" : `${entries.length} 个项目 · ${partial ? "已加载 " : ""}${total} 个对话`;
    const allOpen = entries.length && entries.every(({ project }) => expanded.has(project.id));
    collapse.replaceChildren(icon(allOpen ? "up" : "down"));
    collapse.title = allOpen ? "收起全部项目" : "展开全部项目";
    collapse.setAttribute("aria-label", collapse.title);
    const ordered = [...entries].sort((a, b) => sort.value === "name"
      ? a.project.name.localeCompare(b.project.name, "zh-CN") : latest(b) - latest(a));
    for (const entry of ordered) {
      const { project } = entry;
      const projectMatch = `${project.name} ${project.path || ""}`.toLowerCase().includes(needle);
      const sessions = entry.items.filter((s) => (projectMatch || (s.title || "").toLowerCase().includes(needle)) && (filter.value !== "running" || s.running))
        .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
      if ((needle && !projectMatch && !sessions.length) || (filter.value === "running" && !sessions.length && !entry.nextCursor && !entry.error)) continue;
      const open = expanded.has(project.id) || !!needle || filter.value !== "all";
      const card = el("section", { className: "remote-home-project" });
      const toggle = el("button", { className: "remote-home-project-toggle", attrs: { type: "button", "aria-expanded": String(open), "aria-label": `${open ? "收起" : "展开"}${project.name}` } },
        el("span", { className: "remote-home-project-icon" }, icon("folder", { size: 24 })),
        el("span", { className: "remote-home-project-info" },
          el("span", { className: "remote-home-project-title" }, el("strong", { text: project.name }), el("span", { className: "remote-home-badge", text: "本地" })),
          el("span", { className: "remote-home-project-path", text: project.path || "本地项目", attrs: { title: project.path || "" } }),
          el("span", { className: "remote-home-project-time", text: latest(entry) ? `更新于 ${relative(latest(entry))}` : "暂无对话更新" })),
        el("span", { className: "remote-home-project-count", text: `${entry.items.length}${entry.nextCursor ? "+" : ""} 个对话` }),
        icon(open ? "down" : "chevron", { size: 16 }));
      toggle.addEventListener("click", () => {
        if (needle || filter.value !== "all") { search.value = ""; filter.value = "all"; }
        open ? expanded.delete(project.id) : expanded.add(project.id);
        render();
      });
      const add = iconButton("plus", { title: `在${project.name}新建对话`, className: "remote-home-add", onClick: async () => {
        add.disabled = true;
        try { await createSession(project.id); } catch (error) { report(error); }
        finally { add.disabled = false; }
      } });
      card.append(el("div", { className: "remote-home-project-header" }, toggle, add));
      if (open) {
        const rows = el("div", { className: "remote-home-sessions" });
        for (const session of sessions) {
          const row = el("button", { className: "remote-home-session", dataset: { sessionId: session.id }, attrs: { type: "button" } },
            el("span", { className: "remote-home-session-main" }, el("span", { text: session.title || "新对话" }),
              el("small", { text: relative(session.updatedAt) })),
            el("span", { className: `remote-home-status${session.running ? " is-running" : ""}`, text: session.running ? "运行中" : "空闲" }));
          row.addEventListener("click", async () => {
            row.disabled = true;
            try { await openSession(session.id); } catch (error) { report(error); }
            finally { row.disabled = false; }
          });
          rows.append(row);
        }
        if (!sessions.length) rows.append(el("p", { className: "remote-home-empty", text: entry.error ? "对话加载失败" : needle || filter.value !== "all" ? "没有匹配的对话" : "还没有对话，点 ＋ 开始。" }));
        if (entry.error) rows.append(el("p", { className: "remote-home-empty", text: entry.error.message || "请刷新重试" }));
        if (entry.nextCursor || entry.error) {
          const more = button(entry.error ? "重新加载" : "加载更多对话", { preserveLabel: true, className: "remote-home-more", onClick: async () => {
            more.disabled = true;
            const version = generation;
            try {
              const page = await read("sessions.list", { projectId: project.id, limit: 100, ...(entry.error ? {} : { cursor: entry.nextCursor }) });
              if (version !== generation) return;
              entry.items = entry.error ? page.items || [] : [...new Map([...entry.items, ...(page.items || [])].map((s) => [s.id, s])).values()];
              entry.nextCursor = page.nextCursor;
              entry.error = null;
              render();
            } catch (error) { report(error); } finally { more.disabled = false; }
          } });
          rows.append(more);
        }
        card.append(rows);
      }
      list.append(card);
    }
    if (!list.childElementCount && !loading) list.append(el("p", { className: "remote-home-empty", text: entries.length ? "没有匹配的项目或对话" : "电脑端尚无可用项目，请先在电脑上打开项目。" }));
    root.scrollTop = scroll;
  }
  async function load() {
    const version = ++generation;
    loading = true;
    refresh.disabled = true;
    render();
    try {
      const result = await read("projects.list");
      if (version !== generation) return;
      const next = [];
      for (const project of result.items || []) {
        try {
          const page = await read("sessions.list", { projectId: project.id, limit: 100 });
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
