import i18n from "i18next";
import type { AppState } from "../app-state";
import type { StoreAccess } from "./types";
import { api } from "../../lib/api";
import { forkedSessionMessages } from "../../lib/session-fork";
import { sideChatSendBlockReason, registerSideChat, removeSideChat, sideChatEntry, sideChatWorkPanelTab, sideChatsForParent } from "../../lib/side-chat";
import type { SessionSliceDependencies } from "./session-slice";

export function createSideChatSlice({ get, set, commitForkedSession, withoutRecordKey }: StoreAccess &
  Pick<SessionSliceDependencies, "commitForkedSession" | "withoutRecordKey">): Pick<AppState,
  "openSideChat" | "updateSideChatDraft" | "sendSideChatPrompt" | "closeSideChat" | "addSideChatReplyToMain" | "abortSession"> {
  const sends = new Map<string, Promise<boolean>>();
  const updateEntry = (id: string, patch: Partial<AppState["sideChats"][string]>) => {
    set((state) => state.sideChats[id] ? {
      sideChats: { ...state.sideChats, [id]: { ...state.sideChats[id], ...patch } },
    } : {});
  };
  return {
    openSideChat: async (messageId, quote) => {
      const state = get();
      const parentSessionId = state.activeSessionId;
      if (!parentSessionId) return null;
      const index = state.messages.findIndex((message) => message.id === messageId);
      const parent = state.sessions.find((session) => session.id === parentSessionId);
      if (index < 0 || !parent || state.runningSessions[parentSessionId]) return null;
      const existing = sideChatsForParent(state.sideChats, parentSessionId).find(
        (chat) => chat.anchorMessageId === messageId,
      );
      const id = existing?.sessionId ?? `side-draft:${crypto.randomUUID()}`;
      const prefill = quote ? `${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
      if (existing) {
        if (prefill) updateEntry(id, { draft: [existing.draft, prefill].filter(Boolean).join("\n\n") });
      } else {
        const sourceTitle = parent.title.trim() || i18n.t("chat.untitledTask");
        set((current) => ({
          sideChats: registerSideChat(current.sideChats, sideChatEntry({
            sessionId: id,
            parentSessionId,
            anchorMessageId: messageId,
            title: i18n.t("sideChat.sessionTitle", { title: sourceTitle }),
            pending: true,
            draft: prefill,
          })),
          sideChatTranscripts: {
            ...current.sideChatTranscripts,
            [id]: state.messages.slice(0, index + 1),
          },
        }));
      }
      get().openWorkPanelTabForSession(parentSessionId, sideChatWorkPanelTab(id));
      return id;
    },
    updateSideChatDraft: (id, text) => updateEntry(id, { draft: text }),
    sendSideChatPrompt: async (id) => {
      const inFlight = sends.get(id);
      if (inFlight) return inFlight;
      const entry = get().sideChats[id];
      const text = entry?.draft?.trim();
      if (!entry || !text || entry.sending) return false;
      const blocked = sideChatSendBlockReason(entry, get().sessions, get().runningSessions);
      if (blocked) {
        get().showToast(i18n.t(blocked), { variant: "info" });
        return false;
      }
      updateEntry(id, { sending: true, error: undefined });
      const request = (async () => {
        let targetId = id;
        try {
          if (entry.pending) {
            const result = await api.forkSession(entry.parentSessionId, entry.title, entry.anchorMessageId);
            const child = result.session;
            targetId = child.id;
            commitForkedSession(child, { activate: false, clearError: true });
            // Replace only the original draft's tab. A close or parent switch
            // during the host call must never reopen a panel in another context.
            set((state) => {
              const current = state.sideChats[id];
              if (!current) return {};
              const oldTabId = sideChatWorkPanelTab(id).id;
              const tab = sideChatWorkPanelTab(child.id);
              const replaceTabs = (tabs: AppState["workPanelTabs"]) =>
                tabs.map((item) => item.id === oldTabId ? tab : item);
              return {
                sideChats: registerSideChat(removeSideChat(state.sideChats, id), {
                  ...current, sessionId: child.id, title: child.title, pending: false,
                }),
                sideChatTranscripts: {
                  ...withoutRecordKey(state.sideChatTranscripts, id),
                  [child.id]: forkedSessionMessages(child),
                },
                workPanelTabs: replaceTabs(state.workPanelTabs),
                activeWorkPanelTabId: state.activeWorkPanelTabId === oldTabId ? tab.id : state.activeWorkPanelTabId,
                workPanelContexts: Object.fromEntries(Object.entries(state.workPanelContexts).map(([key, context]) => [key, {
                  ...context,
                  tabs: replaceTabs(context.tabs),
                  activeTabId: context.activeTabId === oldTabId ? tab.id : context.activeTabId,
                }])),
              };
            });
          }
          // Forking may await auth/host work. Check the returned child's live
          // availability, including when its panel was closed during creation.
          const blocked = sideChatSendBlockReason(
            { ...entry, sessionId: targetId, pending: false },
            get().sessions,
            get().runningSessions,
          );
          if (blocked) {
            get().showToast(i18n.t(blocked), { variant: "info" });
            return false;
          }
          const accepted = await get().sendPrompt(text, { text, fileReferences: [] }, targetId);
          if (accepted && get().sideChats[targetId]?.draft === entry.draft) {
            updateEntry(targetId, { draft: "" });
          }
          return accepted;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateEntry(targetId, { error: message });
          set({ error: message, errorCode: (error as { code?: string })?.code ?? null });
          return false;
        } finally {
          updateEntry(targetId, { sending: false });
        }
      })();
      sends.set(id, request);
      try {
        return await request;
      } finally {
        sends.delete(id);
      }
    },
    closeSideChat: (sessionId) => {
      if (!sessionId) return;
      const tabId = sideChatWorkPanelTab(sessionId).id;
      if (get().workPanelTabs.some((tab) => tab.id === tabId)) {
        get().closeWorkPanelTab(tabId);
      }
      set((state) => {
        const sideChats = removeSideChat(state.sideChats, sessionId);
        if (sideChats === state.sideChats) return {};
        // The durable child session stays in the sidebar and in search; only the
        // renderer's panel projection and its tab go away.
        const workPanelContexts = Object.fromEntries(
          Object.entries(state.workPanelContexts).map(([id, context]) => {
            if (!context.tabs.some((tab) => tab.id === tabId)) return [id, context];
            const tabs = context.tabs.filter((tab) => tab.id !== tabId);
            return [
              id,
              {
                ...context,
                tabs,
                activeTabId:
                  context.activeTabId === tabId
                    ? tabs.at(-1)?.id ?? null
                    : context.activeTabId,
              },
            ];
          }),
        );
        return {
          sideChats,
          sideChatTranscripts: withoutRecordKey(
            state.sideChatTranscripts,
            sessionId,
          ),
          workPanelContexts,
        };
      });
    },

    addSideChatReplyToMain: (sessionId) => {
      const entry = get().sideChats[sessionId];
      if (!entry || entry.pending) return;
      const messages = get().sideChatTranscripts[sessionId] ?? [];
      const answer = [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && Boolean((message.content || "").trim()),
        );
      if (!answer) return;
      get().quoteMessageIntoComposer({ title: entry.title, text: answer.content });
    },

    abortSession: async (sessionId) => {
      if (!sessionId) return;
      try {
        await api.abort(sessionId);
      } finally {
        set((state) => ({
          isRunning:
            state.activeSessionId === sessionId ? false : state.isRunning,
          runningSessions: { ...state.runningSessions, [sessionId]: false },
        }));
      }
    },

  };
}
