(() => {
  const root = document.documentElement;
  if (root.dataset.lanProjection === "true") return;
  root.dataset.lanProjection = "true";

  const key = "__piLanProjection";
  const levels = { projects: 0, chat: 1, workpanel: 2 };
  const selectors = { projects: ".sidebar", chat: ".main-pane", workpanel: ".work-panel" };
  const focusByLayer = new Map();
  let current = null;
  let started = false;
  let applyingHistory = null;
  let pendingBack = null;
  let historyAvailable = true;
  let focusFrame = null;

  const entry = (state) => {
    const value = state?.[key];
    return value && Object.hasOwn(levels, value.layer) && value.depth === levels[value.layer] ? value : null;
  };
  const navigate = (layer) => window.dispatchEvent(new CustomEvent("pi-desktop:projection-navigate", { detail: { layer } }));
  const record = (layer, replace = false) => {
    try {
      const state = history.state && typeof history.state === "object" ? history.state : {};
      history[replace ? "replaceState" : "pushState"]({ ...state, [key]: { layer, depth: levels[layer] } }, "");
    } catch { historyAvailable = false; }
  };
  const visible = (node) => node?.isConnected && !node.closest("[inert], [aria-hidden='true'], [hidden]") && node.getClientRects().length > 0;
  const paneFor = (layer) => document.querySelector(layer === "chat" && document.querySelector(".app-shell.settings-mode") ? ".settings-shell" : selectors[layer]);
  const outsideOverlay = (pane) => Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]'))
    .some((node) => node !== pane && !pane?.contains(node) && visible(node));
  const restoreFocus = (layer) => {
    if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = null;
      const pane = paneFor(layer);
      if (!pane || outsideOverlay(pane)) return;
      const previous = focusByLayer.get(layer);
      const target = visible(previous) ? previous : pane.querySelector(layer === "workpanel"
        ? '.work-panel-maximize, button:not(:disabled), [tabindex="0"]'
        : 'button:not(:disabled), [tabindex="0"], input:not(:disabled), textarea:not(:disabled)');
      if (visible(target)) target.focus({ preventScroll: true });
    });
  };

  document.addEventListener("focusin", (event) => {
    if (!current || !event.target?.closest) return;
    if (event.target.closest(selectors[current]) || event.target.closest(".app-work-panel-toggle")) focusByLayer.set(current, event.target);
  });

  window.addEventListener("pi-desktop:projection-state", (event) => {
    const state = event.detail;
    if (!state?.ready || !Object.hasOwn(levels, state.layer)) return;
    const next = state.layer;
    if (!started) {
      started = true;
      current = next;
      const saved = entry(history.state);
      if (saved && saved.layer !== next) {
        applyingHistory = saved.layer;
        navigate(saved.layer);
      } else {
        if (!saved && next !== "projects") {
          record("projects", true);
          if (next === "workpanel") record("chat");
          record(next);
        } else record(next, true);
        restoreFocus(next);
      }
      return;
    }
    if (applyingHistory !== null) {
      if (next !== applyingHistory && !state.navigationRejected) return;
      applyingHistory = null;
      current = next;
      if (entry(history.state)?.layer !== next) record(next, true);
      restoreFocus(next);
    }
    if (next === current) return;
    const previous = current;
    current = next;
    restoreFocus(next);
    if (!historyAvailable) return;
    if (pendingBack) { pendingBack = next; return; }
    const depth = levels[next] - levels[previous];
    if (depth > 0) {
      if (previous === "projects" && next === "workpanel") record("chat");
      record(next);
    } else if (!pendingBack) {
      const saved = entry(history.state);
      if (saved?.layer === previous) {
        pendingBack = next;
        try { history.go(depth); }
        catch { pendingBack = null; historyAvailable = false; }
      } else record(next, true);
    }
  });

  window.addEventListener("popstate", (event) => {
    const desired = pendingBack;
    pendingBack = null;
    const saved = entry(event.state);
    if (!saved) return;
    if (desired && desired !== saved.layer) {
      pendingBack = desired;
      try { history.go(levels[desired] - saved.depth); }
      catch { pendingBack = null; historyAvailable = false; }
      return;
    }
    if (saved.layer === current) { applyingHistory = null; return; }
    applyingHistory = saved.layer;
    navigate(saved.layer);
  });

  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || !started || !current) return;
    const pane = paneFor(current);
    if (outsideOverlay(pane)) return;
    if (event.key === "Escape") {
      if (current === "projects" || pendingBack || event.target?.closest?.("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      if (historyAvailable && entry(history.state)?.depth > 0) {
        pendingBack = current === "workpanel" ? "chat" : "projects";
        try { history.back(); }
        catch { pendingBack = null; historyAvailable = false; navigate(current === "workpanel" ? "chat" : "projects"); }
      } else navigate(current === "workpanel" ? "chat" : "projects");
    } else if (event.key === "Tab" && current === "workpanel" && pane) {
      const items = Array.from(pane.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(visible);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const focused = document.activeElement;
      if (event.shiftKey ? focused === first || !pane.contains(focused) : focused === last || !pane.contains(focused)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  });
})();
