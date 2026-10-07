import { splitInlineContent, type MessageAttachment } from "@pi-desktop/shared";
import { splitChatText } from "../../../lib/chat-links.ts";

/** 正文已有的引用与行内附件保持内嵌，旧消息未写入正文的附件仍可打开。 */
export function getExtraMessageAttachments(
  content: string,
  attachments: readonly MessageAttachment[] | undefined,
  workspaceRoot?: string | null,
): MessageAttachment[] {
  if (!attachments?.length) return [];
  const inlineFiles = new Set<string>();
  const inlineSessions = new Set<string>();
  for (const segment of splitChatText(content, workspaceRoot)) {
    if (segment.kind !== "target") continue;
    if (segment.target.kind === "file") inlineFiles.add(segment.target.path);
    if (segment.target.kind === "session") inlineSessions.add(segment.target.sessionId);
  }
  return splitInlineContent(content, attachments).trailing.filter((attachment) =>
    attachment.kind === "session"
      ? !inlineSessions.has(attachment.ref)
      : !inlineFiles.has(attachment.ref),
  );
}
