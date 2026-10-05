import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageEntry, CompactionEntry } from "./pi-runtime-types.js";
import type { UiMessage } from "@pi-desktop/shared";
import { getCurrentTools, Type, type SystemMessage } from "@earendil-works/pi-ai";
import { orderSystemRows, readSystemMessage, SystemTranscriptJournal } from "./system-transcript-journal.js";
import { buildSessionContext } from "./session-context.js";
import { CONTEXT_BUDGET_SECTION, syncSystemSections, systemTranscriptCheckpoint } from "./system-transcript.js";

const tool = { name: "Read", description: "Read", parameters: Type.Object({ path: Type.String() }) };
const initial: SystemMessage = { role: "system", content: "", sections: { runtime: "Instructions", skills: "First skill" }, toolsAdded: [tool], timestamp: 1 };
const user: AgentMessage = { role: "user", content: "Find files", timestamp: 2 };
function entry(message: AgentMessage, id = "user"): MessageEntry {
  return { type: "message", id, seq: 0, parentId: null, timestamp: message.timestamp, message };
}
const userRow: UiMessage = { id: "user", role: "user", content: "Find files", createdAt: new Date(2).toISOString() };

describe("model system journal", () => {
  it("restores the original order even when a user row was pre-persisted", async () => {
    const journal = new SystemTranscriptJournal();
    const rows = [userRow];
    const entries = [entry(user)];
    const delta: SystemMessage = { role: "system", content: "", toolsRemoved: [{ name: "Read" }], timestamp: 3 };
    await journal.persist([initial, user, delta], entries, async (row) => { rows.push(row); });
    expect(rows.map((row) => row.role)).toEqual(["user", "system", "system"]);
    const restored = new SystemTranscriptJournal();
    const messages = orderSystemRows(rows).map((row) => row.modelSystem ? restored.restore(row) : user);
    expect(messages).toEqual([initial, user, delta]);
    expect(getCurrentTools(messages)).toEqual([]);
    const append = vi.fn();
    await restored.persist(messages, entries, append);
    expect(append).not.toHaveBeenCalled();
  });

  it("跳过未持久化通知，保持系统状态的会话锚点和恢复顺序", async () => {
    const journal = new SystemTranscriptJournal();
    const notice: AgentMessage = {
      role: "custom", customType: "run-status", content: "运行状态",
      display: false, timestamp: 3,
    };
    const coordination: AgentMessage = {
      ...notice, customType: "subagent-coordination", timestamp: 5,
    };
    const delta: SystemMessage = {
      role: "system", content: "", toolsRemoved: [{ name: "Read" }], timestamp: 4,
    };
    const nextUser: AgentMessage = { role: "user", content: "继续", timestamp: 6 };
    const entries = [entry(user), entry(nextUser, "next-user")];
    const rows: UiMessage[] = [userRow, { ...userRow, id: "next-user", content: "继续" }];
    await journal.persist([initial, notice, user, notice, delta, coordination, nextUser], entries,
      async (row) => { rows.push(row); });
    expect(rows[2].modelSystem?.beforeMessageId).toBe("user");
    expect(rows[3].modelSystem).toMatchObject({ beforeMessageId: "next-user", afterMessageId: "user" });
    expect(orderSystemRows(rows).map((row) => row.id)).toEqual([rows[2].id, "user", rows[3].id, "next-user"]);
    expect(entries.map((item) => item.message)).toEqual([initial, user, delta, nextUser]);

    const tail: SystemMessage = { ...delta, timestamp: 7 };
    await journal.persist([nextUser, notice, tail], entries, async (row) => { rows.push(row); });
    expect(rows.at(-1)?.modelSystem).toMatchObject({ afterMessageId: "next-user" });
  });

  it("retries failed persistence with the same id and never installs it before acknowledgement", async () => {
    const journal = new SystemTranscriptJournal();
    const entries = [entry(user)];
    const rows: UiMessage[] = [];
    await expect(journal.persist([initial, user], entries, async (row) => {
      rows.push(row); throw new Error("disk full");
    })).rejects.toMatchObject({ code: "LOCAL_REQUEST_ERROR", cause: new Error("disk full") });
    expect(entries).toHaveLength(1);
    await journal.persist([initial, user], entries, async (row) => { rows.push(row); });
    expect(rows[0].id).toBe(rows[1].id);
    expect(entries.map((item) => item.message.role)).toEqual(["system", "user"]);
  });

  it("replaces skill sections without rewriting the old prefix", () => {
    const original = [initial, user];
    const changed = syncSystemSections(original, { runtime: "Instructions", skills: "Second skill" });
    expect(changed.slice(0, 2)).toEqual(original);
    expect(changed.at(-1)).toMatchObject({ sections: { skills: "Second skill" } });
    expect(syncSystemSections(changed, { runtime: "Instructions", skills: "Second skill" })).toBe(changed);
    expect(syncSystemSections(changed, { runtime: "Instructions", skills: "" }).at(-1)).toMatchObject({ sections: { skills: "" } });
  });

  it("restores a compaction checkpoint once before the retained tail", async () => {
    const delta: SystemMessage = { role: "system", content: "", toolsRemoved: [{ name: "Read" }], timestamp: 3 };
    const systemMessage = systemTranscriptCheckpoint([initial, user, delta])!;
    const compaction: CompactionEntry = {
      type: "compaction", id: "cp", seq: 1, parentId: "user", timestamp: 4,
      summary: "Past work", tokensBefore: 100, retainedTail: [initial, user, delta],
      details: { systemMessageJson: JSON.stringify(systemMessage) }, fromHook: false,
    };
    const messages = buildSessionContext([entry(user), compaction]).messages;
    expect(messages.filter((message) => message.role === "system")).toEqual([systemMessage]);
    expect(messages[0]).toEqual(systemMessage);
    expect(getCurrentTools(messages)).toEqual([]);
    const journal = new SystemTranscriptJournal();
    journal.rememberCheckpoint(systemMessage);
    const append = vi.fn();
    await journal.persist(JSON.parse(JSON.stringify(messages)), [], append);
    expect(append).not.toHaveBeenCalled();
  });

  it("expires budget reminders at compaction without dropping active instructions or tools", () => {
    const checkpoint = systemTranscriptCheckpoint([initial, user, {
      role: "system", content: "", sections: { [CONTEXT_BUDGET_SECTION]: "Old window is nearly full" }, timestamp: 3,
    }]);
    expect(checkpoint?.sections).toEqual(initial.sections);
    expect(checkpoint?.toolsAdded).toEqual(initial.toolsAdded);
  });

  it("recognizes a restored checkpoint with text blocks without adding durable rows", async () => {
    const blocks: SystemMessage = { ...initial, content: [{ type: "text", text: "Extension instructions" }] };
    const checkpoint = systemTranscriptCheckpoint([blocks, user])!;
    const journal = new SystemTranscriptJournal();
    journal.rememberCheckpoint(JSON.stringify(checkpoint));
    const append = vi.fn();
    await journal.persist(JSON.parse(JSON.stringify([checkpoint, user])), [], append);
    expect(append).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...initial, timestamp: -1 }, { ...initial, toolsAdded: [{ name: "Read", parameters: "bad" }] }])("rejects malformed saved state", (value) => {
    expect(() => readSystemMessage(value)).toThrow("Invalid persisted model system message");
  });
});
