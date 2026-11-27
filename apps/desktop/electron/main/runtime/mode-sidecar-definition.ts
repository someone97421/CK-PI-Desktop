import type { ModeDefinition } from "@pi-desktop/shared";

export type SidecarModeDefinition = Omit<ModeDefinition, "bundle">;

/** Strip bundle metadata only from the copy sent to the sidecar. */
export function toSidecarModeDefinition({
  bundle: _bundle,
  ...definition
}: ModeDefinition & { bundle?: unknown }): SidecarModeDefinition {
  return definition;
}
