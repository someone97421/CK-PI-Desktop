import type { Entry } from "./pi-runtime-types.js";

import { isRecord } from "./agent-messages.js";

/**
 * The tool names pi's own compaction inspects, mapped from ours to pi's
 * spelling.
 *
 * The compaction planner switches on lowercase names `read` / `write` / `edit`.
 * PI-Desktop registers `Read` / `Write` / `Edit`, so the conversion keeps
 * checkpoint file lists and summary tags populated.
 *
 * Only these three are converted, and only on the way into pi's preparation.
 * There is nothing to convert for `grep`, `glob` or `bash`: pi's collector does
 * not read them, so leaving them spelled the way we register them keeps the
 * summarized conversation text unchanged for every other tool.
 */
export const PI_FILE_OP_TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
};

/**
 * Copy `entries`, spelling the tool calls pi's file-op collector reads the way
 * pi spells them.
 *
 * The stored history keeps our names: this returns copies and never mutates the
 * entries it is handed, so a transcript, a checkpoint and a rebuilt context are
 * unaffected. The input array itself is returned when nothing needed
 * converting, so a history without those calls costs nothing.
 */
export function withPiFileOpToolNames(entries: Entry[]): Entry[] {
  let changed = false;
  const mapped = entries.map((entry) => {
    const message = (entry as { message?: unknown }).message;
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      return entry;
    }
    let messageChanged = false;
    const content = message.content.map((block: unknown) => {
      if (!isRecord(block) || block.type !== "toolCall") return block;
      const name = typeof block.name === "string" ? block.name : undefined;
      const piName = name ? PI_FILE_OP_TOOL_NAMES[name] : undefined;
      if (!piName) return block;
      messageChanged = true;
      return { ...block, name: piName };
    });
    if (!messageChanged) return entry;
    changed = true;
    return { ...entry, message: { ...message, content } } as Entry;
  });
  return changed ? mapped : entries;
}
