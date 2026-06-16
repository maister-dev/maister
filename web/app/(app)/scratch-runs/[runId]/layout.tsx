import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { LiveRunInspector } from "@/components/runs/live-run-inspector";
import {
  type RunInspectorAction,
  type RunInspectorChangeSummary,
  type RunInspectorLabels,
} from "@/components/runs/run-inspector";
import { RunShell, type RunShellLabels } from "@/components/runs/run-shell";
import { ScratchConversation } from "@/components/scratch/scratch-conversation";
import { ScratchInspectorActions } from "@/components/scratch/scratch-inspector-actions";
import FileTree, {
  type FileTreeLabels,
} from "@/components/workbench/file-tree";
import RunDiff, { type RunDiffLabels } from "@/components/workbench/run-diff";
import { WorkbenchPanel } from "@/components/workbench/workbench-panel";
import { type WorkbenchTabsLabels } from "@/components/workbench/workbench-tabs";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { getRunDetail } from "@/lib/queries/run";
import { getRunChangeSummary } from "@/lib/runs/change-summary";
import {
  buildScratchSessionFlowSummary,
  getScratchSessionSummary,
} from "@/lib/scratch-runs/session-summary";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ runId: string }>;
};

function unavailableChangeSummary(reason: string): RunInspectorChangeSummary {
  return {
    fileCount: 0,
    additions: 0,
    deletions: 0,
    unavailable: true,
    unavailableReason: reason,
    files: [],
  };
}

// The persistent scratch-run detail boundary (M35 T3.1) — mirrors the
// /runs/[runId] shape: the conversation is the primary center, the shared run
// inspector + Files/Diff workbench are secondary, and the `?file=` server pane
// is `children`. The runId-scoped change-summary read lives here so a `?file=`
// / `?wb=` soft-nav re-renders only the child pane. The live conversation,
// permission HITL, and lifecycle/promote actions are client subtrees.
export default async function ScratchRunDetailLayout({
  children,
  params,
}: LayoutProps): Promise<ReactElement> {
  const { runId } = await params;

  const user = await getSessionUser();

  if (!user) redirect("/login");

  const detail = await getRunDetail(runId);

  if (!detail || detail.runKind !== "scratch") notFound();

  const role =
    user.role === "admin"
      ? "owner"
      : await getProjectRole(user.id, detail.projectId);

  // Hide existence from non-members (mirrors the run detail page).
  if (!role) notFound();

  const t = await getTranslations("run");
  const tWorkbench = await getTranslations("workbench");

  let changeSummary: RunInspectorChangeSummary | null = null;

  try {
    changeSummary = await getRunChangeSummary({
      runId: detail.runId,
      scope: "run",
    });
  } catch (err) {
    if (!isMaisterError(err)) throw err;

    changeSummary = unavailableChangeSummary(t("inspectorUnavailable"));
  }

  const session = await getScratchSessionSummary(detail.runId);
  const sessionSummary = session
    ? buildScratchSessionFlowSummary(session, {
        title: t("inspectorSessionTitle"),
        dialog: t("inspectorSessionDialog"),
        capabilities: t("capabilityTitle"),
      })
    : null;

  const shellLabels: RunShellLabels = {
    branch: t("headerBranch"),
    changes: t("headerChanges"),
    changesUnavailable: t("headerChangesUnavailable"),
    changedFiles: t("headerChangedFilesUnit"),
    task: t("headerTask"),
    openInspector: t("headerOpenInspector"),
    closeInspector: t("headerCloseInspector"),
  };
  const inspectorLabels: RunInspectorLabels = {
    overview: t("inspectorOverview"),
    changes: t("inspectorChanges"),
    flow: t("inspectorFlow"),
    actions: t("inspectorActions"),
    noChanges: t("inspectorNoChanges"),
    unavailable: t("inspectorUnavailable"),
    viewDiff: t("inspectorViewDiff"),
    viewSource: t("inspectorViewSource"),
    binary: t("inspectorBinary"),
    disabled: t("inspectorDisabled"),
    stale: t("inspectorStale"),
  };
  const workbenchTabLabels: WorkbenchTabsLabels = {
    files: tWorkbench("tab.files"),
    diff: tWorkbench("tab.diff"),
    evidence: tWorkbench("tab.evidence"),
    timeline: tWorkbench("tab.timeline"),
  };
  const workbenchFilesLabels: FileTreeLabels = {
    empty: tWorkbench("files.empty"),
    loadError: tWorkbench("files.loadError"),
    treeLabel: tWorkbench("files.treeLabel"),
  };
  const workbenchDiffLabels: RunDiffLabels = {
    title: tWorkbench("diff.title"),
    empty: tWorkbench("diff.empty"),
    error: tWorkbench("diff.error"),
    changedFiles: tWorkbench("diff.changedFiles"),
    bodyUnavailable: tWorkbench("diff.bodyUnavailable"),
    added: tWorkbench("diff.added"),
    removed: tWorkbench("diff.removed"),
    displayMode: tWorkbench("diff.displayMode"),
    rich: tWorkbench("diff.rich"),
    raw: tWorkbench("diff.raw"),
    filterFiles: tWorkbench("diff.filterFiles"),
    filterFilesPlaceholder: tWorkbench("diff.filterFilesPlaceholder"),
    filterNoMatches: tWorkbench("diff.filterNoMatches"),
    showFiles: tWorkbench("diff.showFiles"),
    hideFiles: tWorkbench("diff.hideFiles"),
    refresh: tWorkbench("diff.refresh"),
    viewMode: tWorkbench("diff.viewMode"),
    split: tWorkbench("diff.split"),
    unified: tWorkbench("diff.unified"),
    truncated: tWorkbench("diff.truncated"),
  };

  const inspectorFacts = [
    { label: t("flowCenterStatus"), value: detail.status },
    { label: t("agentCenterRunner"), value: detail.agent },
    { label: t("headerBranch"), value: detail.branch },
    { label: t("baseBranch"), value: detail.baseBranch ?? "-" },
    { label: t("targetBranch"), value: detail.targetBranch ?? "-" },
    {
      label: t("inspectorWorktree"),
      value: detail.pruned
        ? `${detail.worktreePath} (${t("inspectorWorktreeRemoved")})`
        : detail.archived
          ? `${detail.worktreePath} (${t("inspectorWorktreeArchived")})`
          : detail.worktreePath,
    },
  ];
  const inspectorActions: RunInspectorAction[] = [
    {
      id: "reviewChanges",
      label: t("flowCenterReviewChanges"),
      href: `/scratch-runs/${detail.runId}?wb=diff`,
    },
  ];
  const promoteTargetBranch =
    detail.targetBranch ?? detail.baseBranch ?? detail.projectMainBranch;
  const shellSubtitle = `${t("eyebrow")} / ${detail.projectSlug}`;

  return (
    <RunShell
      branch={detail.branch}
      changeSummary={changeSummary}
      inspector={
        <div className="flex flex-col gap-3">
          <LiveRunInspector
            actions={inspectorActions}
            changeScope="run"
            changeSummary={changeSummary}
            facts={inspectorFacts}
            flowSummary={sessionSummary}
            labels={inspectorLabels}
            pathname={`/scratch-runs/${detail.runId}`}
            runId={detail.runId}
            runStatus={detail.status}
          />
          <ScratchInspectorActions
            lifecycleActions={detail.lifecycleActions}
            promoteTargetBranch={promoteTargetBranch}
            runId={detail.runId}
          />
        </div>
      }
      labels={shellLabels}
      status={detail.status}
      subtitle={shellSubtitle}
      targetBranch={detail.targetBranch}
      title={detail.branch}
    >
      <div className="grid gap-5">
        <ScratchConversation runId={detail.runId} />

        <section data-testid="run-workbench">
          <WorkbenchPanel
            diff={<RunDiff labels={workbenchDiffLabels} runId={detail.runId} />}
            filesPane={children}
            filesTree={
              <FileTree
                filesApiBase={`/api/runs/${detail.runId}/files`}
                labels={workbenchFilesLabels}
              />
            }
            runId={detail.runId}
            tabLabels={workbenchTabLabels}
            tabs={["files", "diff"]}
          />
        </section>
      </div>
    </RunShell>
  );
}
