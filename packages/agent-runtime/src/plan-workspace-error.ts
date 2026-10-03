/** Missing workspace is recoverable without approving or executing a contract. */
export function planWorkspaceRequiredResult(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("data" in error) ||
    typeof error.data !== "object" ||
    error.data === null ||
    !("errorCode" in error.data) ||
    error.data.errorCode !== "PLAN_WORKSPACE_REQUIRED"
  )
    return undefined;

  return {
    content: [
      {
        type: "text" as const,
        text: "Plan/Goal approval requires an available session working directory. Explain the limitation and present the proposal in chat. Retry submission only after a working directory is available. No approval was created and execution is not authorized.",
      },
    ],
    details: { errorCode: "PLAN_WORKSPACE_REQUIRED" },
    isError: true,
  };
}
