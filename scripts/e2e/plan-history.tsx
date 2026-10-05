import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { PlanProposal, SessionDetail, UiMessage } from "@pi-desktop/shared";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/base.css";

const i18n = createInstance();
const ready = i18n.init({ lng: "en", resources: Object.fromEntries(Object.entries(catalogs).map(([key, catalog]) => [key, { translation: catalog }])), interpolation: { escapeValue: false } });
const root = createRoot(document.body);
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function History() {
  const messages = useAppStore(state => state.messages);
  return <TranscriptDisclosureProvider>{messages.filter(message => message.role === "tool").map(message => <ToolRow key={message.id} message={message} />)}</TranscriptDisclosureProvider>;
}
function select(detail: SessionDetail) {
  flushSync(() => useAppStore.setState({ activeSessionId: detail.id, messages: detail.messages, sessions: [detail] }));
}

Object.assign(globalThis, {
  async planHistoryLoad(id: string, statuses: string[], locale = "en") {
    await ready;
    await i18n.changeLanguage(locale);
    const { session } = await api.getSession(id, { messageLimit: 20, contentLimit: 16 });
    assert(session, "session read failed");
    select(session!);
    flushSync(() => root.render(<I18nextProvider i18n={i18n}><History /></I18nextProvider>));
    await painted();
    const cards = [...document.querySelectorAll<HTMLElement>(".plan-history-card")];
    assert(cards.length === statuses.length, "missing historical submission card");
    for (const [index, card] of cards.entries()) {
      const message = session!.messages.filter(message => message.role === "tool")[index];
      const proposal = message.planHistory!.proposal;
      assert(proposal.status === statuses[index], "host approval status missing");
      assert(card.textContent?.includes(i18n.t(`planHistory.${statuses[index]}`)), "localized status missing");
      const title = card.querySelector<HTMLButtonElement>(".plan-history-title")!;
      if (title.getAttribute("aria-expanded") === "false") flushSync(() => title.click());
      await painted();
      assert(card.querySelector(".plan-history-body h1")?.textContent === "Exact " + proposal.title, "full Markdown snapshot was capped or missing");
      assert(card.querySelector(".plan-history-body")?.textContent?.includes("END-" + proposal.title), "Markdown tail was lost");
      flushSync(() => card.querySelector<HTMLButtonElement>(".plan-history-artifact")!.click());
      assert(useAppStore.getState().workPanelFileRequest?.path === proposal.artifact!.relativePath, "artifact did not open for its owning session");
      assert(!card.querySelector(".plan-approve") && !card.textContent?.includes("Approve (Ask)"), "history must not offer approval actions");
    }
    return { cards: cards.length, locale, statuses };
  },
  async planHistoryStateOnly() {
    const state = useAppStore.getState();
    const proposal = state.messages[0].planHistory!.proposal;
    useAppStore.setState({ planCheckpoints: { [proposal.sessionId]: proposal } });
    flushSync(() => state.handlePlansChanged({ sessionId: proposal.sessionId, state: "inactive", kind: proposal.kind }));
    assert(useAppStore.getState().messages[0].planHistory?.proposal.status === "pending", "state-only mode change invented approval");
    return { stateOnlyDoesNotApprove: true };
  },
  async planHistoryLive(proposal: PlanProposal, staleMessage: UiMessage) {
    const state = useAppStore.getState();
    // Both live channels must project the accepted host checkpoint.
    flushSync(() => state.handlePlansChanged({ sessionId: proposal.sessionId, state: "inactive", proposal, kind: proposal.kind }));
    flushSync(() => state.handleAgentEvent({ sessionId: proposal.sessionId, event: { type: "message_end", message: staleMessage } }));
    await painted();
    assert(useAppStore.getState().messages.find(row => row.toolCallId === proposal.toolCallId)?.planHistory?.proposal.status === "approved", "late pending tool echo rolled back approval");
    assert(document.querySelector(".plan-history-card")?.textContent?.includes("Approved"), "live history status did not repaint");
    const pending = (staleMessage.toolResult as { details: { proposal: PlanProposal } }).details.proposal;
    flushSync(() => state.handlePlansChanged({ sessionId: proposal.sessionId, state: "awaiting_approval", proposal: pending, kind: pending.kind }));
    assert(useAppStore.getState().messages[0].planHistory?.proposal.status === "approved", "stale host revision rolled back history");
    // An authoritative event can arrive before the tool's terminal row.
    flushSync(() => useAppStore.setState({ messages: [] }));
    flushSync(() => state.handleAgentEvent({ sessionId: proposal.sessionId, ts: Date.now(), event: {
      type: "planning_state", state: "inactive", proposal, kind: proposal.kind,
    } }));
    flushSync(() => state.handleAgentEvent({ sessionId: proposal.sessionId, ts: Date.now(), event: { type: "message_end", message: staleMessage } }));
    assert(useAppStore.getState().messages[0]?.planHistory?.proposal.status === "approved", "approval-before-message was lost");
    // Switching away retains a pane; events must update that transcript too.
    flushSync(() => useAppStore.setState({ activeSessionId: "other", messages: [], retainedTranscripts: { [proposal.sessionId]: [staleMessage] } }));
    flushSync(() => state.handlePlansChanged({ sessionId: proposal.sessionId, state: "inactive", proposal, kind: proposal.kind }));
    assert(useAppStore.getState().retainedTranscripts[proposal.sessionId][0].planHistory?.proposal.status === "approved", "inactive retained pane kept pending state");
    flushSync(() => useAppStore.setState({ activeSessionId: proposal.sessionId, messages: useAppStore.getState().retainedTranscripts[proposal.sessionId] }));
    return { liveApproval: true, staleEcho: true, eventBeforeMessage: true, inactiveRetainedPane: true };
  },
  async planHistoryPagination(id: string) {
    const latest = (await api.getSession(id, { messageLimit: 1, contentLimit: 16 })).session!;
    assert(latest.planHistory?.length === 1 && latest.planHistory[0].proposal.status === "rejected", "latest page included unrelated plans");
    const older = (await api.getSession(id, { messageLimit: 1, messageBefore: latest.messageStart })).session!;
    assert(older.planHistory?.length === 1 && older.planHistory[0].superseded && older.planHistory[0].proposal.status === "approved", "old page lost its current state/superseded marker");
    return { pagination: true };
  },
});
