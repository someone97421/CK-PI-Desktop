import type { ReactNode } from "react";
import type { PluginSidebarSessionStatusSlotProps } from "@pi-desktop/plugin-sdk";
import {
  SlotBoundary,
  slotElement,
  useSlotEntryForKey,
} from "./use-slots";

export function SidebarSessionStatusSlot({
  sessionId,
  status,
  label,
  enabled,
  fallback,
}: Omit<PluginSidebarSessionStatusSlotProps, "fallback"> & {
  label: string;
  enabled: boolean;
  fallback: ReactNode;
}) {
  const entry = useSlotEntryForKey("sidebarSessionStatus", "sidebarSessionStatus");
  if (!enabled || !entry) return fallback;
  return (
    <div className="thread-item-status-slot" role="img" aria-label={label} title={label}>
      <SlotBoundary key={entry.id} entry={entry} fallback={fallback}>
        {slotElement(entry, { sessionId, status, fallback })}
      </SlotBoundary>
    </div>
  );
}
