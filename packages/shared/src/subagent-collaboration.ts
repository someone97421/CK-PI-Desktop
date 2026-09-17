/** 子任务旁路监督快照。均为增量附加信息，不改变数据库或既有终态格式。 */
export type SubagentStep = {
  seq: number;
  segmentId: number;
  toolCallId: string;
  toolName: string;
  args: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "success" | "error" | "aborted";
  result?: string;
  truncated?: boolean;
};

export type SubagentProgressReport = {
  reportId: string;
  reportSeq: number;
  delegationId: string;
  segmentId: number;
  fromStep: number;
  toStep: number;
  capturedAt: number;
  generatedAt: number;
  reason: "interval" | "guide" | "completed" | "stopped" | "failed";
  summary: string;
  steps: SubagentStep[];
  truncated: boolean;
  statement?: string;
};

export type SubagentGuideReceipt = {
  delegationId: string;
  commandId: string;
  instruction: string;
  reportIntervalSteps?: number;
  status: "accepted" | "applying" | "applied" | "cancelled" | "rejected";
  receivedAt: number;
  appliedAt?: number;
  reason?: string;
};

export type SubagentCollaborationSnapshot = {
  reportIntervalSteps: number;
  intervalSource: "definition" | "dispatch";
  segmentId: number;
  segmentCompletedSteps: number;
  stepsSinceReport: number;
  startedSteps: number;
  completedSteps: number;
  phase: "running" | "guiding" | "stopping" | "finished";
  stopSource?: "user" | "parent" | "session";
  latestReport?: SubagentProgressReport;
  latestGuide?: SubagentGuideReceipt;
};

export type SubagentStopResult = {
  delegationId: string;
  status: string;
  collaboration?: SubagentCollaborationSnapshot;
};
