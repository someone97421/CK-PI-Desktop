import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import type { AssistantTurnEntry } from "../../../lib/assistant-turns";
import "./task-delivery.css";

/** 只使用持久化的任务边界；旧历史不在视图层猜测结束时间。 */
export function TaskProcessDrawer({ task, children }: {
  task: NonNullable<AssistantTurnEntry["task"]>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const usageId = useId();
  const start = task.startedAt ? Date.parse(task.startedAt) : NaN;
  const end = task.endedAt ? Date.parse(task.endedAt) : NaN;
  const seconds = Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 1000) : undefined;
  const duration = seconds === undefined
    ? t("chat.taskDelivery.durationUnknown")
    : t("chat.taskDelivery.duration", {
      minutes: Math.floor(seconds / 60), seconds: seconds % 60,
    });
  const usage = task.usage;
  const count = (value: number | undefined) => value === undefined
    ? t("chat.taskDelivery.unreported") : value.toLocaleString();
  const details = [
    t("chat.taskDelivery.input", { value: count(usage?.inputTokens) }),
    t("chat.taskDelivery.output", { value: count(usage?.outputTokens) }),
    t("chat.taskDelivery.cacheRead", { value: count(usage?.cacheReadTokens) }),
    t("chat.taskDelivery.cacheWrite", { value: count(usage?.cacheWriteTokens) }),
    ...(usage?.reasoningTokens !== undefined
      ? [t("chat.taskDelivery.reasoning", { value: count(usage.reasoningTokens) })] : []),
    ...(task.usageIncomplete || !usage ? [t("chat.taskDelivery.incomplete")] : []),
    ...(task.estimatedDuration ? [t("chat.taskDelivery.estimated")] : []),
  ].join(" · ");

  return (
    <details className="task-process-drawer">
      <summary className="task-process-summary" title={details} aria-describedby={usageId}>
        <span>
          {task.estimatedDuration ? "≈ " : ""}{duration}
          {" · "}{usage ? `${formatCompactTokenCount(usage.totalTokens)} tokens` : t("chat.taskDelivery.tokensUnknown")}
          {task.usageIncomplete || !usage ? ` · ${t("chat.taskDelivery.incomplete")}` : ""}
          {task.status === "aborted" || task.status === "failed"
            ? ` · ${t(`chat.taskDelivery.${task.status}`)}` : ""}
        </span>
      </summary>
      <p id={usageId} className="task-process-usage">{details}</p>
      <div className="task-process-content">{children}</div>
    </details>
  );
}
