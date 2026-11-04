import { assistantTurnMessages, type TranscriptEntry } from "./assistant-turns";
import { messageContentFacts } from "./transcript-summary";

export type ConversationMinimapMarker = {
  id: string;
  role: "user" | "assistant";
  preview: string;
};

export const CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS = 280;

export function shouldRenderConversationMinimap({
  markerCount,
  overflows,
  hasEarlier,
}: {
  markerCount: number;
  overflows: boolean;
  hasEarlier: boolean;
}): boolean {
  return hasEarlier || (markerCount >= 2 && overflows);
}

function appendPreview(current: string, next: string): string {
  if (!next || current.length >= CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS) {
    return current;
  }
  return `${current}${current ? "\n\n" : ""}${next}`.slice(
    0,
    CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
  );
}

/**
 * One marker per mounted user message and assistant turn. Assistant markers use
 * the turn's own `data-minimap-id`, which stays mounted when its process drawer
 * is folded and follows the turn's final answer once a task completes.
 */
export function buildConversationMinimapMarkers(
  entries: readonly TranscriptEntry[],
): ConversationMinimapMarker[] {
  const markers: ConversationMinimapMarker[] = [];
  for (const entry of entries) {
    if (entry.kind === "message") {
      const { message } = entry;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const preview = messageContentFacts(message).trimmedContent.slice(
        0, CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS,
      );
      if (message.role === "assistant" && !preview) continue;
      markers.push({ id: message.id, role: message.role, preview });
      continue;
    }
    if (entry.kind !== "assistant-turn" || !entry.anchorId) continue;
    const messages = assistantTurnMessages(entry);
    const anchor = messages.find((message) => message.id === entry.anchorId);
    let preview = "";
    for (const message of anchor ? [anchor, ...messages.filter((item) => item !== anchor)] : messages) {
      if (preview.length >= CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS) break;
      preview = appendPreview(preview, messageContentFacts(message).trimmedContent);
    }
    markers.push({ id: entry.anchorId, role: "assistant", preview });
  }
  return markers;
}
