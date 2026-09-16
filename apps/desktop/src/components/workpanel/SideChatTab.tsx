import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript, TranscriptReadOnlyContext } from "../ChatTranscript";
import { PermissionCard } from "../PermissionCard";
import { AskToolCard } from "../AskToolCard";
import { Button } from "../ui";
import { useAppStore } from "../../stores/app-store";
import { sideChatSendBlockReason } from "../../lib/side-chat";
import { headAsk, queuedAskCount } from "../../lib/pending-asks";
import { headPermission, sessionPermissions } from "../../lib/pending-permissions";

const EMPTY_MESSAGES: UiMessage[] = [];

/**
 * The docked side-chat surface (ADR message-quotes-and-side-chats / D-LOCAL-message-quotes).
 *
 * Before first Send the panel shows an anchored preview and a draft. After
 * creation it renders the child session's own live projection, so a follow-up
 * conversation streams, asks for permission, and can be stopped without making
 * the child the application's visible session. Closing the panel or promoting it
 * releases the renderer-only registration; the child session is durable and
 * stays in the sidebar, where it opens as an ordinary conversation.
 */
export function SideChatTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const messages = useAppStore(
    (s) => s.sideChatTranscripts[sessionId] ?? EMPTY_MESSAGES,
  );
  const isRunning = useAppStore((s) => s.runningSessions[sessionId] ?? false);
  const planningState = useAppStore((s) => s.planningStates[sessionId]);
  const pendingPermission = useAppStore((s) =>
    headPermission(s.pendingPermissions, sessionId),
  );
  const queuedPermissions = useAppStore((s) =>
    Math.max(0, sessionPermissions(s.pendingPermissions, sessionId).length - 1),
  );
  const pendingAsk = useAppStore((s) => headAsk(s.pendingAsks, sessionId));
  const queuedAsks = useAppStore((s) => queuedAskCount(s.pendingAsks, sessionId));
  const sendSideChatPrompt = useAppStore((s) => s.sendSideChatPrompt);
  const entry = useAppStore((s) => s.sideChats[sessionId]);
  const updateSideChatDraft = useAppStore((s) => s.updateSideChatDraft);
  const abortSession = useAppStore((s) => s.abortSession);
  const closeSideChat = useAppStore((s) => s.closeSideChat);
  const addSideChatReplyToMain = useAppStore((s) => s.addSideChatReplyToMain);
  const selectSession = useAppStore((s) => s.selectSession);
  const draft = entry?.draft ?? "";
  const sending = entry?.sending ?? false;
  const blockedReason = useAppStore((state) => sideChatSendBlockReason(
    state.sideChats[sessionId], state.sessions, state.runningSessions,
  ));
  const sendBlocked = Boolean(blockedReason);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || sendBlocked) return;
    await sendSideChatPrompt(sessionId);
  };

  const openAsConversation = async () => {
    if (entry?.pending || sending) return;
    // Release first: the promotion replaces the panel with the ordinary
    // conversation surface, including the full composer and prompt queue.
    closeSideChat(sessionId);
    await selectSession(sessionId);
  };

  return (
    <div className="side-chat" data-side-chat={sessionId}>
      <div className="side-chat-actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="side-chat-action"
          data-side-chat-action="add-to-main"
          disabled={entry?.pending || !messages.some((message) => message.role === "assistant")}
          onClick={() => addSideChatReplyToMain(sessionId)}
        >
          {t("sideChat.addToMain")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="side-chat-action"
          data-side-chat-action="open-as-session"
          disabled={entry?.pending || sending}
          onClick={() => void openAsConversation()}
        >
          {t("sideChat.openAsSession")}
        </Button>
      </div>
      <div className="side-chat-thread">
        {/* A read-only projection: the child's rows must not offer the active
            session's Edit/Delete/Retry/Fork/Quote actions, and the panel owns the
            one permission card below, so the transcript renders content only. */}
        <TranscriptReadOnlyContext.Provider value>
          <ChatTranscript
            sessionId={sessionId}
            messages={messages}
            hasMoreBefore={false}
            isRunning={isRunning}
            pendingPermission={pendingPermission}
            queuedPermissions={queuedPermissions}
            askPending={Boolean(pendingAsk)}
            planningState={planningState}
            paneVisible
          />
        </TranscriptReadOnlyContext.Provider>
      </div>
      {/* The child asks its own questions; the card resolves that child's
          request id, so answering it here keeps the side chat moving. */}
      {pendingAsk ? (
        <AskToolCard request={pendingAsk} queued={queuedAsks} />
      ) : null}
      {entry?.error ? <div role="alert">{entry.error}</div> : null}
      <form
        className="side-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="side-chat-input selectable"
          value={draft}
          rows={2}
          placeholder={t("sideChat.placeholder")}
          aria-label={t("sideChat.placeholder")}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => updateSideChatDraft(sessionId, event.target.value)}
          onKeyDown={(event) => {
            // Same contract as the composer: Enter sends, Shift+Enter breaks the
            // line, and an in-flight IME composition owns Enter (D125).
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        <div className="side-chat-composer-row">
          <span className="side-chat-hint">
            {blockedReason
              ? t(blockedReason)
              : messages.length === 0
                ? t("sideChat.empty")
                : null}
          </span>
          {isRunning ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="side-chat-action"
              data-side-chat-action="stop"
              onClick={() => void abortSession(sessionId)}
            >
              {t("chat.stopGenerating")}
            </Button>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            className="side-chat-action"
            disabled={!draft.trim() || sending || sendBlocked}
          >
            {t("chat.send")}
          </Button>
        </div>
      </form>
      {pendingPermission ? (
        <PermissionCard
          key={pendingPermission.requestId}
          permission={pendingPermission}
          queued={queuedPermissions}
        />
      ) : null}
    </div>
  );
}
