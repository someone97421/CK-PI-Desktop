import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, type WorkPanelTab } from "../../stores/app-store";

type RemoteView = "projects" | "chat" | "panel";
type StackEntry = {
  owner: string;
  view: RemoteView;
  sessionId?: string;
  draftId?: string;
  tab?: WorkPanelTab;
  delegationId?: string;
};
const HISTORY_KEY = "piDesktopRemoteStack";

function snapshot(owner: string, view: RemoteView): StackEntry {
  const state = useAppStore.getState();
  return {
    owner, view, sessionId: state.activeSessionId, draftId: state.draftSessionId ?? undefined,
    ...(view === "panel" ? {
      tab: state.workPanelTabs.find((tab) => tab.id === state.activeWorkPanelTabId),
      delegationId: state.subagentPanel?.delegationId,
    } : {}),
  };
}
function closePanels() {
  const state = useAppStore.getState();
  state.closeSubagentPanel();
  state.collapseWorkPanel();
}

export function useRemoteStack(enabled: boolean, ready: boolean, panelPresented: boolean) {
  const [view, setView] = useState<RemoteView>("projects");
  const [busy, setBusy] = useState(false);
  const current = useRef<StackEntry>({ owner: "", view: "projects" });
  const applying = useRef(false);
  const generation = useRef(0);
  const pendingNavigations = useRef(0);
  const alive = useRef(false);
  const write = useCallback((entry: StackEntry, replace = false) => {
    const state = { ...window.history.state, [HISTORY_KEY]: entry };
    if (replace) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    current.current = entry;
    setView(entry.view);
  }, []);

  useEffect(() => {
    if (!enabled || !ready) return;
    alive.current = true;
    const owner = crypto.randomUUID();
    applying.current = true;
    closePanels();
    write({ owner, view: "projects" }, true);
    applying.current = false;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (applying.current || state.page !== "chat") return;
      const identityChanged = state.activeSessionId !== previous.activeSessionId || state.draftSessionId !== previous.draftSessionId
        || (Boolean(previous.selectingSessionId) && !state.selectingSessionId) || previous.page !== "chat";
      const panel = state.workPanelOpen || Boolean(state.subagentPanel?.sessionId === state.activeSessionId && state.subagentPanel);
      const entry = current.current;
      if (identityChanged && !state.selectingSessionId) {
        // 草稿首次发送落库更新当前记录，不额外增加一层历史。
        const next = snapshot(owner, entry.view === "projects" ? "chat" : entry.view);
        write(next, entry.view !== "projects");
      }
      if (panel && current.current.view !== "panel") {
        if (current.current.view === "projects") write(snapshot(owner, "chat"));
        write(snapshot(owner, "panel"));
      } else if (panel && current.current.view === "panel" && (state.activeWorkPanelTabId !== previous.activeWorkPanelTabId
        || state.workPanelTabs !== previous.workPanelTabs || state.subagentPanel !== previous.subagentPanel)) {
        write(snapshot(owner, "panel"), true);
      } else if (!panel && current.current.view === "panel") {
        applying.current = true;
        window.history.back();
      }
    });
    const onPop = (event: PopStateEvent) => {
      const stored = event.state?.[HISTORY_KEY] as StackEntry | undefined;
      const target: StackEntry = stored?.owner === owner ? stored : { owner, view: "projects" };
      const request = ++generation.current;
      pendingNavigations.current += 1;
      applying.current = true;
      setBusy(true);
      current.current = target;
      setView(target.view);
      void (async () => {
        closePanels();
        const state = useAppStore.getState();
        if (target.view !== "projects") {
          if (target.sessionId && target.sessionId !== state.activeSessionId) {
            await state.selectSession(target.sessionId, { record: false });
          } else if (!target.sessionId && target.draftId && target.draftId !== state.draftSessionId) {
            await state.newSession({ draftId: target.draftId, record: false });
          }
          if (request !== generation.current || !alive.current) return;
          closePanels();
          const latest = useAppStore.getState();
          latest.setPage("chat", { record: false });
          if (target.view === "panel") {
            if (target.tab) latest.openWorkPanelTab(target.tab);
            else if (!target.delegationId) latest.openWorkPanel();
            if (target.delegationId) latest.toggleSubagentPanel(target.delegationId);
          }
        }
      })().catch((error) => {
        if (request !== generation.current || !alive.current) return;
        useAppStore.getState().showToast(String(error), { variant: "error" });
        write({ owner, view: "projects" }, true);
      }).finally(() => {
        pendingNavigations.current -= 1;
        if (!pendingNavigations.current && alive.current) {
          applying.current = false;
          setBusy(false);
        }
      });
    };
    window.addEventListener("popstate", onPop);
    return () => {
      alive.current = false;
      generation.current += 1;
      applying.current = false;
      unsubscribe();
      window.removeEventListener("popstate", onPop);
    };
  }, [enabled, ready, write]);

  const openChat = useCallback(async (action?: () => Promise<void>) => {
    if (applying.current) return;
    applying.current = true;
    const request = ++generation.current;
    pendingNavigations.current += 1;
    setBusy(true);
    try {
      closePanels();
      if (action) await action();
      if (!alive.current || request !== generation.current) return;
      closePanels();
      useAppStore.getState().setPage("chat", { record: false });
      write(snapshot(current.current.owner, "chat"), current.current.view === "chat");
    } catch (error) {
      useAppStore.getState().showToast(String(error), { variant: "error" });
    } finally {
      pendingNavigations.current -= 1;
      if (!pendingNavigations.current && alive.current) {
        applying.current = false;
        setBusy(false);
      }
    }
  }, [write]);
  const back = useCallback(() => {
    if (applying.current) return;
    applying.current = true;
    window.history.back();
  }, []);

  const page = useAppStore((state) => state.page);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("pi-desktop:remote-view", {
      detail: { canCompose: ready && page === "chat" && (!enabled || (view === "chat" && !busy && !panelPresented)) },
    }));
    if (!enabled || view !== "chat" || busy || panelPresented) return;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused === document.body || focused?.closest("[hidden], [inert]")) {
        document.querySelector<HTMLButtonElement>(".conversation-topbar button")?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, ready, view, page, busy, panelPresented]);
  return { view, busy, openChat, back };
}
