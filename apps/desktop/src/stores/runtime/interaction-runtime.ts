import type { PlanResolutionResult } from "@pi-desktop/shared";

export type InteractionRuntime = {
  askResolutionRequests: Map<string, { answers: string | undefined; promise: Promise<void> }>;
  planResolutionRequests: Map<string, Promise<PlanResolutionResult>>;
  nextToastId: () => number;
};

/** Ephemeral coordination for user interactions; durable state stays in Zustand. */
export function createInteractionRuntime(): InteractionRuntime {
  let toastSequence = 0;
  return {
    askResolutionRequests: new Map(),
    planResolutionRequests: new Map<string, Promise<PlanResolutionResult>>(),
    nextToastId: () => ++toastSequence,
  };
}
