import { useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { cachedActivitySummary } from "../../../lib/transcript-activity-summary";
import { IconChevronRight, IconCircleAlert, IconSparkles } from "../../../components/icons";
import { DisclosureCollapseRail } from "./shared";
import { DisclosureScope, type useAutomaticDisclosure } from "./disclosure";

/** Keep the body identity stable when a singleton grows into a group. */
export function ProcessActivityGroup({
  items,
  active,
  disclosure,
  children,
  preview,
}: {
  items: readonly AssistantActivityItem[];
  active: boolean;
  disclosure: ReturnType<typeof useAutomaticDisclosure>;
  children: ReactNode;
  preview?: string;
}) {
  const { t } = useTranslation();
  const detailsId = useId();
  const grouped = items.length > 1;
  // A group below a collapsed whole-turn process is not expanded even when the
  // user left it open: `disclosure.open` already folds in that gate, and the
  // choice itself survives so reopening the process restores it.
  const parentVisible = disclosure.parentVisible;
  const open = (!grouped || disclosure.open) && parentVisible;
  const summary = useMemo(() => cachedActivitySummary(items), [items]);
  if (items.length === 0) return null;
  return (
    <div className={`process-activity-group${grouped ? " grouped" : " singleton"}${open ? " open" : ""}`}>
      {grouped ? (
        <button
          type="button"
          className="tool-activity-header"
          ref={disclosure.titleRef}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={disclosure.toggle}
        >
          <span className="tool-activity-icon" aria-hidden><IconSparkles size={14} /></span>
          <span className={`tool-activity-label${active ? " running" : ""}`}>
            {t(summary.label, { count: summary.count })}
          </span>
          {summary.thinking > 0 && summary.tools > 0 ? (
            <span className="tool-activity-count">{t("chat.activityIncludesThinking")}</span>
          ) : null}
          {active ? <span className="tool-activity-count">{t("chat.running")}</span> : null}
          {summary.issues > 0 ? (
            <span className="turn-process-error">
              <IconCircleAlert size={14} aria-hidden />
              {t("chat.activityFailures", { count: summary.issues })}
            </span>
          ) : null}
          <span className="tool-activity-caret" aria-hidden><IconChevronRight size={12} /></span>
        </button>
      ) : null}
      {grouped && !open && parentVisible && preview ? (
        <div className="tool-activity-preview" aria-hidden>{preview}</div>
      ) : null}
      <div
        id={detailsId}
        ref={disclosure.bodyRef}
        className="process-activity-body"
        hidden={!open}
        inert={!open}
        {...disclosure.bodyEvents}
      >
        {grouped ? <DisclosureCollapseRail label={t("chat.collapseActivityGroup")} onCollapse={disclosure.collapse} /> : null}
        <DisclosureScope disclosure={disclosure} open={open}>{children}</DisclosureScope>
      </div>
    </div>
  );
}
