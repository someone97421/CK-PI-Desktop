import { expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { subagentResultsFromHistory } from "./subagent-recovery.js";

function row(execution: number, status: string, report = ""): UiMessage {
  return { id: `${execution}-${status}`, role: "tool", toolName: "TaskExecution", content: "", createdAt: "2026-10-10T00:00:00Z",
    toolResult: { details: { delegationId: "task", sessionId: "session", execution, status, report, task: "定位问题", agent: "explorer" } } } as UiMessage;
}

it("普通结果能独立成为续接材料，但不伪装为完整上下文", () => {
  const records = subagentResultsFromHistory([row(1, "completed", "问题在文件第十行")]);
  expect(records.get("task")).toMatchObject({ canResume: false, persistenceState: "unavailable", taskInstruction: "定位问题", lastReportSummary: "问题在文件第十行" });
});

it("同轮迟到开始记录不覆盖完成结果，停止记录不被完成记录覆盖", () => {
  const records = subagentResultsFromHistory([row(1, "completed", "完成"), row(1, "running"), row(1, "stopped"), row(1, "completed", "迟到")]);
  expect(records.get("task")).toMatchObject({ status: "revoked", lastReportSummary: "完成" });
});

it("新一轮已经开始时，旧轮快照结果不能被当成本轮完成", () => {
  const records = subagentResultsFromHistory([row(2, "running"), row(1, "completed", "旧报告")]);
  expect(records.get("task")).toMatchObject({ execution: 2, status: "interrupted", canResume: false });
});
