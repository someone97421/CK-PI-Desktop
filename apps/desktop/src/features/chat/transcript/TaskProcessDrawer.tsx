import { useContext, useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  addUsage,
  formatCompactTokenCount,
  runElapsedMs,
  summarizeUsageByModel,
  withUsageIdentity,
  type MessageUsage,
  type TaskModelUsage,
  type UiMessage,
} from "@pi-desktop/shared";
import type { AssistantTurnEntry, AssistantTurnPart } from "../../../lib/assistant-turns";
import { DisclosureScope, disclosureKey, useAutomaticDisclosure } from "./disclosure";
import { TranscriptSearchContext } from "../../../lib/transcript-search-context";
import { processContainsMessage } from "../../../lib/turn-process";
import "./task-delivery.css";

/** 优先采用宿主/持久化按模型汇总；旧历史无此字段时从已加载本轮消息回退聚合。 */
function resolveTaskModelUsages(
  task: NonNullable<AssistantTurnEntry["task"]>,
  sourceMessages?: readonly UiMessage[],
): TaskModelUsage[] {
  if (task.usageByModel?.length) return task.usageByModel;
  const fromLedger = summarizeUsageByModel(task.usage);
  if (fromLedger?.length) return fromLedger;
  if (!sourceMessages?.length) return [];
  let combined: MessageUsage | undefined;
  for (const message of sourceMessages) {
    if (message.role !== "assistant" || !message.usage) continue;
    const attributed = withUsageIdentity(message.usage, {
      operationId: `message:${task.id}:${message.id}`,
      usageOrigin: "legacy",
      providerId: message.providerId,
      modelId: message.responseModelId ?? message.modelId,
    });
    combined = addUsage(combined, attributed);
  }
  return summarizeUsageByModel(combined) ?? [];
}

/** 只使用持久化的任务边界；旧历史不在视图层猜测结束时间。 */
export function TaskProcessDrawer({ task, processParts, sourceMessages, children }: {
  task: NonNullable<AssistantTurnEntry["task"]>;
  processParts: readonly AssistantTurnPart[];
  sourceMessages?: readonly UiMessage[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const usageId = useId();
  const search = useContext(TranscriptSearchContext);
  const revealRequest = search && processContainsMessage(processParts, search.messageId)
    ? search.requestId : undefined;
  const disclosure = useAutomaticDisclosure<HTMLElement>(false, revealRequest, disclosureKey("task", task.id));
  const start = task.startedAt ? Date.parse(task.startedAt) : NaN;
  const end = task.endedAt ? Date.parse(task.endedAt) : NaN;
  const elapsed = task.runTiming ? runElapsedMs(task.runTiming)
    : Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
  const seconds = elapsed === undefined ? undefined : Math.round(elapsed / 1000);
  const duration = seconds === undefined
    ? t("chat.taskDelivery.durationUnknown")
    : t("chat.taskDelivery.duration", {
      minutes: Math.floor(seconds / 60), seconds: seconds % 60,
    });
  const usage = task.usage;
  const modelUsages = useMemo(
    () => resolveTaskModelUsages(task, sourceMessages),
    [task, sourceMessages],
  );
  const count = (value: number | undefined) => value === undefined
    ? t("chat.taskDelivery.unreported") : value.toLocaleString();
  const formatUsageBuckets = (item: Pick<TaskModelUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"> | undefined) => [
    t("chat.taskDelivery.input", { value: count(item?.inputTokens) }),
    t("chat.taskDelivery.output", { value: count(item?.outputTokens) }),
    t("chat.taskDelivery.cacheRead", { value: count(item?.cacheReadTokens) }),
    t("chat.taskDelivery.cacheWrite", { value: count(item?.cacheWriteTokens) }),
    ...(item?.reasoningTokens !== undefined
      ? [t("chat.taskDelivery.reasoning", { value: count(item.reasoningTokens) })] : []),
  ].join(" · ");
  const details = [
    formatUsageBuckets(usage),
    ...(task.usageIncomplete || !usage ? [t("chat.taskDelivery.incomplete")] : []),
    ...(task.estimatedDuration ? [t("chat.taskDelivery.estimated")] : []),
  ].join(" · ");

  return (
    <details open={disclosure.open} className="task-process-drawer">
      <summary
        ref={disclosure.titleRef}
        className="task-process-summary"
        title={details}
        aria-describedby={usageId}
        onClick={(event) => { event.preventDefault(); disclosure.toggle(); }}
      >
        <span>
          {task.estimatedDuration ? "≈ " : ""}{duration}
          {" · "}{usage ? `${formatCompactTokenCount(usage.totalTokens)} tokens` : t("chat.taskDelivery.tokensUnknown")}
          {task.usageIncomplete || !usage ? ` · ${t("chat.taskDelivery.incomplete")}` : ""}
          {task.status === "aborted" || task.status === "failed"
            ? ` · ${t(`chat.taskDelivery.${task.status}`)}` : ""}
        </span>
      </summary>
      <div id={usageId} className="task-process-usage">
        <p className="task-process-usage-total">{details}</p>
        {modelUsages.length > 0 ? (
          <ul className="task-process-usage-models">
            {modelUsages.map((item) => (
              <li key={item.modelId} className="task-process-usage-model-row">
                <code className="task-process-usage-model-id" title={item.modelId}>{item.modelId}</code>
                <span className="task-process-usage-model-total">
                  {formatCompactTokenCount(item.totalTokens)} tokens
                </span>
                <span className="task-process-usage-model-breakdown">
                  {formatUsageBuckets(item)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div ref={disclosure.bodyRef} className="task-process-content" {...disclosure.bodyEvents}>
        <DisclosureScope disclosure={disclosure}>{children}</DisclosureScope>
      </div>
    </details>
  );
}
