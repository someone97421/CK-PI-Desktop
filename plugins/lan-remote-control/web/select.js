let nextId = 0;

export function enhanceSelect(select) {
  const element = document.createElement("div");
  element.className = "rc-select";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "rc-select-trigger";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "选择");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.title = select.title;
  const text = document.createElement("span");
  trigger.append(text);
  const menu = document.createElement("div");
  menu.className = "rc-select-menu";
  menu.id = `rc-select-${++nextId}`;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", trigger.getAttribute("aria-label"));
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);
  select.hidden = true;
  element.append(select, trigger, menu);
  let events, activeIndex = 0, search = "", searchAt = 0;
  const options = [...select.options];
  const rows = options.map((option, index) => {
    const row = document.createElement("div");
    row.className = "rc-select-option";
    row.id = `${menu.id}-${index}`;
    row.setAttribute("role", "option");
    row.textContent = option.textContent;
    row.addEventListener("click", () => choose(index));
    menu.append(row);
    return row;
  });

  function sync() {
    text.textContent = select.selectedOptions[0]?.textContent || "请选择";
    trigger.disabled = select.disabled;
    rows.forEach((row, index) => {
      row.setAttribute("aria-selected", String(options[index].selected));
      row.setAttribute("aria-disabled", String(options[index].disabled));
    });
  }
  function highlight(index) {
    activeIndex = index;
    rows.forEach((row, i) => row.classList.toggle("is-active", i === index));
    if (rows[index]) {
      trigger.setAttribute("aria-activedescendant", rows[index].id);
      const row = rows[index];
      if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight)
        menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
    }
  }
  function close({ focus = false } = {}) {
    events?.abort();
    events = null;
    menu.hidden = true;
    delete element.dataset.open;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-activedescendant");
    if (focus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  function positionMenu() {
    if (!trigger.isConnected || select.disabled) { close(); return false; }
    const rect = trigger.getBoundingClientRect();
    const bounds = element.closest(".sheet-body")?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = Math.max(viewport?.offsetTop || 0, bounds?.top || 0);
    const bottom = Math.min((viewport?.offsetTop || 0) + (viewport?.height || innerHeight), bounds?.bottom ?? Infinity);
    if (rect.bottom <= top || rect.top >= bottom) { close(); return false; }
    const above = rect.top - top, below = bottom - rect.bottom;
    const scale = rect.height / (trigger.offsetHeight || rect.height);
    const upward = below < Math.min(280, options.length * 40 + 10) * scale && above > below;
    element.dataset.side = upward ? "up" : "down";
    menu.style.maxHeight = `${Math.max(40, Math.min(280, (upward ? above : below) / scale - 12))}px`;
    return true;
  }
  function open() {
    if (select.disabled || !options.some(option => !option.disabled)) return;
    sync();
    if (!positionMenu()) return;
    menu.hidden = false;
    element.dataset.open = "true";
    trigger.setAttribute("aria-expanded", "true");
    highlight(Math.max(0, options.findIndex(option => option.selected && !option.disabled)));
    events = new AbortController();
    const { signal } = events;
    document.addEventListener("pointerdown", event => {
      if (!element.contains(event.target)) close();
    }, { capture: true, signal });
    window.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close({ focus: true });
      }
    }, { capture: true, signal });
    element.addEventListener("focusout", event => {
      if (event.relatedTarget && !element.contains(event.relatedTarget)) close();
    }, { signal });
    document.addEventListener("scroll", event => {
      if (event.target !== menu) positionMenu();
    }, { capture: true, signal });
    window.addEventListener("resize", positionMenu, { signal });
    window.visualViewport?.addEventListener("resize", positionMenu, { signal });
    window.addEventListener("blur", () => close(), { signal });
    window.addEventListener("pagehide", () => close(), { signal });
  }
  function choose(index) {
    if (select.disabled || options[index]?.disabled) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    sync();
    close({ focus: true });
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", event => {
    const { key } = event;
    if (key === "Tab") { close(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
      event.preventDefault();
      if (menu.hidden) { open(); return; }
      if (key === "Enter" || key === " ") { choose(activeIndex); return; }
      const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index !== -1);
      const position = enabled.indexOf(activeIndex);
      const index = key === "Home" ? enabled[0] : key === "End" ? enabled.at(-1)
        : enabled[(position + (key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length];
      highlight(index);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (menu.hidden) open();
      const now = Date.now();
      search = (now - searchAt < 700 ? search : "") + key.toLocaleLowerCase();
      searchAt = now;
      const index = options.findIndex(option => !option.disabled && option.textContent.toLocaleLowerCase().startsWith(search));
      if (index !== -1) highlight(index);
    }
  });
  select.addEventListener("change", sync);
  sync();
  return { element, sync, close };
}
