/**
 * Session references: `pi-desktop://session/<id>` links a Composer draft carries.
 *
 * The link is the whole interaction — no new Composer trigger symbol — and the
 * transcript shows it as a card next to the user's words. Electron main is the
 * only writer: it reads the referenced conversation through the host, refuses
 * what this conversation may not pull, and attaches a bounded excerpt that
 * travels with the message from then on.
 */
import { parseSessionLinks, type MessageAttachment } from "@pi-desktop/shared";
import { resolve } from "node:path";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";

/** Newest messages read from the referenced conversation. */
export const SESSION_REFERENCE_MESSAGE_LIMIT = 40;
/** Per-field cap for one referenced message. */
export const SESSION_REFERENCE_CONTENT_LIMIT = 8 * 1024;
/** Whole excerpt cap; the model gets a bounded quotation, never a whole session. */
export const SESSION_REFERENCE_TOTAL_LIMIT = 16 * 1024;

type ReferencedMessage = {
  role?: string;
  content?: string;
  toolName?: string;
  isError?: boolean;
};

type ReferencedSession = {
  id?: string;
  title?: string;
  projectPath?: string;
  temporaryWorkspacePath?: string;
  messages?: ReferencedMessage[];
};

/** The words the model sees for one referenced conversation. */
export function formatSessionExcerpt(
  session: ReferencedSession,
  limit = SESSION_REFERENCE_TOTAL_LIMIT,
): string {
  const title = (session.title || session.id || "").trim();
  const lines: string[] = [];
  const messages = [...(session.messages ?? [])].reverse();
  let used = 0;
  let omitted = 0;
  for (const message of messages) {
    const text = (message.content ?? "").trim();
    if (!text) continue;
    const role = message.toolName
      ? `tool ${message.toolName}`
      : message.role === "assistant"
        ? "assistant"
        : "user";
    const line = `${role}: ${text}`;
    if (used + line.length > limit) {
      omitted += 1;
      continue;
    }
    used += line.length;
    lines.unshift(line);
  }
  if (!lines.length) return "";
  const head = [
    `Referenced conversation "${title}" (${session.id ?? "unknown"}).`,
    `${lines.length} message${lines.length === 1 ? "" : "s"} shown in order, newest last` +
      (omitted ? `, ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted for length.` : "."),
  ].join(" ");
  return [head, "", ...lines].join("\n");
}

/** Compare project and temporary-session roots with the host platform's path rules. */
function canonicalProject(path: string | undefined): string {
  const value = path?.trim();
  if (!value) return "";
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function referenceScope(session: Pick<ReferencedSession, "projectPath" | "temporaryWorkspacePath">): string {
  return session.projectPath?.trim()
    ? `project:${canonicalProject(session.projectPath)}`
    : `temporary:${canonicalProject(session.temporaryWorkspacePath)}`;
}

/**
 * Resolves every session link in one prompt into an attachment record. Skipped
 * references stay plain text in the message: the current conversation is never
 * referenced, and another project's transcript is not this turn's context.
 */
export async function resolveSessionReferences({
  host,
  logger,
  sessionId,
  projectPath,
  temporaryWorkspacePath,
  content,
}: {
  host: HostProcess;
  logger: Pick<Logger, "app">;
  sessionId: string;
  projectPath?: string;
  temporaryWorkspacePath?: string;
  content: string;
}): Promise<MessageAttachment[]> {
  const ids = parseSessionLinks(content).filter((id) => id !== sessionId);
  if (!ids.length) return [];
  const attachments: MessageAttachment[] = [];
  for (const id of ids) {
    try {
      const result = await host.call<{ session?: ReferencedSession }>("session.get", {
        id,
        messageLimit: SESSION_REFERENCE_MESSAGE_LIMIT,
        contentLimit: SESSION_REFERENCE_CONTENT_LIMIT,
      });
      const referenced = result.session;
      if (!referenced) {
        logger.app("session", "warn", "session reference not found", {
          sessionId,
          data: id,
        });
        continue;
      }
      if (referenceScope(referenced) !== referenceScope({ projectPath, temporaryWorkspacePath })) {
        logger.app("session", "warn", "session reference outside this project was skipped", {
          sessionId,
          data: id,
        });
        continue;
      }
      const text = formatSessionExcerpt(referenced);
      if (!text) continue;
      attachments.push({
        kind: "session",
        name: (referenced.title || id).trim(),
        ref: id,
        text,
      });
    } catch (error) {
      logger.app("session", "warn", "session reference read failed", {
        sessionId,
        data: `${id}: ${String(error)}`,
      });
    }
  }
  return attachments;
}
