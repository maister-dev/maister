import type { EnforcementSnapshotEntry } from "@/lib/db/schema";
import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import { AssignmentActions } from "@/components/board/assignment-actions";
import { EvidenceGraphSection } from "@/components/board/evidence-graph-section";
import { type EvidenceGraphLabels } from "@/components/board/evidence-graph";
import { type FlowGraphViewLabels } from "@/components/board/flow-graph-view";
import { FlowGraphViewSection } from "@/components/board/flow-graph-view-section";
import {
  CapabilityProfilePanel,
  type CapabilityProfileNodeView,
  type CapabilityProfilePanelLabels,
} from "@/components/board/panels/capability-profile-panel";
import {
  FlowSettingsPanel,
  type FlowSettingsPanelLabels,
} from "@/components/board/panels/flow-settings-panel";
import { RunHitlResponse } from "@/components/board/run-hitl-response";
import { RunTakeoverActions } from "@/components/board/run-takeover-actions";
import {
  RunTimeline,
  type TimelineEntry,
  type TimelineLabels,
} from "@/components/board/run-timeline";
import { RunRecoverActions } from "@/components/runs/run-recover-actions";
import { ReadinessSummary } from "@/components/run/readiness-summary";
import {
  ResolvedCapabilitySetPanel,
  type ResolvedCapabilitySetLabels,
} from "@/components/runs/resolved-capability-set-panel";
import {
  ReviewPanel,
  type ReviewPanelDiff,
  type ReviewPanelLabels,
} from "@/components/runs/review-panel";
import FileTree, {
  type FileTreeLabels,
} from "@/components/workbench/file-tree";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";
import RunDiff, { type RunDiffLabels } from "@/components/workbench/run-diff";
import { WorkbenchPanel } from "@/components/workbench/workbench-panel";
import { type WorkbenchTabsLabels } from "@/components/workbench/workbench-tabs";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { prepareDiff } from "@/lib/diff/prepare";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildEvidenceGraph } from "@/lib/queries/evidence-graph";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { getRunReadiness } from "@/lib/queries/readiness";
import {
  getRunCapabilityProfiles,
  getRunDetail,
  getRunResolvedCapabilitySet,
  getRunSettings,
  getRunTimeline,
} from "@/lib/queries/run";
import { diffRange, resolveBaseCommit, resolveBaseRef } from "@/lib/worktree";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ runId: string }>;
};

type RunDetailForReview = Awaited<ReturnType<typeof getRunDetail>> & object;

// Resolve the ReviewPanel props for a flow run at `Review`. Legacy-row safe
// (§3.6): null branch metadata is filled from project defaults / merge-base;
// when no safe diff base can be derived the panel renders the relaunch state.
const EMPTY_DIFF: ReviewPanelDiff = {
  files: [],
  perFile: [],
  truncated: false,
};

async function buildReviewPanelData(detail: RunDetailForReview): Promise<{
  baseBranch: string | null;
  baseCommit: string | null;
  targetBranch: string | null;
  reviewedTargetCommit: string | null;
  promotionMode: "local_merge" | "pull_request";
  diff: ReviewPanelDiff;
  driftDetected: boolean;
  legacyNeedsRelaunch: boolean;
}> {
  const targetBranch = detail.targetBranch ?? detail.projectMainBranch;
  const promotionMode: "local_merge" | "pull_request" =
    detail.promotionMode === "pull_request" ? "pull_request" : "local_merge";

  // The diff base: the EXACT commit the run forked from (a stable point — the
  // target branch may have advanced since), else the recorded base branch, else
  // the merge-base of the run branch against the project main branch (M11b).
  let diffBaseRef: string;

  if (detail.baseCommit) {
    diffBaseRef = detail.baseCommit;
  } else if (detail.baseBranch) {
    diffBaseRef = detail.baseBranch;
  } else {
    try {
      diffBaseRef = await resolveBaseRef({
        worktreePath: detail.worktreePath,
        branch: detail.branch,
        mainBranch: detail.projectMainBranch,
      });
    } catch {
      // A pre-M18 run whose diff base cannot be derived → relaunch to promote.
      return {
        baseBranch: detail.baseBranch,
        baseCommit: detail.baseCommit,
        targetBranch: null,
        reviewedTargetCommit: null,
        promotionMode,
        diff: EMPTY_DIFF,
        driftDetected: false,
        legacyNeedsRelaunch: true,
      };
    }
  }

  const { text: rawDiff, truncated } = await diffRange({
    worktreePath: detail.worktreePath,
    baseRef: diffBaseRef,
    branch: detail.branch,
  });
  const diff = await prepareDiff(rawDiff, truncated);

  // The live target HEAD this surface is reviewed against — carried into the
  // promote payload as the optimistic-concurrency drift token (§3.7). Drift is
  // detected SERVER-SIDE at promote time (live HEAD ≠ this token), then the
  // panel flips to the drift state — it is never pre-computed at render.
  let reviewedTargetCommit: string | null = null;

  try {
    reviewedTargetCommit = await resolveBaseCommit({
      projectRepoPath: detail.projectRepoPath,
      baseRef: targetBranch,
    });
  } catch {
    reviewedTargetCommit = null;
  }

  return {
    baseBranch: detail.baseBranch ?? diffBaseRef,
    baseCommit: detail.baseCommit,
    targetBranch,
    reviewedTargetCommit,
    promotionMode,
    diff,
    driftDetected: false,
    legacyNeedsRelaunch: false,
  };
}

function offersTakeover(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as { review?: boolean; allowedDecisions?: string[] };

  return Boolean(s.review) && (s.allowedDecisions ?? []).includes("takeover");
}

function staleSummaryText(
  summary: Record<string, unknown> | null,
): string | null {
  if (summary === null) return null;
  const count = summary.count;

  if (typeof count === "number" && count > 0) {
    return String(count);
  }

  return "!";
}

// The persistent run-detail boundary (ADR-066 / FINDING A): a nested layout
// receives `params` but NOT `searchParams`, and Next preserves it across child
// soft-navigations that only change the query string. ALL runId-scoped heavy
// loads (flow-graph compile + getRunNodeStatuses + buildReviewPanelData + the
// timeline/evidence/readiness/settings/capability reads) live here so a
// `?file=`/`?wb=`/`?diffview=` change re-renders ONLY the child page — never
// these loaders. The `?file=`-driven blob read + <CodeView> are the `children`.
export default async function RunDetailLayout({
  children,
  params,
}: LayoutProps): Promise<ReactElement> {
  const { runId } = await params;

  const user = await getSessionUser();

  if (!user) redirect("/login");

  const detail = await getRunDetail(runId);

  if (!detail) notFound();

  const role =
    user.role === "admin"
      ? "owner"
      : await getProjectRole(user.id, detail.projectId);

  // Hide existence from non-members (mirrors the project board page).
  if (!role) notFound();

  const canAct = role === "owner" || role === "admin" || role === "member";
  const t = await getTranslations("run");

  const timeline = await getRunTimeline(runId);
  const settings = await getRunSettings(runId);
  const capabilityProfiles = await getRunCapabilityProfiles(runId);
  const resolvedSet = await getRunResolvedCapabilitySet(runId);
  const evidence = await buildEvidenceGraph(runId);
  const readiness = await getRunReadiness(runId, detail.projectId);
  const tEvidence = await getTranslations("evidence");
  const tReadiness = await getTranslations("readiness");

  const evidenceLabels: EvidenceGraphLabels = {
    title: tEvidence("title"),
    empty: tEvidence("empty"),
    openPayload: tEvidence("openPayload"),
    payloadGone: tEvidence("payloadGone"),
    payloadError: tEvidence("payloadError"),
    payloadLoading: tEvidence("payloadLoading"),
    close: tEvidence("close"),
    filterNode: tEvidence("filterNode"),
    filterKind: tEvidence("filterKind"),
    filterState: tEvidence("filterState"),
    filterAny: tEvidence("filterAny"),
    stateCurrent: tEvidence("stateCurrent"),
    stateStale: tEvidence("stateStale"),
    stateSuperseded: tEvidence("stateSuperseded"),
    stateFailed: tEvidence("stateFailed"),
    stateSkipped: tEvidence("stateSkipped"),
    kindTaskInput: tEvidence("kindTaskInput"),
    kindNodeAttempt: tEvidence("kindNodeAttempt"),
    kindArtifact: tEvidence("kindArtifact"),
    kindGate: tEvidence("kindGate"),
    kindDecision: tEvidence("kindDecision"),
  };

  // M22 (ADR-064): the flow-graph view for a flow run — compiled topology +
  // authored layout from the manifest presentation section + initial node
  // statuses, all server-state. Scratch runs have no flow graph and skip it.
  let flowGraphData: {
    topology: ReturnType<typeof buildGraphTopology>;
    layout: Record<string, { x: number; y: number }>;
    statuses: Awaited<ReturnType<typeof getRunNodeStatuses>>;
    labels: FlowGraphViewLabels;
    tabLabels: WorkbenchTabsLabels;
    filesLabels: FileTreeLabels;
    diffLabels: RunDiffLabels;
  } | null = null;

  if (detail.runKind === "flow") {
    const loadedM = await loadRunManifest(runId);

    if (loadedM) {
      const topology = buildGraphTopology(compileManifest(loadedM.manifest));
      const graphLayout = presentationLayout(loadedM.manifest);
      const nodeStatuses = await getRunNodeStatuses(runId);
      const tWorkbench = await getTranslations("workbench");

      flowGraphData = {
        topology,
        layout: graphLayout,
        statuses: nodeStatuses,
        labels: {
          title: tWorkbench("graph.title"),
          empty: tWorkbench("graph.empty"),
          currentNode: tWorkbench("graph.currentNode"),
          declaredGateSummary: tWorkbench("graph.declaredGateSummary"),
          gateSummary: tWorkbench("graph.gateSummary"),
          blockingGateSummary: tWorkbench("graph.blockingGateSummary"),
          node: {
            Pending: tWorkbench("graph.node.Pending"),
            Running: tWorkbench("graph.node.Running"),
            Succeeded: tWorkbench("graph.node.Succeeded"),
            Failed: tWorkbench("graph.node.Failed"),
            NeedsInput: tWorkbench("graph.node.NeedsInput"),
            Reworked: tWorkbench("graph.node.Reworked"),
            Stale: tWorkbench("graph.node.Stale"),
          },
          role: {
            agent: tWorkbench("graph.role.agent"),
            command: tWorkbench("graph.role.command"),
            check: tWorkbench("graph.role.check"),
            judge: tWorkbench("graph.role.judge"),
            human: tWorkbench("graph.role.human"),
            terminal: tWorkbench("graph.role.terminal"),
            other: tWorkbench("graph.role.other"),
          },
          edge: {
            success: tWorkbench("graph.edge.success"),
            default: tWorkbench("graph.edge.default"),
            rework: tWorkbench("graph.edge.rework"),
            reject: tWorkbench("graph.edge.reject"),
            takeover: tWorkbench("graph.edge.takeover"),
            approve: tWorkbench("graph.edge.approve"),
            other: tWorkbench("graph.edge.other"),
          },
        },
        tabLabels: {
          files: tWorkbench("tab.files"),
          diff: tWorkbench("tab.diff"),
          graph: tWorkbench("tab.graph"),
        },
        filesLabels: {
          empty: tWorkbench("files.empty"),
          loadError: tWorkbench("files.loadError"),
          treeLabel: tWorkbench("files.treeLabel"),
        },
        diffLabels: {
          title: tWorkbench("diff.title"),
          empty: tWorkbench("diff.empty"),
          error: tWorkbench("diff.error"),
          changedFiles: tWorkbench("diff.changedFiles"),
          added: tWorkbench("diff.added"),
          removed: tWorkbench("diff.removed"),
          viewMode: tWorkbench("diff.viewMode"),
          split: tWorkbench("diff.split"),
          unified: tWorkbench("diff.unified"),
          truncated: tWorkbench("diff.truncated"),
        },
      };
    }
  }

  const settingsClassLabel: Record<EnforcementSnapshotEntry["class"], string> =
    {
      mcps: t("settingsClassMcps"),
      tools: t("settingsClassTools"),
      skills: t("settingsClassSkills"),
      restrictions: t("settingsClassRestrictions"),
      permissionMode: t("settingsClassPermissionMode"),
      workspaceAccess: t("settingsClassWorkspaceAccess"),
    };

  const settingsLabels: FlowSettingsPanelLabels = {
    title: t("settingsTitle"),
    declaredIntentNote: t("settingsDeclaredIntentNote"),
    verdictEnforced: t("settingsVerdictEnforced"),
    verdictInstructed: t("settingsVerdictInstructed"),
    verdictRefused: t("settingsVerdictRefused"),
    noConstraints: t("settingsNoConstraints"),
    refusalReason: t("settingsRefusalReason"),
    classLabel: (cls) => settingsClassLabel[cls],
  };

  const capabilityLabels: CapabilityProfilePanelLabels = {
    title: t("capabilityTitle"),
    subtitle: t("capabilitySubtitle"),
    digestLabel: t("capabilityDigest"),
    revisionLabel: t("capabilityRevision"),
    enforcedLabel: t("capabilityEnforced"),
    instructedLabel: t("capabilityInstructed"),
    refusedLabel: t("capabilityRefused"),
    cleanupFailedLabel: t("capabilityCleanupFailed"),
    trustThirdParty: t("capabilityThirdParty"),
    noProfiles: t("capabilityNoProfiles"),
    // Capability classes are already human-readable ref ids — identity label.
    classLabel: (c) => c,
  };

  const resolvedSetLabels: ResolvedCapabilitySetLabels = {
    title: t("resolvedSet.title"),
    flowRevision: t("resolvedSet.flowRevision"),
    flowOrigin: t("resolvedSet.flowOrigin"),
    capabilities: t("resolvedSet.capabilities"),
    mcps: t("resolvedSet.mcps"),
    empty: t("resolvedSet.empty"),
    origin: {
      authored: t("resolvedSet.origin.authored"),
      git: t("resolvedSet.origin.git"),
    },
  };

  const capabilityNodes: CapabilityProfileNodeView[] =
    capabilityProfiles?.nodes.map((n) => ({
      nodeId: n.nodeId,
      nodeType: n.nodeType,
      profileDigest: n.plan.profileDigest,
      resolvedRevisions: n.plan.resolvedRevisions.map((rev) => ({
        refId: rev.refId,
        kind: rev.kind,
        sha: rev.sha,
        trustStatus: rev.trustStatus,
      })),
      enforcedClasses: n.plan.enforcedClasses,
      instructedClasses: n.plan.instructedClasses,
      refusedClasses: n.plan.refusedClasses,
      cleanupFailed: n.plan.cleanup.status === "failed",
    })) ?? [];

  const canClaim =
    detail.status === "NeedsInput" &&
    offersTakeover(detail.pendingHitl?.schema);
  const isHumanWorking = detail.status === "HumanWorking";

  // M18 (T4.2): the base→run→target review surface for a flow run at `Review`.
  const showReview = detail.status === "Review" && detail.runKind === "flow";
  let reviewData: Awaited<ReturnType<typeof buildReviewPanelData>> | null =
    null;
  let reviewReadiness = null;

  if (showReview) {
    try {
      reviewData = await buildReviewPanelData(detail);
    } catch (err) {
      // A derivation failure that is not a clean legacy-relaunch case (e.g. the
      // worktree is gone): fall back to the relaunch state rather than crash.
      if (isMaisterError(err)) {
        reviewData = {
          baseBranch: detail.baseBranch,
          baseCommit: detail.baseCommit,
          targetBranch: null,
          reviewedTargetCommit: null,
          promotionMode:
            detail.promotionMode === "pull_request"
              ? "pull_request"
              : "local_merge",
          diff: EMPTY_DIFF,
          driftDetected: false,
          legacyNeedsRelaunch: true,
        };
      } else {
        throw err;
      }
    }

    reviewReadiness = await getRunReadiness(detail.runId, detail.projectId);
  }

  const reviewLabels: ReviewPanelLabels = {
    promoteTo: t("promoteTo"),
    promotionMode: t("promotionMode"),
    readinessReady: t("readinessReady"),
    readinessBlocked: t("readinessBlocked"),
    prLink: t("prLink"),
    targetDrift: t("targetDrift"),
    promoteAnyway: t("promoteAnyway"),
    diffTruncated: t("diffTruncated"),
    promoteTruncated: t("promoteTruncated"),
  };

  const timelineLabels: TimelineLabels = {
    title: t("timelineTitle"),
    staleGate: t("staleGate"),
    currentGate: t("currentGate"),
    rerunRequired: t("rerunRequired"),
    handoff: t("handoff"),
    claimedBy: t("claimedBy"),
    elapsed: t("elapsed"),
    returnedCommits: t("returnedCommits"),
    returnedDiff: t("returnedDiff"),
    assignmentLedger: t("assignmentLedger"),
    assignmentActor: t("assignmentActor"),
    assignmentSystemActor: t("assignmentSystemActor"),
    empty: t("timelineEmpty"),
    decisionLabel: (d) =>
      d === "approve"
        ? t("decisionApprove")
        : d === "rework"
          ? t("decisionRework")
          : d === "takeover"
            ? t("takeOver")
            : d,
  };

  return (
    <div className="mx-auto max-w-[760px]">
      <Link
        className="font-mono text-[11px] text-mute hover:text-ink"
        href={`/projects/${detail.projectSlug}`}
      >
        {t("backToBoard")}
      </Link>

      <header className="mb-6 mt-3 border-b border-line pb-5">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")} · {detail.projectSlug}
        </div>
        <h1 className="mt-1 font-mono text-[20px] font-bold tracking-[-0.01em] text-ink">
          {detail.branch}
        </h1>
        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-mute">
          <span className="rounded-full border border-line bg-ivory px-2.5 py-1 text-ink-2">
            {detail.status}
          </span>
          <span>{detail.agent}</span>
          {detail.currentStepId ? (
            <span>
              {t("step")} · {detail.currentStepId}
            </span>
          ) : null}
        </div>
        {detail.lifecycleActions.length > 0 ? (
          <WorkbenchLifecycleActions
            actions={detail.lifecycleActions}
            className="mt-4"
            runId={detail.runId}
            runKind={detail.runKind}
            variant="detail"
          />
        ) : null}
      </header>

      {readiness ? (
        <div className="mb-6">
          <ReadinessSummary
            labels={{
              state: {
                ready: tReadiness("ready"),
                blocked: tReadiness("blocked"),
                stale: tReadiness("stale"),
                failed: tReadiness("failed"),
                waiting: tReadiness("waiting"),
                overridden: tReadiness("overridden"),
              },
              summary: tReadiness("summary"),
              reasons: tReadiness("reasons"),
            }}
            reasons={readiness.reasons}
            state={readiness.readiness}
          />
        </div>
      ) : null}

      {detail.status === "Crashed" ? (
        <section
          className="mb-6 rounded-[14px] border border-red-300 bg-red-50/60 p-5 dark:border-red-900/60 dark:bg-red-950/30"
          data-testid="run-crashed-section"
        >
          <h2 className="mb-1 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-red-500 before:content-['']">
            {t("crashTitle")}
          </h2>
          {detail.recoverable ? (
            <p className="mb-4 text-[13px] leading-[1.4] text-body">
              {t("crashRecoverableHint")}
            </p>
          ) : (
            <p
              className="mb-4 text-[13px] leading-[1.4] text-body"
              data-testid="run-not-recoverable"
            >
              {t("notRecoverable")}
            </p>
          )}
          {/* Discard is available for EVERY Crashed run (it is the only path
              into the GC countdown); Recover is hidden when there is no
              resumable session. */}
          <RunRecoverActions
            canRecover={detail.recoverable}
            runId={detail.runId}
          />
        </section>
      ) : null}

      {detail.pendingHitl ? (
        (() => {
          const staleText = staleSummaryText(
            detail.pendingHitl.assignmentStaleEvidenceSummary,
          );

          return (
            <section className="rounded-[14px] border border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-5">
              <h2 className="mb-1 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
                {t("pendingTitle")}
              </h2>
              <p className="mb-4 text-[14px] leading-[1.4] text-ink">
                {detail.pendingHitl.prompt}
              </p>
              <div className="mb-4 flex flex-wrap gap-2 font-mono text-[10.5px] tracking-[0.02em] text-mute">
                {detail.pendingHitl.assignmentActionKind ? (
                  <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-ink-2">
                    {t("assignmentAction", {
                      action: detail.pendingHitl.assignmentActionKind,
                    })}
                  </span>
                ) : null}
                {detail.pendingHitl.assignmentRoleRefs.length > 0 ? (
                  <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-ink-2">
                    {t("assignmentRoles", {
                      roles: detail.pendingHitl.assignmentRoleRefs.join(", "),
                    })}
                  </span>
                ) : null}
                {staleText ? (
                  <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-amber">
                    {t("assignmentStaleEvidence", {
                      count: staleText,
                    })}
                  </span>
                ) : null}
                <span className="rounded-md border border-amber-line bg-paper px-2 py-1 font-semibold text-ink-2">
                  {detail.pendingHitl.assigneeLabel
                    ? t("assignmentClaimedBy", {
                        actor: detail.pendingHitl.assigneeLabel,
                      })
                    : t("assignmentUnclaimed")}
                </span>
              </div>
              <div className="mb-4 flex flex-wrap gap-2">
                <AssignmentActions
                  assigneeUserId={detail.pendingHitl.assigneeUserId}
                  assignmentId={detail.pendingHitl.assignmentId}
                  canAct={canAct}
                  currentUserId={user.id}
                  labels={{
                    claim: t("assignmentClaim"),
                    release: t("assignmentRelease"),
                    takeOver: t("assignmentTakeOver"),
                  }}
                  status={detail.pendingHitl.assignmentStatus}
                />
              </div>
              <RunHitlResponse
                canAct={canAct}
                criticality={detail.pendingHitl.criticality}
                hitlRequestId={detail.pendingHitl.hitlRequestId}
                kind={detail.pendingHitl.kind}
                options={detail.pendingHitl.options}
                runId={detail.runId}
                schema={detail.pendingHitl.schema}
              />
              {canClaim ? (
                <div className="mt-4 border-t border-dashed border-amber-line pt-4">
                  <RunTakeoverActions
                    branch={detail.branch}
                    canAct={canAct}
                    isOwner={false}
                    mode="claimable"
                    runId={detail.runId}
                    worktreePath={detail.worktreePath}
                  />
                </div>
              ) : null}
            </section>
          );
        })()
      ) : (
        <p className="rounded-[14px] border border-dashed border-line p-6 text-center font-mono text-[12px] text-mute">
          {t("noPending")}
        </p>
      )}

      {isHumanWorking ? (
        <section className="mt-6 rounded-[14px] border border-[color-mix(in_oklab,var(--accent-4)_30%,var(--line))] bg-accent-4-soft/30 p-5">
          <h2 className="mb-3 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-accent-4 before:content-['']">
            {t("handoff")}
          </h2>
          <RunTakeoverActions
            branch={detail.branch}
            canAct={canAct}
            isOwner={detail.takeoverOwnerUserId === user.id}
            mode="working"
            runId={detail.runId}
            worktreePath={detail.worktreePath}
          />
        </section>
      ) : null}

      <RunTimeline
        assignmentEvents={timeline.assignmentEvents}
        entries={timeline.entries as TimelineEntry[]}
        labels={timelineLabels}
      />

      <section className="mt-6">
        <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
          {evidenceLabels.title}
        </h2>
        <EvidenceGraphSection
          graph={evidence}
          labels={evidenceLabels}
          runId={detail.runId}
        />
      </section>

      {flowGraphData ? (
        <section className="mt-6" data-testid="run-workbench">
          <WorkbenchPanel
            diff={
              <RunDiff labels={flowGraphData.diffLabels} runId={detail.runId} />
            }
            filesPane={children}
            filesTree={
              <FileTree
                filesApiBase={`/api/runs/${detail.runId}/files`}
                labels={flowGraphData.filesLabels}
              />
            }
            graph={
              <FlowGraphViewSection
                currentStepId={flowGraphData.statuses.currentStepId}
                initialStatuses={flowGraphData.statuses.nodes}
                labels={flowGraphData.labels}
                layout={flowGraphData.layout}
                runId={detail.runId}
                runStatus={detail.status}
                topology={flowGraphData.topology}
              />
            }
            runId={detail.runId}
            tabLabels={flowGraphData.tabLabels}
          />
        </section>
      ) : null}

      {settings ? (
        <FlowSettingsPanel
          labels={settingsLabels}
          nodes={settings.nodes}
          refusalReason={settings.refusalReason}
        />
      ) : null}

      {capabilityProfiles ? (
        <CapabilityProfilePanel
          labels={capabilityLabels}
          nodes={capabilityNodes}
        />
      ) : null}

      {resolvedSet ? (
        <ResolvedCapabilitySetPanel
          labels={resolvedSetLabels}
          resolved={resolvedSet}
        />
      ) : null}

      {showReview && reviewData ? (
        <ReviewPanel
          baseBranch={reviewData.baseBranch}
          baseCommit={reviewData.baseCommit}
          canPromote={canAct}
          diff={reviewData.diff}
          driftDetected={reviewData.driftDetected}
          labels={reviewLabels}
          legacyNeedsRelaunch={reviewData.legacyNeedsRelaunch}
          parentRepoPath={detail.parentRepoPath}
          prNumber={detail.prNumber}
          prUrl={detail.prUrl}
          promotionMode={reviewData.promotionMode}
          readiness={reviewReadiness}
          reviewedTargetCommit={reviewData.reviewedTargetCommit}
          runBranch={detail.branch}
          runId={detail.runId}
          targetBranch={reviewData.targetBranch}
        />
      ) : null}
    </div>
  );
}
