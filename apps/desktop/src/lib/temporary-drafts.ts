import type { AppState } from "../stores/app-state";
import { draftKeyForSession, temporaryDraftKey } from "./composer-draft-cache";

export function activeComposerDraftKey(state: AppState): string {
  return !state.activeSessionId && !state.workspace?.path && state.draftSessionId
    ? temporaryDraftKey(state.draftSessionId) : draftKeyForSession(state.activeSessionId);
}

/** Keep directory and toolbar state with the same identity as the composer cache. */
export function retainedTemporaryDrafts(state: AppState): AppState["temporaryDrafts"] {
  if (state.activeSessionId || state.workspace?.path || !state.draftSessionId) {
    return state.temporaryDrafts;
  }
  return {
    ...state.temporaryDrafts,
    [state.draftSessionId]: {
      workspacePath: state.draftTemporaryWorkspacePath,
      configuration: state.draftConfiguration,
    },
  };
}
