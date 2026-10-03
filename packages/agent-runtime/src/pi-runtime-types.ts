import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

/** Desktop-owned transcript projection used by the agent runtime. */
export type Entry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry;

export type EntryBase = {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  type: "message" | "compaction" | "branch_summary" | "custom";
};

export type MessageEntry = EntryBase & {
  type: "message";
  message: AgentMessage;
};

export type CompactionEntry = EntryBase & {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: unknown;
  usage?: Usage;
  fromHook?: boolean;
};

export type BranchSummaryEntry = EntryBase & {
  type: "branch_summary";
  fromId: string | null;
  summary: string;
  details?: unknown;
  usage?: Usage;
  fromHook?: boolean;
};

export type CustomEntry = EntryBase & {
  type: "custom";
  customType: string;
  data?: unknown;
};

export type CompactionSettings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

export type FileOperations = {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
};

export type CompactionPreparation = {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  retainedTail: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
};

export type CompactResult = {
  summary: string;
  tokensBefore: number;
  usage?: Usage;
  retainedTail: AgentMessage[];
  details?: unknown;
};

export type CompactionErrorCode = "aborted" | "summarization_failed";

export class CompactionError extends Error {
  constructor(
    readonly code: CompactionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompactionError";
  }
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CompactionError };

export type RuntimeThinkingLevel = ThinkingLevel;
