import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionWorktreeSummary, WorktreePendingWork } from "@pi-desktop/shared";
import {
  IconBranch,
  IconFileText,
  IconFolderOpen,
  IconPullRequest,
  IconRefresh,
  IconWrench,
} from "../../components/icons";
import { Badge } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { WorktreeMergeDialog } from "./WorktreeMergeDialog";
import { WorktreeSetupCommandDialog, WorktreeSetupLogDialog } from "./WorktreeSetupDialogs";
import {
  createIsolatedSession,
  isolationAvailability,
  type IsolationProbeState,
  syncIsolatedSession,
  worktreeErrorMessage,
} from "./worktree-actions";
import { WorktreeBehindMarker } from "./WorktreeBehind";
import { useWorktreeUi } from "./worktree-ui-store";

/** Session-row badge for an isolated session (PRD R3). */
export function WorktreeBadge({
  worktree,
  sessionId,
}: {
  worktree?: SessionWorktreeSummary;
  /** Shows the "behind the project" marker when given. */
  sessionId?: string;
}) {
  const { t } = useTranslation();
  if (!worktree) return null;
  const [tone, label] =
    worktree.status === "conflict"
      ? (["warning", t("worktree.badge.conflict")] as const)
      : worktree.status === "missing"
        ? (["error", t("worktree.badge.missing")] as const)
        : worktree.setupStatus === "failed"
          ? (["warning", t("worktree.badge.setupFailed")] as const)
          : (["neutral", t("worktree.badge.isolated")] as const);
  return (
    <>
      <span
        className="thread-item-worktree"
        title={t("worktree.badge.title", { branch: worktree.branch })}
        data-worktree-status={worktree.status}
      >
        <Badge tone={tone}>{label}</Badge>
      </span>
      {/* A conflicted session cannot sync until it resolves the conflict. */}
      {sessionId && worktree.status !== "missing" && worktree.status !== "conflict" ? (
        <WorktreeBehindMarker sessionId={sessionId} />
      ) : null}
    </>
  );
}

/** Project-menu items: create an isolated session, edit the setup command. */
export function WorktreeProjectMenuItems({
  projectPath,
  projectName,
  onDone,
}: {
  projectPath: string;
  projectName: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const open = useWorktreeUi((s) => s.open);
  const reasonId = useId();
  const [probe, setProbe] = useState<IsolationProbeState>("checking");
  // Probed each time the menu opens, so the item reflects the current
  // repository state; a stale answer for another project is dropped.
  useEffect(() => {
    let current = true;
    setProbe("checking");
    api
      .probeWorktree(projectPath)
      .then((result) => current && setProbe(result))
      .catch(() => current && setProbe("unknown"));
    return () => {
      current = false;
    };
  }, [projectPath]);
  const { disabled, reason } = isolationAvailability(probe, t);
  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-action="new-isolated-session"
        disabled={disabled}
        aria-busy={probe === "checking" || undefined}
        aria-describedby={reason ? reasonId : undefined}
        title={reason}
        onClick={() => {
          onDone();
          void createIsolatedSession(projectPath, t);
        }}
      >
        <IconBranch size={14} />
        {t("worktree.newIsolatedSession")}
      </button>
      {reason ? (
        <p id={reasonId} className="worktree-menu-reason" data-worktree-unavailable="">
          {reason}
        </p>
      ) : null}
      <button
        type="button"
        role="menuitem"
        data-action="worktree-setup-command"
        title={t("worktree.setupCommand.menu")}
        onClick={() => {
          onDone();
          open({ kind: "setupCommand", projectPath, projectName });
        }}
      >
        <IconWrench size={14} />
        <span className="worktree-menu-label">{t("worktree.setupCommand.menu")}</span>
      </button>
    </>
  );
}

/** Session-menu items of an isolated session; nothing for other sessions. */
export function WorktreeSessionMenuItems({
  sessionId,
  title,
  worktree,
  running,
  onDone,
}: {
  sessionId: string;
  title: string;
  worktree?: SessionWorktreeSummary;
  running: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const open = useWorktreeUi((s) => s.open);
  // A conflicted session resolves first; syncing again would only report
  // the same conflict.
  const conflicted = worktree?.status === "conflict";
  const syncable = Boolean(worktree) && worktree?.status !== "missing" && !conflicted;
  // Project commits the session lacks, counted when the menu opens; `-1`
  // when the count failed (syncing still reports the reason).
  const [behind, setBehind] = useState<number | null>(null);
  useEffect(() => {
    if (!syncable) return;
    let current = true;
    setBehind(null);
    api
      .getWorktreeBehind(sessionId)
      .then((count) => {
        if (!current) return;
        setBehind(count);
        useWorktreeUi.getState().setBehindFor(sessionId, count);
      })
      .catch(() => current && setBehind(-1));
    return () => {
      current = false;
    };
  }, [sessionId, syncable]);
  if (!worktree) return null;
  const missing = worktree.status === "missing";
  return (
    <>
      <button
        type="button"
        role="menuitem"
        data-action="worktree-merge"
        disabled={running || missing}
        onClick={() => {
          onDone();
          open({ kind: "merge", sessionId, title });
        }}
      >
        <IconPullRequest size={14} />
        {t("worktree.merge.menu")}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="worktree-sync"
        disabled={running || !syncable || behind === null || behind === 0}
        aria-busy={behind === null && syncable ? true : undefined}
        title={
          conflicted
            ? t("worktree.sync.resolveFirst")
            : behind === 0
              ? t("worktree.sync.upToDate")
              : undefined
        }
        onClick={() => {
          onDone();
          void syncIsolatedSession(sessionId, t);
        }}
      >
        <IconRefresh size={14} />
        {syncable && behind !== null && behind > 0
          ? t("worktree.sync.menuBehind", { count: behind })
          : t("worktree.sync.menu")}
      </button>
      <button
        type="button"
        role="menuitem"
        data-action="worktree-reveal"
        disabled={missing}
        onClick={() => {
          onDone();
          api.revealWorktree(sessionId).catch((error: unknown) =>
            useAppStore.getState().showToast(worktreeErrorMessage(error, t), { variant: "error" }),
          );
        }}
      >
        <IconFolderOpen size={14} />
        {t("worktree.reveal")}
      </button>
      {worktree.setupStatus && worktree.setupStatus !== "none" ? (
        <button
          type="button"
          role="menuitem"
          data-action="worktree-setup-log"
          onClick={() => {
            onDone();
            open({ kind: "setupLog", sessionId, title });
          }}
        >
          <IconFileText size={14} />
          {t("worktree.setupLog.menu")}
        </button>
      ) : null}
    </>
  );
}

/**
 * Note after the armed "Delete?" label of an isolated session: deleting removes
 * its worktree and branch, so unmerged work is named before the second click
 * (PRD R5). Renders nothing when nothing would be lost.
 */
export function WorktreeDeleteLossNote({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<WorktreePendingWork | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getWorktreePendingWork(sessionId)
      .then((result) => alive && setPending(result))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionId]);
  if (!pending || (pending.unmergedCommits === 0 && !pending.uncommittedChanges)) return null;
  return (
    <span className="worktree-delete-loss" data-worktree-loss="true">
      {t("worktree.deleteLoss")}
    </span>
  );
}

/** Renders the open worktree dialog. Mounted once by the sidebar. */
export function WorktreeDialogs() {
  const dialog = useWorktreeUi((s) => s.dialog);
  const close = useWorktreeUi((s) => s.close);
  if (!dialog) return null;
  if (dialog.kind === "merge") {
    return <WorktreeMergeDialog sessionId={dialog.sessionId} title={dialog.title} onClose={close} />;
  }
  if (dialog.kind === "setupLog") {
    return <WorktreeSetupLogDialog sessionId={dialog.sessionId} title={dialog.title} onClose={close} />;
  }
  return (
    <WorktreeSetupCommandDialog
      projectPath={dialog.projectPath}
      projectName={dialog.projectName}
      onClose={close}
    />
  );
}
