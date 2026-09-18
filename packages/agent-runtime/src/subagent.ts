/**
 * Subagents: bounded delegate agent loops spawned by the `Task` tool (ADR 0062).
 *
 * A delegate is a second pi `Agent` inside the same sidecar process, with its
 * own system prompt, its own (possibly pinned) provider/model, and only the
 * tools its definition declares. It shares the session's host connection, so
 * every tool call it makes goes through the same host-core permission and
 * containment path as the parent's.
 *
 * Two boundaries define the design:
 * - The parent receives bounded progress snapshots and the final report.
 *   Full child messages/tool rows remain in the transcript; they are not
 *   replayed wholesale into the parent's model context.
 * - A delegate's lifecycle never reaches Electron main's turn handling. It
 *   runs in the background under the session runtime (ADR 0089 / D328):
 *   `Task` starts it and returns, `TaskWait` may converge early, and when it
 *   finishes the runtime delivers the report to the parent even if the parent
 *   already stopped calling tools. Only user Stop or `TaskStop` aborts it.
 */

import { randomUUID } from "node:crypto";
import {
  Agent,
  convertToLlm,
  createCompactionSummaryMessage,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  addUsage,
  cumulativeDelta,
  subagentCanMutate,
  subagentToolsLabel,
  type AgentEventEnvelope,
  type MessageUsage,
  type SubagentDefinition,
  type SubagentRunStatus as SharedSubagentRunStatus,
  type SubagentThinkingLevel,
  type UiMessage,
  type SubagentCollaborationSnapshot,
  type SubagentGuideReceipt,
} from "@pi-desktop/shared";
import { SubagentObserver, type SubagentObservation } from "./subagent-observer.js";
import {
  SUBAGENT_CHECKPOINT_FORMAT_VERSION,
  SUBAGENT_CONTEXT_CODEC_VERSION,
  computeToolsFingerprint,
  decodeAgentMessages,
  encodeAgentMessages,
  sanitizeBaseUrl,
  simplePromptFingerprint,
  SubagentCodecError,
  validateCheckpoint,
  type SubagentCheckpoint,
} from "./subagent-checkpoint.js";
import { classifyAgentError } from "./agent-errors.js";
import {
  assistantContent,
  nowIso,
  usageFromPi,
} from "./agent-messages.js";
import {
  apiBindingForStyle,
  buildProviderModel,
  createProviderModels,
  DEFAULT_CONTEXT_WINDOW,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { resolveCompactionProvider } from "./compaction-model.js";
import {
  compactionSummaryWouldExceedBudget,
  compactionThinkingLevel,
  computeContextBudget,
  estimatePromptOverheadTokens,
  fileOpsFromMessages,
  generateCompactionSummary,
  prepareLinearCheckpointPreparation,
  retainedUserMessageBudget,
  shapeCheckpointPreparation,
  stripCompactionFallbackNotice,
  subagentRetentionCandidates,
  type ContextBudget,
} from "./context-compaction.js";
import { clampThinkingLevel } from "./thinking-level.js";
import {
  subagentModelBinding,
  type SubagentProviderRetryState,
} from "./subagent-model-binding.js";
import {
  classifyProviderError,
  delayWithAbort,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  isTransientProviderRetryCode,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from "./provider-retry.js";

export const SUBAGENT_TOOL_NAME = "Task";
/** Converge on running delegations and read their reports (ADR 0089). */
export const SUBAGENT_WAIT_TOOL_NAME = "TaskWait";
/** Report on the session's delegations without waiting (ADR 0089). */
export const SUBAGENT_LIST_TOOL_NAME = "TaskList";
/** Stop running delegations (ADR 0089). */
export const SUBAGENT_STOP_TOOL_NAME = "TaskStop";
export const SUBAGENT_GUIDE_TOOL_NAME = "TaskGuide";
export const SUBAGENT_INSPECT_TOOL_NAME = "TaskInspect";
export const SUBAGENT_RESUME_TOOL_NAME = "TaskResume";

/** Bound the final report; periodic reports have their own bounded snapshots. */
export const MAX_SUBAGENT_REPORT_CHARS = 12_000;

export type SubagentRunStatus = SharedSubagentRunStatus;

export type SubagentRunResult = {
  agentName: string;
  /** Provider/model used by this run after delegation resolution. */
  modelId: string;
  /** Thinking selection passed to the delegate after inheritance/clamping. */
  thinkingLevel: SubagentThinkingLevel;
  status: SubagentRunStatus;
  /** Text handed back to the parent model. */
  report: string;
  /** Provider requests the delegate spent. */
  turns: number;
  toolCalls: number;
  /** In-memory context checkpoints this delegate's run spent. */
  contextCompactions?: number;
  usage?: MessageUsage;
  /** 本轮新增用量；usage 保留整个子任务累计值。 */
  executionUsage?: MessageUsage;
  modelFailures?: Array<{ model: string; code: string; message: string }>;
  error?: { code: string; message: string };
};

export type SubagentToolOutcome = {
  isError?: boolean;
  terminate?: boolean;
};

export type SubagentRunOptions = {
  definition: SubagentDefinition;
  sessionId: string;
  /** Parent durable turn; child rows are attributed to the same turn. */
  turnId?: string;
  /** `Task` call that owns this delegate. */
  parentToolCallId: string;
  /** The delegated instruction, written by the parent model. */
  task: string;
  /** Provider resolved by Electron main (the definition's pin, or the
   * session's provider when the definition pins nothing). */
  provider: RuntimeProviderConfig;
  thinkingLevel: SubagentThinkingLevel;
  /** User-owned definition pins only, in configured order. Missing bindings fail visibly. */
  fallbackModels?: Array<{ key: string; provider?: RuntimeProviderConfig }>;
  /** Original parent thinking selection, before primary-model clamping. */
  inheritedThinkingLevel?: SubagentThinkingLevel;
  onModelChange?: (provider: RuntimeProviderConfig, thinkingLevel: SubagentThinkingLevel) => void;
  /** Fully composed child system prompt (see `composeSubagentSystemPrompt`). */
  systemPrompt: string;
  /** Host-backed tools, built by the session runtime so a delegate's calls
   * take the exact same path as the parent's. */
  tools: AgentTool[];
  onEvent: (envelope: AgentEventEnvelope) => void;
  /**
   * Result of the parent's own `afterToolCall` bookkeeping for one call, so a
   * host failure reaches the delegate's tool-error channel the same way it
   * reaches the parent's.
   */
  resolveToolOutcome?: (
    context: AfterToolCallContext,
  ) => SubagentToolOutcome | undefined;
  signal?: AbortSignal;
  delegationId?: string;
  reportIntervalSteps?: number;
  onObservation?: (event: SubagentObservation) => void;
  /**
   * Summary model inherited from the parent. It is used only when it is
   * available and at least as wide as the delegate's own model, so a delegate
   * never sends its history to a summary model that cannot hold it.
   */
  compactionProvider?: RuntimeProviderConfig;
  /** The session's automatic-compaction setting; false disables checkpoints. */
  compactionEnabled?: boolean;
  /**
   * Internal checkpoint payload supplied when restoring from persistent snapshot.
   * Direct message and observer state restoration without model execution.
   */
  restoredCheckpoint?: SubagentCheckpoint;
  /** Primary model before fallback was applied, for faithful persistence restore */
  primaryProvider?: RuntimeProviderConfig;
};

export type SubagentRestoreOptions = Omit<SubagentRunOptions, "task" | "delegationId"> & {
  delegationId?: string;
};

/**
 * Compose the delegate's system prompt.
 *
 * The session runtime owns the shared parts (shell dialect, scratch
 * directory, project instruction chain) because it is the only place that
 * knows them; this function only decides the framing and the ordering, with
 * the definition body ahead of the workspace guidance so a project's own
 * instructions still have the last word.
 */
export function composeSubagentSystemPrompt(options: {
  definition: SubagentDefinition;
  /** Guidance blocks inherited from the session (shell, scratch, rules). */
  guidance?: string[];
  /** Spawn-time tool names after inherit resolution. */
  toolNames?: readonly string[];
}): string {
  const { definition } = options;
  const resolved = options.toolNames;
  const toolList =
    resolved && resolved.length > 0
      ? resolved.join(", ")
      : subagentToolsLabel(definition);
  const framing = [
    `You are the \"${definition.name}\" subagent inside PI-Desktop, working on one task delegated by the main agent.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    subagentCanMutate(definition, resolved)
      ? "You may change files, but only the ones the task is about; leave everything else untouched."
      : "You have no tools that change files or run commands, so never report an edit you could not have made.",
    "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.",
  ].join("\n");
  return [framing, definition.prompt, ...(options.guidance ?? [])]
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

function boundedReport(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_SUBAGENT_REPORT_CHARS) return text;
  const marker = "\n\n[subagent report truncated]\n\n";
  const available = MAX_SUBAGENT_REPORT_CHARS - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

export { addUsage };

/**
 * Prefix on the in-memory summary message. A delegate that is never told its
 * history was checkpointed re-reads its own summary as fresh work and repeats
 * completed steps.
 */
const SUBAGENT_CHECKPOINT_NOTICE =
  "[delegate context checkpoint: earlier work was summarized below. Continue the delegated task from here; do not redo completed steps.]";
const SUBAGENT_CHECKPOINT_FAILURE_MESSAGE =
  "The delegate context could not be reduced below its model's safe budget, so it was not sent.";

/** 同一内存上下文可执行多轮；正常完成才可被父 Agent 显式召回。 */
export class SubagentRun {
  readonly observation: SubagentObserver;
  private readonly agent: Agent;
  private readonly opts: SubagentRunOptions;
  private currentAssistant?: UiMessage;
  private lastReportText = "";
  private turns = 0;
  private toolCalls = 0;
  private usage?: MessageUsage;
  private executionUsage?: MessageUsage;
  private executing = false;
  private lastStatus?: SubagentRunStatus;
  private streamError?: { code: string; message: string };
  private pendingProviderRetry?: ReturnType<typeof classifyAgentError>;
  private providerRetryInProgress = false;
  private providerTransientRetryAttempt = 0;
  private providerRateLimitRetryAttempt = 0;
  private provider: RuntimeProviderConfig;
  private thinkingLevel: SubagentThinkingLevel;
  private fallbackIndex = 0;
  private readonly primaryProvider: RuntimeProviderConfig;
  private readonly attemptedModels = new Set<string>();
  private readonly modelFailures: NonNullable<SubagentRunResult["modelFailures"]> = [];
  private readonly retryState: SubagentProviderRetryState = {
    claim: (error, phase) => this.claimProviderRetry(error, phase),
  };
  private readonly runAbortController = new AbortController();
  /**
   * In-memory checkpoint state. A delegate is never persisted: the parent's
   * transcript already holds every child row, so the only thing that has to
   * survive its own compaction is the summary its later requests are built from.
   */
  private checkpointSummary?: string;
  private checkpointTokensBefore = 0;
  /** The summary message currently at the head of the in-memory transcript. */
  private summaryMessage?: AgentMessage;
  private contextCompactions = 0;
  /** One overflow-driven checkpoint retry per execution, as in the session. */
  private overflowCompactionAttempted = false;
  private pendingOverflowCompaction = false;
  /** Set when the context could not be reduced: the run fails visibly. */
  private contextFailure?: { code: string; message: string };

  constructor(opts: SubagentRunOptions) {
    this.opts = opts;
    this.primaryProvider = opts.primaryProvider ?? opts.provider;
    const secrets = [opts.provider, ...(opts.fallbackModels ?? []).flatMap((entry) => entry.provider ? [entry.provider] : [])]
      .flatMap((provider) => [provider.apiKey ?? "", ...Object.entries(provider.headers ?? {}).filter(([key]) => /authorization|key|token|cookie/i.test(key)).map(([, value]) => String(value))]);

    if (opts.restoredCheckpoint) {
      this.observation = SubagentObserver.restore(
        opts.delegationId ?? opts.parentToolCallId,
        opts.restoredCheckpoint.observer,
        (event) => opts.onObservation?.(event),
        secrets,
      );
    } else {
      this.observation = new SubagentObserver(
        opts.delegationId ?? opts.parentToolCallId,
        opts.definition.reportIntervalSteps ?? opts.reportIntervalSteps!,
        opts.definition.reportIntervalSteps === undefined ? "dispatch" : "definition",
        (event) => opts.onObservation?.(event),
        secrets,
      );
    }
    this.provider = opts.provider;
    this.thinkingLevel = opts.thinkingLevel;
    let initialMessages: AgentMessage[] = [];

    if (opts.restoredCheckpoint) {
      const cp = opts.restoredCheckpoint;
      initialMessages = decodeAgentMessages(cp.messages);
      const summaryIdx = cp.compaction.summaryMessageIndex;
      if (summaryIdx !== undefined && initialMessages[summaryIdx]) {
        this.summaryMessage = initialMessages[summaryIdx];
      } else if (initialMessages[0]?.role === "compactionSummary") {
        this.summaryMessage = initialMessages[0];
      }
      this.checkpointSummary = cp.compaction.checkpointSummary;
      this.checkpointTokensBefore = cp.compaction.checkpointTokensBefore;
      this.contextCompactions = cp.compaction.contextCompactions;
      this.turns = cp.usage.turns;
      this.toolCalls = cp.usage.toolCalls;
      this.usage = cp.usage.usage ? { ...cp.usage.usage } : undefined;
      this.executionUsage = cp.usage.executionUsage ? { ...cp.usage.executionUsage } : undefined;
      this.lastReportText = cp.usage.lastReportText;
      this.lastStatus = "completed";
      this.executing = false;
      this.thinkingLevel = cp.modelBinding.thinkingLevel;
      this.fallbackIndex = cp.modelBinding.fallbackIndex;
      for (const m of cp.modelBinding.attemptedModels) {
        this.attemptedModels.add(m);
      }
      this.modelFailures.push(...cp.modelBinding.modelFailures);
    } else {
      this.attemptedModels.add(`${opts.provider.id}/${opts.provider.modelId}`);
    }

    const binding = this.modelBinding();
    this.agent = new Agent({
      streamFn: binding.streamFn,
      getApiKey: binding.getApiKey,
      convertToLlm,
      // Covers prompt, resume, guidance, retries and fallback-model requests.
      transformContext: (messages, signal) => this.prepareRequestContext(messages, signal),
      afterToolCall: async (context) => this.afterToolCall(context),
      beforeToolCall: async (context) => this.beforeToolCall(context),
      // 引导不再结束本轮：TaskGuide 立即 steer 进当前轮，文本在下一个安全点注入子上下文，
      // 本轮尚未开始的旧工具由 beforeToolCall 跳过。
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: binding.model,
        tools: opts.tools,
        thinkingLevel: binding.agentThinkingLevel,
        messages: initialMessages,
      },
      toolExecution: "sequential",
      // 同一安全点的多批指导一次注入，避免第二批又等一个轮次边界。
      steeringMode: "all",
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  get canResume(): boolean {
    return !this.executing && this.lastStatus === "completed" && !this.runSignal().aborted;
  }

  run(): Promise<SubagentRunResult> {
    if (this.executing || this.lastStatus) throw new Error("Subagent already started; use resume after normal completion.");
    this.executing = true;
    return this.execute(this.opts.task);
  }

  resume(instruction: string, turnId: string | undefined, parentToolCallId: string): Promise<SubagentRunResult> {
    if (!this.canResume) throw new Error("Subagent is busy, stopped, failed, or its context was released.");
    if (!instruction.trim() || instruction.length > 12_000) throw new Error("instruction must contain 1–12000 characters.");
    this.executing = true;
    this.opts.turnId = turnId;
    this.opts.parentToolCallId = parentToolCallId;
    this.executionUsage = undefined;
    this.lastReportText = "";
    this.streamError = undefined;
    this.pendingProviderRetry = undefined;
    this.providerTransientRetryAttempt = 0;
    this.providerRateLimitRetryAttempt = 0;
    this.observation.resume();
    return this.execute(instruction);
  }

  /** Restore an idle SubagentRun from a validated persistent checkpoint. */
  static restore(snapshot: SubagentCheckpoint, opts: SubagentRestoreOptions): SubagentRun {
    const validated = validateCheckpoint(snapshot);

    if (opts.sessionId !== validated.header.sessionId) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        `Session mismatch: expected '${validated.header.sessionId}', got '${opts.sessionId}'`,
      );
    }

    if (
      opts.definition.name !== validated.config.definition.name ||
      opts.definition.description !== validated.config.definition.description ||
      opts.definition.prompt !== validated.config.definition.prompt ||
      opts.definition.permission !== validated.config.definition.permission
    ) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        `Subagent definition configuration mismatch for '${validated.config.definition.name}'`,
      );
    }

    const currentCanMutate = subagentCanMutate(opts.definition, opts.tools.map((t) => t.name));
    if (currentCanMutate !== validated.config.permissions.subagentCanMutate) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        "Subagent mutation permission mismatch with checkpoint",
      );
    }

    // Verify primary model configuration matches checkpoint
    if (
      opts.provider.id !== validated.modelBinding.primaryModel.id ||
      opts.provider.modelId !== validated.modelBinding.primaryModel.modelId
    ) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        `Primary model (${opts.provider.id}/${opts.provider.modelId}) does not match checkpoint primary model (${validated.modelBinding.primaryModel.id}/${validated.modelBinding.primaryModel.modelId})`,
      );
    }
    const primaryEndpointFp = simplePromptFingerprint(sanitizeBaseUrl(opts.provider.baseUrl ?? ""));
    if (primaryEndpointFp !== validated.modelBinding.primaryModel.endpointFingerprint) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        "Primary model endpoint fingerprint mismatch with checkpoint",
      );
    }
    const primaryWireApi = apiBindingForStyle(opts.provider.apiStyle).api;
    if (primaryWireApi !== validated.modelBinding.primaryModel.api) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        `Primary model wire API mismatch: expected '${validated.modelBinding.primaryModel.api}', got '${primaryWireApi}'`,
      );
    }

    const currentPromptFingerprint = simplePromptFingerprint(opts.systemPrompt);
    if (currentPromptFingerprint !== validated.config.systemPromptFingerprint) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        "System prompt fingerprint mismatch with persistent checkpoint",
      );
    }

    const currentToolsFingerprint = computeToolsFingerprint(opts.tools);
    if (currentToolsFingerprint !== validated.config.toolsFingerprint) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        "Tools schema fingerprint mismatch with persistent checkpoint",
      );
    }

    let resolvedActiveProvider: RuntimeProviderConfig;
    if (validated.modelBinding.fallbackIndex > 0) {
      const fallbackEntry = opts.fallbackModels?.[validated.modelBinding.fallbackIndex - 1];
      if (!fallbackEntry?.provider) {
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
          `Active fallback model at index ${validated.modelBinding.fallbackIndex - 1} is not configured in restore options`,
        );
      }
      if (
        fallbackEntry.provider.id !== validated.modelBinding.provider.id ||
        fallbackEntry.provider.modelId !== validated.modelBinding.provider.modelId
      ) {
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
          `Active fallback model (${fallbackEntry.provider.id}/${fallbackEntry.provider.modelId}) does not match checkpoint completed model (${validated.modelBinding.provider.id}/${validated.modelBinding.provider.modelId})`,
        );
      }
      resolvedActiveProvider = fallbackEntry.provider;
    } else {
      if (
        opts.provider.id !== validated.modelBinding.provider.id ||
        opts.provider.modelId !== validated.modelBinding.provider.modelId
      ) {
        throw new SubagentCodecError(
          "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
          `Primary provider (${opts.provider.id}/${opts.provider.modelId}) does not match checkpoint completed model (${validated.modelBinding.provider.id}/${validated.modelBinding.provider.modelId})`,
        );
      }
      resolvedActiveProvider = opts.provider;
    }

    const endpointFp = simplePromptFingerprint(sanitizeBaseUrl(resolvedActiveProvider.baseUrl ?? ""));
    if (endpointFp !== validated.modelBinding.provider.endpointFingerprint) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        "Active provider endpoint fingerprint mismatch with persistent checkpoint",
      );
    }

    const wireApi = apiBindingForStyle(resolvedActiveProvider.apiStyle).api;
    if (wireApi !== validated.modelBinding.provider.api) {
      throw new SubagentCodecError(
        "SUBAGENT_CODEC_COMPATIBILITY_FAILED",
        `Active provider wire API '${wireApi}' does not match checkpoint api '${validated.modelBinding.provider.api}'`,
      );
    }

    return new SubagentRun({
      ...opts,
      provider: resolvedActiveProvider,
      primaryProvider: opts.provider,
      task: validated.config.task,
      delegationId: validated.header.delegationId,
      restoredCheckpoint: validated,
    });
  }

  /** Export current idle and completed state to an immutable checkpoint snapshot. */
  exportSnapshot(options: {
    projectRealPath: string;
    executionId: string;
    generation: number;
    appVersion?: string;
  }): SubagentCheckpoint {
    if (this.executing || this.lastStatus !== "completed") {
      throw new Error("Cannot export snapshot: subagent must be idle and completed.");
    }
    if (this.runSignal().aborted) {
      throw new Error("Cannot export snapshot: subagent execution was aborted.");
    }
    if (this.observation.hasGuides) {
      throw new Error("Cannot export snapshot: subagent has pending unapplied guides.");
    }
    if (this.pendingProviderRetry) {
      throw new Error("Cannot export snapshot: subagent has pending provider retries.");
    }

    const validBindings: Array<{ providerId: string; modelId: string; api?: string }> = [
      {
        providerId: this.primaryProvider.id,
        modelId: this.primaryProvider.modelId,
        api: apiBindingForStyle(this.primaryProvider.apiStyle).api,
      },
      {
        providerId: this.provider.id,
        modelId: this.provider.modelId,
        api: apiBindingForStyle(this.provider.apiStyle).api,
      },
      ...(this.opts.fallbackModels ?? []).filter((f) => f.provider).map((f) => ({
        providerId: f.provider!.id,
        modelId: f.provider!.modelId,
        api: apiBindingForStyle(f.provider!.apiStyle).api,
      })),
    ];

    const encodedMessages = encodeAgentMessages(this.agent.state.messages, validBindings);
    const summaryIndex = this.summaryMessage
      ? this.agent.state.messages.indexOf(this.summaryMessage)
      : undefined;

    const delegationId = this.opts.delegationId ?? this.opts.parentToolCallId;
    const observerSnapshot = this.observation.exportState();
    const firstStepStart = observerSnapshot.steps[0]?.startedAt;
    const lastStepEnd = observerSnapshot.steps.at(-1)?.endedAt ?? Date.now();
    const activityDurationMs = (firstStepStart && lastStepEnd >= firstStepStart)
      ? (lastStepEnd - firstStepStart)
      : 0;

    const checkpoint: SubagentCheckpoint = {
      header: {
        formatVersion: SUBAGENT_CHECKPOINT_FORMAT_VERSION,
        contextCodecVersion: SUBAGENT_CONTEXT_CODEC_VERSION,
        sessionId: this.opts.sessionId,
        delegationId,
        projectRealPath: options.projectRealPath,
        createdAt: this.agent.state.messages[0]?.timestamp ?? Date.now(),
        savedAt: Date.now(),
        appVersion: options.appVersion,
      },
      execution: {
        execution: this.observation.snapshot().execution ?? 1,
        executionId: options.executionId,
        generation: options.generation,
        lastStatus: "completed",
        parentTurnId: this.opts.turnId,
        parentToolCallId: this.opts.parentToolCallId,
      },
      compaction: {
        checkpointSummary: this.checkpointSummary,
        checkpointTokensBefore: this.checkpointTokensBefore,
        contextCompactions: this.contextCompactions,
        summaryMessageIndex: summaryIndex !== undefined && summaryIndex >= 0 ? summaryIndex : undefined,
      },
      modelBinding: {
        provider: {
          id: this.provider.id,
          name: this.provider.name,
          baseUrl: sanitizeBaseUrl(this.provider.baseUrl ?? ""),
          modelId: this.provider.modelId,
          api: apiBindingForStyle(this.provider.apiStyle).api,
          apiStyle: this.provider.apiStyle,
          authKind: this.provider.authKind ?? "",
          supportsReasoning: this.provider.supportsReasoning,
          supportedThinkingLevels: this.provider.supportedThinkingLevels,
          endpointFingerprint: simplePromptFingerprint(sanitizeBaseUrl(this.provider.baseUrl ?? "")),
        },
        primaryModel: {
          id: this.primaryProvider.id,
          modelId: this.primaryProvider.modelId,
          api: apiBindingForStyle(this.primaryProvider.apiStyle).api,
          endpointFingerprint: simplePromptFingerprint(sanitizeBaseUrl(this.primaryProvider.baseUrl ?? "")),
        },
        thinkingLevel: this.thinkingLevel,
        fallbackIndex: this.fallbackIndex,
        attemptedModels: Array.from(this.attemptedModels),
        modelFailures: [...this.modelFailures],
        fallbackModels: this.opts.fallbackModels?.map((f) => ({
          key: f.key,
          provider: f.provider
            ? {
                id: f.provider.id,
                name: f.provider.name,
                baseUrl: sanitizeBaseUrl(f.provider.baseUrl ?? ""),
                modelId: f.provider.modelId,
                api: apiBindingForStyle(f.provider.apiStyle).api,
                authKind: f.provider.authKind,
                endpointFingerprint: simplePromptFingerprint(sanitizeBaseUrl(f.provider.baseUrl ?? "")),
              }
            : undefined,
        })),
      },
      config: {
        task: this.opts.task,
        definition: { ...this.opts.definition },
        systemPrompt: this.opts.systemPrompt,
        systemPromptFingerprint: simplePromptFingerprint(this.opts.systemPrompt),
        toolNames: this.opts.tools.map((t) => t.name),
        toolsFingerprint: computeToolsFingerprint(this.opts.tools),
        permissions: {
          subagentCanMutate: subagentCanMutate(this.opts.definition, this.opts.tools.map((t) => t.name)),
        },
      },
      usage: {
        turns: this.turns,
        toolCalls: this.toolCalls,
        usage: this.usage ? { ...this.usage } : undefined,
        executionUsage: this.executionUsage ? { ...this.executionUsage } : undefined,
        lastReportText: this.lastReportText,
        activityDurationMs,
      },
      observer: observerSnapshot,
      messages: encodedMessages,
    };

    return validateCheckpoint(checkpoint);
  }

  private async execute(instruction: string): Promise<SubagentRunResult> {
    const signal = this.runSignal();
    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted before it started.");
    }
    // Recovery state is per execution: a `TaskResume` re-budgets the context and
    // gets its own single overflow attempt, exactly like a new session prompt.
    this.overflowCompactionAttempted = false;
    this.pendingOverflowCompaction = false;
    this.contextFailure = undefined;
    const onAbort = () => {
      this.observation.stop("session");
      // 停止优先：未注入的指导不再进入子上下文（回执已由 observation.stop 作废）。
      this.agent.clearSteeringQueue();
      this.runAbortController.abort();
      this.agent.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let caughtError: ReturnType<typeof classifyAgentError> | undefined;
    try {
      await this.agent.prompt(instruction);
      await this.agent.waitForIdle();
      while (!signal?.aborted) {
        if (this.pendingProviderRetry) {
          await this.retryPendingProviderFailure();
        } else if (this.contextFailure) {
          // Raised by the next-request hook; reported below.
          break;
        } else if (this.pendingOverflowCompaction) {
          this.pendingOverflowCompaction = false;
          const outcome = await this.checkpointAfterOverflow(signal);
          if (outcome === "aborted") {
            return this.result("aborted", "The delegated task was aborted.");
          }
          if (outcome === "compacted") {
            await this.agent.continue();
            await this.agent.waitForIdle();
          }
        } else if (this.streamError && this.useNextModel()) {
          await this.agent.continue();
          await this.agent.waitForIdle();
        } else if (!this.streamError && this.observation.hasGuides) {
          // 兜底路径：指导在本轮循环的空档（最后一次 steering 轮询之后）到达。
          // 仍然只走 steer + continue，绝不重发 prompt，也不重放工具结果。
          this.steerAcceptedGuides();
          if (signal.aborted || !this.agent.hasQueuedMessages()) {
            // 队列已空且无法再送达：明确作废，不空转、不谎报已应用。
            this.observation.cancelUndeliverableGuides("The guidance could not be delivered to the subagent's context.");
            break;
          }
          await this.agent.continue();
          await this.agent.waitForIdle();
        } else {
          break;
        }
      }
    } catch (error) {
      caughtError = classifyAgentError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.finalizeCurrentAssistant();
    }

    if (signal?.aborted) {
      return this.result("aborted", "The delegated task was aborted.");
    }
    if (this.contextFailure) {
      return this.result("failed", "", this.contextFailure);
    }
    if (caughtError) {
      if (caughtError.code === "TURN_ABORTED") {
        return this.result("aborted", "The delegated task was aborted.");
      }
      return this.result("failed", "", {
        code: caughtError.code,
        message: caughtError.message,
      });
    }
    if (this.streamError) {
      return this.result("failed", "", this.streamError);
    }
    if (!this.lastReportText.trim()) {
      return this.result("failed", "", {
        code: "SUBAGENT_NO_REPORT",
        message: "The subagent finished without writing a report.",
      });
    }
    return this.result("completed", this.lastReportText);
  }

  private modelBinding() {
    return subagentModelBinding({
      provider: this.provider,
      thinkingLevel: this.thinkingLevel,
      sessionId: this.opts.sessionId,
      maxTokens: this.opts.definition.maxTokens,
    }, this.retryState);
  }

  /** The session's automatic-compaction setting gates the delegate's checkpoints. */
  private get compactionEnabled(): boolean {
    return this.opts.compactionEnabled !== false;
  }

  private modelContextWindow(): number {
    return this.agent.state.model.contextWindow || DEFAULT_CONTEXT_WINDOW;
  }

  /** System prompt and tool schemas every request pays for before any message. */
  private promptOverheadTokens(): number {
    return estimatePromptOverheadTokens(this.opts.systemPrompt, this.opts.tools);
  }

  /**
   * The delegate's own budget: its bound model's window and output cap, plus
   * the prompt and tool overhead the transcript itself never accounts for.
   */
  private contextBudget(messages: readonly AgentMessage[]): ContextBudget {
    return computeContextBudget({
      messages,
      contextWindow: this.agent.state.model.contextWindow,
      maxTokens: this.agent.state.model.maxTokens,
      promptOverheadTokens: this.promptOverheadTokens(),
    });
  }

  /**
   * The summary binding for the delegate's current model. Re-resolved on every
   * checkpoint, so a fallback switch re-budgets against the model actually
   * bound. The parent's summary provider is used only when it is available and
   * at least as wide as the delegate's own model (`compaction-model.ts`).
   */
  private compactionBinding() {
    const provider =
      (this.opts.compactionProvider
        ? resolveCompactionProvider(this.provider, this.opts.compactionProvider)
        : undefined) ?? this.provider;
    const model = buildProviderModel(provider);
    return {
      provider,
      model,
      models: createProviderModels(provider, model),
      thinkingLevel: compactionThinkingLevel(provider, this.thinkingLevel),
    };
  }


  /**
   * Compact when the next provider request would cross the delegate's safe
   * budget. `false` means the context could not be reduced, and the caller must
   * fail loudly instead of issuing the request.
   */
  private async ensureContextFits(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (!this.compactionEnabled) return true;
    const budget = this.contextBudget(this.agent.state.messages);
    if (budget.tokens < budget.hardLimit) return true;
    if (this.promptOverheadTokens() >= budget.hardLimit) {
      this.contextFailure = {
        code: "CONTEXT_COMPACTION_FAILED",
        message: "The delegate's system prompt and tools exceed its context budget; history compaction cannot make this request fit.",
      };
      return false;
    }
    return await this.checkpointContext(signal) === "compacted";
  }

  /** Transform runs after the pending prompt is appended, before every request. */
  private async prepareRequestContext(
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const requestSignal = signal ?? this.runSignal();
    const throwIfAborted = () => {
      if (!requestSignal.aborted && !this.runSignal().aborted) return;
      const error = new Error("The delegated task was aborted during context preparation.");
      error.name = "AbortError";
      throw error;
    };
    throwIfAborted();
    this.agent.state.messages = [...messages];
    if (!(await this.ensureContextFits(requestSignal))) {
      throwIfAborted();
      this.contextFailure ??= { code: "CONTEXT_COMPACTION_FAILED", message: SUBAGENT_CHECKPOINT_FAILURE_MESSAGE };
      throw new Error(`CONTEXT_COMPACTION_FAILED: ${this.contextFailure.message}`);
    }
    throwIfAborted();
    // The core's transform only changes the outbound view. Mutate the loop's
    // array too so its next request cannot resurrect pre-checkpoint history.
    const prepared = this.agent.state.messages;
    messages.splice(0, messages.length, ...prepared);
    return messages;
  }

  /**
   * One overflow recovery per execution, like the session runtime: checkpoint
   * this delegate's context and continue the same model at the failed request.
   * A second overflow follows the ordinary fallback/failure path, so no model
   * is asked to retry an oversized request forever.
   */
  private async checkpointAfterOverflow(
    signal: AbortSignal,
  ): Promise<"compacted" | "unavailable" | "aborted"> {
    if (signal.aborted) return "aborted";
    // The rejected request's own assistant row must not enter the transcript the
    // checkpoint is built from, and `continue()` needs it gone.
    const transcript = [...this.agent.state.messages];
    const messages = [...transcript];
    if (messages.at(-1)?.role === "assistant") messages.pop();
    this.agent.state.messages = messages;
    const outcome = await this.checkpointContext(signal);
    if (outcome === "aborted") return "aborted";
    if (outcome === "compacted") return "compacted";
    // Nothing could be reduced: hand the request to the ordinary failure path,
    // which may still find a wider fallback model, and fail visibly if it does
    // not. The rejected row is restored because that path decides what to drop,
    // and no request is issued while it is still in place.
    this.agent.state.messages = transcript;
    this.contextFailure = undefined;
    this.streamError ??= {
      code: "CONTEXT_TOO_LARGE",
      message:
        "The provider rejected an oversized model context and it could not be reduced.",
    };
    return "unavailable";
  }

  /**
   * Checkpoint the delegate's own context in memory.
   *
   * The summary covers everything older than the boundary and the retained tail
   * carries the delegated brief plus the newest instruction, so the task, later
   * guidance, completed changes and remaining work all survive the boundary. An
   * existing summary is updated rather than replaced, the same way the session
   * runtime accumulates one across checkpoints.
   *
   * Nothing here is persisted: the parent's transcript already holds every child
   * row, and the delegate is never resumed from disk.
   */
  private async checkpointContext(
    signal: AbortSignal,
  ): Promise<"compacted" | "failed" | "aborted"> {
    if (signal.aborted) return "aborted";
    const messages = this.agent.state.messages;
    const source = messages.filter((message) => message !== this.summaryMessage);
    if (source.length === 0) {
      this.contextFailure = { code: "CONTEXT_COMPACTION_FAILED", message: "No new history can be summarized to reduce the delegate context." };
      return "failed";
    }
    const budget = this.contextBudget(messages);
    const binding = this.compactionBinding();
    // Keep the real carried-forward summary and drop any recovery notice, so a
    // chained checkpoint updates the history it has instead of cementing a
    // failure notice that never was a summary.
    const previousSummary = stripCompactionFallbackNotice(this.checkpointSummary);
    const preparation = shapeCheckpointPreparation(
      prepareLinearCheckpointPreparation({
        messages: source,
        ...(previousSummary ? { previousSummary } : {}),
        fileOps: fileOpsFromMessages(source),
        budget,
      }),
      {
        retentionCandidates: subagentRetentionCandidates(source),
        retainedUserTokens: retainedUserMessageBudget(budget),
      },
    );

    let summary: string | undefined;
    // Do not send a summary request that cannot fit its model's window.
    // Failure retains the original transcript rather than omitting work.
    if (!compactionSummaryWouldExceedBudget(preparation, budget, binding.model)) {
      const result = await generateCompactionSummary({
        preparation,
        provider: binding.provider,
        models: binding.models,
        model: binding.model,
        sessionId: this.opts.sessionId,
        ...(binding.thinkingLevel ? { thinkingLevel: binding.thinkingLevel } : {}),
        signal,
        // An empty or output-truncated summary would replace the delegate's
        // whole history with nothing; keep the context and recover instead.
        requireCompleteSummary: true,
      });
      if (signal.aborted) return "aborted";
      if (result.ok) summary = result.value.summary;
    }

    if (summary === undefined) {
      this.contextFailure = {
        code: "CONTEXT_COMPACTION_FAILED",
        message: "A complete context summary could not be generated within the model budget. Original history was retained; no work was replayed.",
      };
      return "failed";
    }

    if (!this.installCheckpoint(summary, preparation.retainedTail, budget)) {
      this.contextFailure = {
        code: "CONTEXT_COMPACTION_FAILED",
        message: SUBAGENT_CHECKPOINT_FAILURE_MESSAGE,
      };
      return "failed";
    }
    this.contextCompactions += 1;
    return "compacted";
  }

  /** Install atomically only when the complete summary and retained instructions fit. */
  private installCheckpoint(
    summary: string,
    retainedTail: readonly AgentMessage[],
    budget: ContextBudget,
  ): boolean {
    const message = createCompactionSummaryMessage(
      `${SUBAGENT_CHECKPOINT_NOTICE}\n\n${summary}`,
      budget.tokens,
      Date.now(),
    );
    const messages: AgentMessage[] = [message, ...retainedTail];
    if (this.contextBudget(messages).tokens >= budget.hardLimit) return false;
    this.summaryMessage = message;
    this.checkpointSummary = summary;
    this.checkpointTokensBefore = budget.tokens;
    this.agent.state.messages = messages;
    return true;
  }

  private useNextModel(): boolean {
    if (this.runSignal().aborted || !this.streamError || this.streamError.code === "TURN_ABORTED") return false;
    if (!this.opts.fallbackModels?.length) return false;
    const failed = this.agent.state.messages.at(-1);
    // Only a provider's terminal assistant error permits fallback. Host/tool
    // failures, cancellation, and unexpected internal exceptions do not.
    if (failed?.role !== "assistant" || failed.stopReason !== "error") return false;
    this.recordModelFailure(`${this.provider.id}/${this.provider.modelId}`, this.streamError);
    while (this.fallbackIndex < this.opts.fallbackModels.length) {
      const next = this.opts.fallbackModels[this.fallbackIndex++];
      if (!next.provider) {
        this.recordModelFailure(next.key, {
          code: "MODEL_NOT_CONFIGURED",
          message: "The configured fallback model could not be resolved.",
        });
        continue;
      }
      const identity = `${next.provider.id}/${next.provider.modelId}`;
      if (this.attemptedModels.has(identity)) continue;
      this.attemptedModels.add(identity);
      this.provider = next.provider;
      const requested = this.opts.definition.thinkingLevel ?? this.opts.inheritedThinkingLevel ?? this.opts.thinkingLevel;
      this.thinkingLevel = requested === "omit" ? "omit" : clampThinkingLevel(this.provider, requested);
      const binding = this.modelBinding();
      this.agent.state.model = binding.model;
      this.agent.state.thinkingLevel = binding.agentThinkingLevel;
      this.agent.streamFunction = binding.streamFn;
      this.agent.getApiKey = binding.getApiKey;
      this.agent.state.messages = this.agent.state.messages.slice(0, -1);
      this.streamError = undefined;
      this.providerTransientRetryAttempt = 0;
      this.providerRateLimitRetryAttempt = 0;
      this.lastReportText = "";
      this.opts.onModelChange?.(this.provider, this.thinkingLevel);
      return !this.runSignal().aborted;
    }
    return false;
  }

  private recordModelFailure(model: string, error: { code: string; message: string }): void {
    this.modelFailures.push({ model, ...error });
    this.emit({
      type: "message_end",
      message: {
        ...this.newAssistantRow(),
        content: `Model ${model} failed (${error.code}): ${error.message}`,
        status: "error",
        isError: true,
      },
    });
  }

  private claimProviderRetry(
    error: ReturnType<typeof classifyAgentError>,
    phase: "request" | "stream",
  ): number | undefined {
    if (!error.retriable) return undefined;
    if (error.code === "PROVIDER_RATE_LIMITED") {
      if (this.providerRateLimitRetryAttempt >= PROVIDER_RATE_LIMIT_MAX_RETRIES) {
        return undefined;
      }
      return ++this.providerRateLimitRetryAttempt;
    }
    // Setup and stream failures share one bounded budget, exactly as the main
    // session does, so a delegate is not abandoned on a single gateway 502.
    void phase;
    if (!isTransientProviderRetryCode(error.code)) return undefined;
    if (this.providerTransientRetryAttempt >= PROVIDER_TRANSIENT_MAX_RETRIES) {
      return undefined;
    }
    return ++this.providerTransientRetryAttempt;
  }

  private async retryPendingProviderFailure(): Promise<void> {
    const retryError = this.pendingProviderRetry;
    if (!retryError) return;
    this.pendingProviderRetry = undefined;
    const messages = [...this.agent.state.messages];
    if (messages.at(-1)?.role !== "assistant") {
      throw new Error("Cannot retry a subagent provider stream without its failed assistant message");
    }
    messages.pop();
    this.agent.state.messages = messages;
    this.providerRetryInProgress = true;
    try {
      const delayMs =
        retryError.code === "PROVIDER_RATE_LIMITED"
          ? providerRateLimitDelayMs(
              this.providerRateLimitRetryAttempt,
              this.retryState.headers,
            )
          : providerSetupRetryDelayMs(
              this.providerTransientRetryAttempt,
              undefined,
              this.retryState.headers,
            );
      await delayWithAbort(delayMs, this.runSignal());
      if (this.opts.signal?.aborted) return;
      await this.agent.continue();
      await this.agent.waitForIdle();
    } finally {
      this.providerRetryInProgress = false;
    }
  }

  private result(
    status: SubagentRunStatus,
    report: string,
    error?: { code: string; message: string },
  ): SubagentRunResult {
    this.executing = false;
    this.lastStatus = status;
    // 本轮结束：队列里残留的未注入指导不得跨执行泄漏到下一次召回。
    this.agent.clearSteeringQueue();
    if (status === "aborted") this.observation.stop("session");
    this.observation.finish(status === "aborted" ? "stopped" : status === "completed" ? "completed" : "failed");
    const name = this.opts.definition.name;
    const body = report.trim();
    const text =
      status === "completed"
        ? body
        : status === "aborted"
          ? `The ${name} subagent was aborted after ${this.turns} turn(s). Completed actions were not rolled back.\n${this.observation.safe(this.lastReportText, 2000)}`
          : [
              `The ${name} subagent failed after ${this.turns} turn(s): ${error?.message ?? "unknown error"}.`,
              ...(body ? ["Its last output was:", body] : []),
            ].join("\n\n");
    return {
      agentName: name,
      modelId: this.provider.modelId,
      thinkingLevel: this.thinkingLevel,
      status,
      report: boundedReport([
        ...this.modelFailures.map((failure) => `Model ${failure.model} failed (${failure.code}): ${failure.message}`),
        // The parent has no other way to learn a delegate was checkpointed; one
        // line per run keeps it out of the progress stream.
        ...(this.contextCompactions > 0
          ? [
              `Context: the delegate's own context was checkpointed ${this.contextCompactions} time(s) in memory; earlier history was summarized and every tool record is still in the transcript.`,
            ]
          : []),
        text,
      ].join("\n\n")),
      turns: this.turns,
      toolCalls: this.toolCalls,
      ...(this.contextCompactions > 0
        ? { contextCompactions: this.contextCompactions }
        : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      executionUsage: this.executionUsage,
      ...(this.modelFailures.length ? { modelFailures: [...this.modelFailures] } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** Parent bookkeeping: host failures and a mutation-failure terminate. */
  private async afterToolCall(
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> {
    const parent = this.opts.resolveToolOutcome?.(context);
    const terminate = parent?.terminate === true;
    if (!parent?.isError && !terminate) return undefined;
    return {
      ...(parent?.isError ? { isError: true } : {}),
      ...(terminate ? { terminate: true } : {}),
    };
  }

  /**
   * TaskGuide 的入口。受理后立即把指导文本以 steer 排入子代理当前轮（与用户“立即发送”
   * 复用同一底层机制），不再等本轮结束后另发 prompt。返回的是本次命令的受理回执；
   * applying/applied/cancelled 的后续状态通过 observation 事件回执。
   */
  guide(instruction: string, interval?: number, commandId?: string): SubagentGuideReceipt {
    const receipt = this.observation.guide(instruction, interval, commandId);
    if (receipt.status !== "accepted") return receipt;
    if (this.executing) this.steerAcceptedGuides();
    return receipt;
  }

  /**
   * 把已受理的指导排入子代理当前轮：文本在下一个轮次边界注入模型上下文，
   * 正在运行的工具不被强杀，本轮剩余的旧工具由 beforeToolCall 跳过。
   * 未运行（尚未开始或已在空档）时保持 accepted，由运行循环兜底送达。
   */
  private steerAcceptedGuides(): boolean {
    if (this.observation.stopping || this.runSignal().aborted) return false;
    const text = this.observation.applyGuides();
    if (!text) return false;
    const message: AgentMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    this.observation.bindSteeredMessage(message);
    this.agent.steer(message);
    return true;
  }

  stop(source: NonNullable<SubagentCollaborationSnapshot["stopSource"]>): void {
    this.observation.stop(source);
    // 停止优先：已排队但未注入的指导不再进入子上下文。
    this.agent.clearSteeringQueue();
    this.runAbortController.abort();
    this.agent.abort();
  }

  private beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
    if (this.runSignal().aborted || this.observation.stopping) {
      return { block: true, reason: "SUBAGENT_STOPPED: not executed; do not retry." };
    }
    if (this.observation.hasGuides) {
      return { block: true, reason: "SUBAGENT_GUIDED: not executed because parent guidance is pending. Replan after the guidance; do not retry the old plan automatically." };
    }
    if (this.observation.begin(context.toolCall.id, context.toolCall.name, context.args)) this.toolCalls += 1;
    return undefined;
  }

  private emit(event: AgentEventEnvelope["event"]): void {
    this.opts.onEvent({
      sessionId: this.opts.sessionId,
      turnId: this.opts.turnId,
      ts: Date.now(),
      event,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    });
  }

  /**
   * Idle and duration watchdogs are withdrawn (D328). Stopping a delegate is
   * the parent agent's `TaskStop` or the user's Stop, not a timer, so the
   * only abort sources are the parent's signal and this run's own controller.
   */
  private runSignal(): AbortSignal {
    return AbortSignal.any(
      this.opts.signal
        ? [this.opts.signal, this.runAbortController.signal]
        : [this.runAbortController.signal],
    );
  }

  private newAssistantRow(): UiMessage {
    return {
      id: randomUUID(),
      role: "assistant",
      content: "",
      createdAt: nowIso(),
      status: "streaming",
      modelId: this.provider.modelId,
      providerId: this.provider.id,
      parentToolCallId: this.opts.parentToolCallId,
      agentName: this.opts.definition.name,
    };
  }

  /**
   * Translate delegate events into transcript events.
   *
   * Only message and tool events are forwarded. `agent_end`, `turn_end` and
   * error events stay inside: Electron main ends the durable turn on those,
   * and a delegate finishing must never end the parent's turn.
   */
  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        this.turns += 1;
        break;
      case "message_start": {
        if (event.message.role === "user") {
          // 只有本运行以 steer 排入的指导消息才回执 applied（对象身份匹配）；
          // 父级任务/召回指令不改任何回执。指导行本身不进转录，只留 TaskGuidance 伪行。
          this.observation.noteInjectedMessage(event.message);
          break;
        }
        if (event.message.role !== "assistant") break;
        const content = assistantContent((event.message as AssistantMessage).content);
        const retryingAssistant = this.providerRetryInProgress
          ? this.currentAssistant
          : undefined;
        this.currentAssistant = {
          ...(retryingAssistant ?? this.newAssistantRow()),
          content: content.text,
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: "streaming",
        };
        if (retryingAssistant) {
          this.providerRetryInProgress = false;
          this.emit({ type: "message_update", message: this.currentAssistant });
        } else {
          this.emit({ type: "message_start", message: this.currentAssistant });
        }
        break;
      }
      case "message_update": {
        if (!this.currentAssistant || event.message.role !== "assistant") break;
        const content = assistantContent((event.message as AssistantMessage).content);
        const previousText = this.currentAssistant.content;
        const previousThinking = this.currentAssistant.thinking ?? "";
        const nextText = content.hasText ? content.text : previousText;
        const nextThinking = content.hasThinking
          ? content.thinking
          : previousThinking;
        const textDelta = content.hasText
          ? cumulativeDelta(previousText, content.text)
          : { delta: "", reset: false };
        const thinkingDelta = content.hasThinking
          ? cumulativeDelta(previousThinking, content.thinking)
          : { delta: "", reset: false };
        this.currentAssistant = {
          ...this.currentAssistant,
          content: nextText,
          ...(nextThinking ? { thinking: nextThinking } : {}),
          status: "streaming",
        };
        if (
          textDelta.delta ||
          thinkingDelta.delta ||
          textDelta.reset ||
          thinkingDelta.reset
        ) {
          this.emit({
            type: "message_update",
            message: this.currentAssistant,
            ...(textDelta.delta ? { deltaText: textDelta.delta } : {}),
            ...(thinkingDelta.delta ? { deltaThinking: thinkingDelta.delta } : {}),
            ...(textDelta.reset ? { resetText: true } : {}),
            ...(thinkingDelta.reset ? { resetThinking: true } : {}),
          });
        }
        break;
      }
      case "message_end": {
        if (event.message.role !== "assistant") break;
        const message = event.message as AssistantMessage;
        const content = assistantContent(message.content);
        const stopReason = message.stopReason as string | undefined;
        const streamFailure = stopReason === "error";
        let classifiedError: ReturnType<typeof classifyAgentError> | undefined;
        let retryAttempt: number | undefined;
        if (streamFailure) {
          const raw =
            typeof (message as { errorMessage?: unknown }).errorMessage === "string"
              ? ((message as { errorMessage?: string }).errorMessage as string)
              : "provider stream failed";
          classifiedError = classifyProviderError(raw, this.retryState.status);
        }
        // Recover only a rejected request. A successful tool-use reply may
        // already have effects before the run loop yields; never replay it based
        // solely on oversized usage reported by a provider.
        const overflow = streamFailure && (
          isContextOverflow(message, this.modelContextWindow()) ||
          classifiedError?.code === "CONTEXT_TOO_LARGE"
        );
        const failed = streamFailure || overflow;
        if (failed) {
          const failure: ReturnType<typeof classifyAgentError> =
            classifiedError ?? {
              code: "CONTEXT_TOO_LARGE",
              message: "The provider stopped an oversized model context",
              retriable: false,
            };
          if (
            overflow &&
            this.compactionEnabled &&
            !this.overflowCompactionAttempted &&
            !this.runSignal().aborted
          ) {
            this.overflowCompactionAttempted = true;
            this.pendingOverflowCompaction = true;
          } else {
            retryAttempt = this.claimProviderRetry(failure, "stream");
            if (retryAttempt !== undefined) {
              this.pendingProviderRetry = failure;
            } else {
              this.streamError = {
                code: failure.code,
                message: failure.message,
              };
            }
          }
        }
        const messageUsage = usageFromPi(message.usage);
        this.usage = addUsage(this.usage, messageUsage);
        this.executionUsage = addUsage(this.executionUsage, messageUsage);
        // The report is the last assistant text; a call-only turn has none and
        // must not clear the text an earlier turn already produced.
        if (content.hasText && content.text.trim() && !failed) {
          this.lastReportText = content.text;
          this.observation.noteStatement(content.text);
        }
        if (retryAttempt !== undefined) {
          this.currentAssistant = {
            ...(this.currentAssistant ?? this.newAssistantRow()),
            content: content.hasText
              ? content.text
              : (this.currentAssistant?.content ?? ""),
            ...(content.hasThinking && content.thinking
              ? { thinking: content.thinking }
              : {}),
            status: "streaming",
            ...(messageUsage ? { usage: messageUsage } : {}),
          };
          this.emit({ type: "message_update", message: this.currentAssistant });
          break;
        }
        const row: UiMessage = {
          ...(this.currentAssistant ?? this.newAssistantRow()),
          content: content.hasText
            ? content.text
            : (this.currentAssistant?.content ?? ""),
          ...(content.hasThinking && content.thinking
            ? { thinking: content.thinking }
            : {}),
          status: failed ? "error" : stopReason === "aborted" ? "aborted" : "complete",
          ...(messageUsage ? { usage: messageUsage } : {}),
          ...(failed ? { isError: true } : {}),
        };
        this.currentAssistant = undefined;
        this.emit({ type: "message_end", message: row });
        break;
      }
      case "tool_execution_start":
        this.emit({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        this.emit({
          type: "tool_update",
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
        });
        break;
      case "tool_execution_end":
        this.observation.end(event.toolCallId, event.result, event.isError);
        this.emit({
          type: "tool_end",
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      default:
        break;
    }
  }

  /** Close a bubble left streaming when the run died without a message_end. */
  private finalizeCurrentAssistant(): void {
    if (!this.currentAssistant) return;
    if (this.currentAssistant.content.trim()) {
      this.lastReportText = this.currentAssistant.content;
    }
    const row: UiMessage = { ...this.currentAssistant, status: "aborted" };
    this.currentAssistant = undefined;
    this.emit({ type: "message_end", message: row });
  }
}
