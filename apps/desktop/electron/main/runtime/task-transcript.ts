import { addUsage, type AgentEventEnvelope, type MessageTask, type MessageUsage, type TaskStatus, type UiMessage } from "@pi-desktop/shared";

type TaskRecord = {
  sessionId: string;
  summary: MessageTask;
  root?: UiMessage;
  main: Map<string, MessageUsage | undefined>;
  children: Map<string, MessageUsage | undefined>;
  childReceipts: Map<number, MessageUsage>;
  delegated: boolean;
  finalCandidate?: string;
};
type Publisher = (sessionId: string, turnId: string, message: UiMessage, echo: boolean) => Promise<void>;

/** 任务摘要只服务于展示；不新增模型消息，也不改变运行时取消语义。 */
export class TaskTranscript {
  private readonly records = new Map<string, TaskRecord>();
  private readonly echoes = new WeakSet<UiMessage>();
  private publisher: Publisher = async () => undefined;
  private readonly dirty = new Set<TaskRecord>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1_000;

  constructor(private readonly activeTurns: Map<string, string>) {}
  setPublisher(publisher: Publisher): void { this.publisher = publisher; }
  private key(sessionId: string, turnId: string): string { return JSON.stringify([sessionId, turnId]); }

  private snapshot(record: TaskRecord): MessageTask {
    const sum = (values: Iterable<MessageUsage | undefined>) => {
      let total: MessageUsage | undefined;
      for (const value of values) if (value) total = addUsage(total, value);
      return total;
    };
    const main = sum(record.main.values());
    const rawChildren = sum(record.children.values());
    const receiptChildren = sum(record.childReceipts.values());
    // 汇总回执与逐条子代理消息是同一批用量的两种证据，不能相加。
    const children = (receiptChildren?.totalTokens ?? 0) > (rawChildren?.totalTokens ?? 0)
      ? receiptChildren : rawChildren;
    const usage = children ? addUsage(main, children) : main;
    return {
      ...record.summary,
      usage,
      usageIncomplete: record.summary.status === "aborted" || record.summary.status === "failed"
        || !usage || [...record.main.values()].some((value) => !value)
        || [...record.children.values()].some((value) => !value)
        || (record.delegated && !children),
    };
  }

  private async publish(record: TaskRecord, echo = true): Promise<void> {
    if (!record.root) return;
    const message = { ...record.root, taskId: record.summary.id, task: this.snapshot(record) };
    record.root = message;
    this.echoes.add(message);
    this.dirty.add(record);
    try {
      await this.publisher(record.sessionId, record.summary.id, message, echo);
      if (record.root === message) this.dirty.delete(record);
      if (!this.dirty.size) this.retryDelay = 1_000;
    } catch (error) {
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.flush().catch(() => undefined);
        }, this.retryDelay);
        this.retryTimer.unref();
        this.retryDelay = Math.min(30_000, this.retryDelay * 2);
      }
      throw error;
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.dirty].map((record) => this.publish(record, false)));
  }

  /** 在原始 envelope 上补字段，使实时转发与随后落盘看到同一归属。 */
  observe(envelope: AgentEventEnvelope): void {
    const event = envelope.event;
    if (event.type === "message_end" && event.taskSummary) return;
    const messageEvent = "message" in event ? event : undefined;
    const message = messageEvent?.message;
    if (message && this.echoes.has(message)) return;
    const turnId = envelope.turnId ?? message?.taskId;
    if (!turnId) return;
    const key = this.key(envelope.sessionId, turnId);
    let record = this.records.get(key);
    if (!record && this.activeTurns.get(envelope.sessionId) === turnId) {
      record = {
        sessionId: envelope.sessionId,
        summary: { id: turnId, revision: 0, status: "running", usageIncomplete: true },
        main: new Map(), children: new Map(), childReceipts: new Map(), delegated: false,
      };
      this.records.set(key, record);
      // 留少量已结束记录接收迟到用量，避免长期保留无限用户内容。
      if (this.records.size > 128) {
        for (const [oldKey, old] of this.records) {
          if (old.summary.status !== "running" && !this.dirty.has(old)) this.records.delete(oldKey);
          if (this.records.size <= 128) break;
        }
      }
    }
    if (!record) {
      if (message && messageEvent) messageEvent.message = { ...message, taskId: turnId };
      return;
    }
    const child = Boolean(envelope.parentToolCallId || message?.parentToolCallId);
    let changed = false;
    if (event.type === "agent_start" && !child && !record.summary.startedAt && record.summary.status === "running") {
      record.summary = { ...record.summary, startedAt: new Date(envelope.ts).toISOString() };
      changed = true;
    }
    if (event.type === "tool_start" && !child) {
      if (record.summary.status === "running") record.finalCandidate = undefined;
      if (["Task", "TaskResume"].includes(event.toolName)) record.delegated = true;
    }
    if (event.type === "turn_end" && !child && event.subagentUsage) {
      record.childReceipts.set(envelope.ts, event.subagentUsage);
      changed = true;
    }
    if (event.type === "message_end" && message?.role === "assistant") {
      const usageMap = child ? record.children : record.main;
      if (message.usage || !usageMap.has(message.id)) usageMap.set(message.id, message.usage);
      if (!child && record.summary.status === "running") {
        record.finalCandidate = message.status === "complete" && !message.error && message.content.trim()
          ? message.id : undefined;
      }
      changed = true;
    }
    if (changed) record.summary = { ...record.summary, revision: (record.summary.revision ?? 0) + 1 };
    if (message && messageEvent) {
      const isRoot = !child && message.role === "user" && !message.steering
        && (!record.root || record.root.role !== "user" || record.root.id === message.id);
      messageEvent.message = { ...message, taskId: turnId, task: this.snapshot(record) };
      if (isRoot) {
        const first = !record.root || record.root.role !== "user";
        record.root = messageEvent.message;
        // 初始 user 由 IPC 写入；这里只补摘要，原事件本身已会转发。
        if (first) void this.publish(record, false).catch(() => undefined);
      } else if ((!record.root && !child && message.role === "assistant" && event.type === "message_end")
          || record.root?.id === message.id) {
        // 计划执行等无新 user 行的入口，使用已有完整消息保存摘要。
        record.root = messageEvent.message;
      }
      if (event.type === "message_end" && event.precedingAssistant) {
        event.precedingAssistant = { ...event.precedingAssistant, taskId: turnId };
      }
    }
    if (changed && (record.summary.status !== "running" || event.type === "agent_start")) {
      void this.publish(record).catch(() => undefined);
    }
  }

  /** 在 finishTurn 的所有权冻结阶段确定终态，迟到事件只能补充用量。 */
  finish(sessionId: string, turnId: string, status: TaskStatus): Promise<void> {
    const record = this.records.get(this.key(sessionId, turnId));
    if (!record) return Promise.resolve();
    if (record.summary.status !== "running") return this.dirty.has(record) ? this.publish(record) : Promise.resolve();
    record.summary = {
      ...record.summary, status, endedAt: new Date().toISOString(),
      revision: (record.summary.revision ?? 0) + 1,
      finalMessageId: status === "completed" ? record.finalCandidate : undefined,
    };
    return this.publish(record);
  }

  usage(sessionId: string, turnId: string): MessageUsage | undefined {
    const record = this.records.get(this.key(sessionId, turnId));
    return record ? this.snapshot(record).usage : undefined;
  }
}
