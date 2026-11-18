(() => {
  const root = document.documentElement;
  if (root.dataset.lanProjection === "true") return;
  root.dataset.lanProjection = "true";

  const key = "__piLanProjection";
  const panes = ["projects", "chat", "workpanel"];
  const settings = ["settings-directory", "settings-detail"];
  let current = null;
  let applyingHistory = null;
  let pendingMove = null;
  let historyAvailable = true;

  const settingsTarget = (value) => value.layer === "settings-detail" && typeof value.settingsTarget === "string"
    ? value.settingsTarget || undefined : undefined;
  const destination = (value, settingsFrom = "chat") => {
    if (panes.includes(value?.layer)) return { layer: value.layer, depth: panes.indexOf(value.layer) };
    if (!settings.includes(value?.layer)) return null;
    const target = settingsTarget(value);
    return {
      layer: value.layer,
      depth: panes.indexOf(settingsFrom) + 1 + settings.indexOf(value.layer),
      settingsFrom,
      ...(target === undefined ? {} : { settingsTarget: target }),
    };
  };
  const entry = (state) => {
    const value = state?.[key];
    const saved = destination(value, value?.settingsFrom);
    return saved && saved.depth === value.depth && (!saved.settingsFrom || panes.includes(saved.settingsFrom)) ? saved : null;
  };
  const pathFor = (value) => value.settingsFrom
    ? [...panes.slice(0, panes.indexOf(value.settingsFrom) + 1), ...settings.slice(0, settings.indexOf(value.layer) + 1)]
    : panes.slice(0, value.depth + 1);
  const sameDestination = (a, b) => a?.layer === b?.layer && a?.settingsTarget === b?.settingsTarget;
  const navigate = ({ layer, settingsTarget }) => {
    const detail = settingsTarget === undefined ? { layer } : { layer, settingsTarget };
    window.dispatchEvent(new CustomEvent("pi-desktop:projection-navigate", { detail }));
  };
  const record = (next, replace = false) => {
    if (!historyAvailable) return;
    try {
      const state = history.state && typeof history.state === "object" ? history.state : {};
      history[replace ? "replaceState" : "pushState"]({ ...state, [key]: next }, "");
    } catch { historyAvailable = false; }
  };
  const move = (delta, forward, desired) => {
    pendingMove = { forward, desired };
    try { history.go(delta); }
    catch { pendingMove = null; historyAvailable = false; }
  };

  function syncHistory(next, saved, forward) {
    if (!historyAvailable) return;
    if (!saved) { record(next, true); return; }
    const previousPath = pathFor(saved);
    const nextPath = pathFor(next);
    let shared = 0;
    while (shared < nextPath.length && nextPath[shared] === previousPath[shared]) shared++;
    if (shared < previousPath.length) {
      move(shared - previousPath.length, saved, next);
      return;
    }
    if (shared === nextPath.length) {
      if (!sameDestination(saved, next)) record(next, true);
      return;
    }
    if (forward) {
      const forwardPath = pathFor(forward);
      const steps = Math.min(nextPath.length, forwardPath.length) - shared;
      if (steps > 0 && nextPath.slice(shared, shared + steps).every((layer, index) => layer === forwardPath[shared + index])) {
        move(steps, forward, next);
        return;
      }
    }
    for (const layer of nextPath.slice(shared)) {
      record(layer === next.layer ? next : destination({ layer }, next.settingsFrom));
    }
  }

  window.addEventListener("pi-desktop:projection-state", (event) => {
    const state = event.detail;
    if (!state?.ready) return;
    const saved = entry(history.state);
    const from = applyingHistory?.settingsFrom ?? current?.settingsFrom ?? current?.layer ?? saved?.settingsFrom;
    const next = destination(state, panes.includes(from) ? from : undefined);
    if (!next) return;
    if (!current) {
      current = next;
      if (saved) {
        if (!sameDestination(saved, next)) {
          applyingHistory = saved;
          navigate(saved);
        }
      } else {
        const path = pathFor(next);
        record(destination({ layer: path[0] }), true);
        if (path.length > 1) syncHistory(next, entry(history.state));
      }
      return;
    }
    if (applyingHistory) {
      const expected = applyingHistory;
      if (!state.navigationRejected && (next.layer !== expected.layer
        || (expected.settingsTarget !== undefined && next.settingsTarget !== expected.settingsTarget))) return;
      applyingHistory = null;
      current = next;
      if (!sameDestination(saved, next)) record(next, true);
      return;
    }
    if (sameDestination(current, next)) return;
    current = next;
    if (pendingMove) pendingMove.desired = next;
    else syncHistory(next, saved);
  });

  window.addEventListener("pi-desktop:projection-settings-back", (event) => {
    if (current?.layer !== "settings-directory") return;
    event.preventDefault();
    navigate({ layer: current.settingsFrom });
  });

  window.addEventListener("popstate", (event) => {
    const saved = entry(event.state);
    const moveInProgress = pendingMove;
    pendingMove = null;
    if (!current || !saved) return;
    if (moveInProgress) {
      const { desired, forward } = moveInProgress;
      syncHistory(desired, saved, forward);
      return;
    }
    applyingHistory = sameDestination(saved, current) ? null : saved;
    if (applyingHistory) navigate(saved);
  });
})();
