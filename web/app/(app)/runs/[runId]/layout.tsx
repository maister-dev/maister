import type { EnforcementSnapshotEntry } from "@/lib/db/schema";
import type { FlowResultDegradationCode } from "@/lib/runs/flow-result-dto";
import type { ReactElement, ReactNode } from "react";

import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

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
import {
  AgentRunCenter,
  type AgentRunCenterLabels,
  shouldRenderAgentRunCenter,
} from "@/components/runs/agent-run-center";
import {
  FlowRunCenter,
  type FlowRunCenterLabels,
} from "@/components/runs/flow-run-center";
import { LiveRunInspector } from "@/components/runs/live-run-inspector";
import {
  OrchestratorRunSubtree,
  type OrchestratorRunSubtreeLabels,
} from "@/components/runs/orchestrator-run-subtree";
import {
  type RunInspectorAction,
  type RunInspectorChangeSummary,
  type RunInspectorChildRun,
  type RunInspectorChildRunsLabels,
  type RunInspectorFlowSummary,
  type RunInspectorLabels,
} from "@/components/runs/run-inspector";
import { ReadinessSummary } from "@/components/run/readiness-summary";
import {
  ResolvedCapabilitySetPanel,
  type ResolvedCapabilitySetLabels,
} from "@/components/runs/resolved-capability-set-panel";
import { RunShell, type RunShellLabels } from "@/components/runs/run-shell";
import { ExecutionPolicyBadge } from "@/components/runs/execution-policy-badge";
import {
  ReviewPanel,
  type ReviewPanelDiff,
  type ReviewPanelLabels,
} from "@/components/runs/review-panel";
import FileTree, {
  type FileTreeLabels,
} from "@/components/workbench/file-tree";
import { WorkbenchLifecycleActions } from "@/components/workbench/lifecycle-actions";
import RunDiff, {
  type RunDiffLabels,
  type RunDiffReviewContext,
  type RunDiffScopeLabels,
} from "@/components/workbench/run-diff";
import { WorkbenchPanel } from "@/components/workbench/workbench-panel";
import { type WorkbenchTabsLabels } from "@/components/workbench/workbench-tabs";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { prepareDiff } from "@/lib/diff/prepare";
import { reposRoot, worktreesRoot } from "@/lib/instance-config";
import {
  formatProjectRepoPath,
  formatRunWorktreePath,
} from "@/lib/project-path-display";
import { compileManifest } from "@/lib/flows/graph/compile";
import { isHumanReviewGate } from "@/lib/flows/review-gate";
import {
  getReviewGateThreadCounts,
  type ReviewThreadCounts,
} from "@/lib/review-comments/run-diff-source";
import { PENDING_HITL_RUN_STATUS } from "@/lib/services/hitl";
import { buildEvidenceGraph } from "@/lib/queries/evidence-graph";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { getRunReadiness } from "@/lib/queries/readiness";
import {
  getChildRuns,
  getRunCapabilityProfiles,
  getRunCostSummary,
  getRunDetail,
  getRunResolvedCapabilitySet,
  getRunSettings,
  getRunTimeline,
} from "@/lib/queries/run";
import {
  diffRange,
  resolveBaseCommit,
  resolveBaseRef,
  statusPorcelain,
} from "@/lib/worktree";
import { deliveryPolicyFromLegacyPromotionMode } from "@/lib/runs/delivery-policy";
import {
  computeDirtySummary,
  type DirtySummary,
} from "@/lib/runs/dirty-resolution";
import { buildFlowRunResultReadModel } from "@/lib/runs/flow-result-read-model";
import { getRunChangeSummary } from "@/lib/runs/change-summary";
import {
  deriveInspectorActions,
  type InspectorActionId,
} from "@/lib/runs/inspector-actions";
import { type WorkbenchRunStatus } from "@/lib/workbench-lifecycle/policy";
import { RUN_STATUS_KEYS, type RunStatusKey } from "@/lib/runs/run-status-tone";
import { DirtyResolutionBanner } from "@/components/runs/dirty-resolution-banner";
import { DeliveryPolicyCancelButton } from "@/components/runs/delivery-policy-cancel-button";
import { GateChatPanel } from "@/components/runs/gate-chat-panel";

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ runId: string }>;
};

type RunDetailForReview = Awaited<ReturnType<typeof getRunDetail>> & object;

// Resolve the ReviewPanel props for a workspace-backed run at `Review`. Legacy-row safe
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
  promotionMode: "merge" | "rebase_merge" | "pull_request" | "ai_rebase_merge";
  deliveryPolicy: {
    strategy: "merge" | "rebase_merge" | "pull_request" | "ai_rebase_merge";
    push: "never" | "on_success";
    trigger: "manual" | "auto_on_ready";
    targetBranch: string;
  };
  diff: ReviewPanelDiff;
  driftDetected: boolean;
  legacyNeedsRelaunch: boolean;
}> {
  const targetBranch = detail.targetBranch ?? detail.projectMainBranch;
  const deliveryPolicy =
    detail.deliveryPolicySnapshot ??
    deliveryPolicyFromLegacyPromotionMode({
      projectPromotionMode: detail.promotionMode,
      projectMainBranch: targetBranch,
    });
  const promotionMode = deliveryPolicy.strategy;

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
        deliveryPolicy,
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
    deliveryPolicy,
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

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "-";
  const seconds = Math.round(durationMs / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  return `${Math.round(minutes / 60)}h`;
}

function workbenchRunStatus(status: string): WorkbenchRunStatus {
  const statuses: readonly WorkbenchRunStatus[] = [
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "HumanWorking",
    "Review",
    "Crashed",
    "Done",
    "Abandoned",
    "Failed",
  ];

  return statuses.includes(status as WorkbenchRunStatus)
    ? (status as WorkbenchRunStatus)
    : "Failed";
}

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
  const costSummary = await getRunCostSummary(runId);
  const settings = await getRunSettings(runId);
  const capabilityProfiles = await getRunCapabilityProfiles(runId);
  const resolvedSet = await getRunResolvedCapabilitySet(runId);
  const evidence = await buildEvidenceGraph(runId);
  const readiness = await getRunReadiness(runId, detail.projectId);
  // M37 Phase 6 (ADR-098): the orchestrator run-tree children. Empty for an
  // ordinary run — the subtree/inspector sections then render nothing.
  const childRuns = await getChildRuns(runId);
  const tRunStatus = await getTranslations("run.runStatus");
  const runStatusLabels = Object.fromEntries(
    RUN_STATUS_KEYS.map((key) => [key, tRunStatus(key)]),
  ) as Record<RunStatusKey, string>;
  const orchestratorSubtreeLabels: OrchestratorRunSubtreeLabels = {
    title: (count: number) => t("subtreeTitle", { count }),
    agent: t("subtreeAgent"),
    asRun: t("subtreeAsRun"),
    status: runStatusLabels,
    empty: t("subtreeEmpty"),
  };
  const inspectorChildRuns: RunInspectorChildRun[] = childRuns.map((child) => ({
    runId: child.runId,
    status: child.status,
    taskRef:
      child.taskKey !== null && child.taskNumber !== null
        ? `${child.taskKey}-${child.taskNumber}`
        : null,
  }));
  const inspectorChildRunsLabels: RunInspectorChildRunsLabels = {
    title: (count: number) => t("spawnedRunsTitle", { count }),
    asRun: t("subtreeAsRun"),
    status: runStatusLabels,
  };
  const tEvidence = await getTranslations("evidence");
  const tReadiness = await getTranslations("readiness");
  const tWorkbench = await getTranslations("workbench");

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
    artifactKindMutationReport: tEvidence("artifactKindMutationReport"),
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
  const workbenchDiffScopeLabels: RunDiffScopeLabels = {
    label: tWorkbench("diff.scope.label"),
    run: tWorkbench("diff.scope.run"),
    sinceLastReview: tWorkbench("diff.scope.sinceLastReview"),
    lastNode: tWorkbench("diff.scope.lastNode"),
    uncommitted: tWorkbench("diff.scope.uncommitted"),
  };
  const flowGraphLabels: FlowGraphViewLabels = {
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
      form: tWorkbench("graph.role.form"),
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

  // M37 Phase 6 (ADR-098): true when the run's current node is an orchestrator —
  // drives the run-tree subtree even before the first child spawns.
  let currentNodeIsOrchestrator = false;

  if (detail.runKind === "flow") {
    const loadedM = await loadRunManifest(runId);

    if (loadedM) {
      const compiled = compileManifest(loadedM.manifest);
      const topology = buildGraphTopology(compiled);
      const graphLayout = presentationLayout(loadedM.manifest);
      const nodeStatuses = await getRunNodeStatuses(runId);

      if (detail.currentStepId) {
        currentNodeIsOrchestrator =
          compiled.nodes.get(detail.currentStepId)?.nodeType === "orchestrator";
      }

      flowGraphData = {
        topology,
        layout: graphLayout,
        statuses: nodeStatuses,
        labels: flowGraphLabels,
        tabLabels: workbenchTabLabels,
        filesLabels: workbenchFilesLabels,
        diffLabels: workbenchDiffLabels,
      };
    }
  }

  const isOrchestratorRun = childRuns.length > 0 || currentNodeIsOrchestrator;

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

  // ADR-071 Task 13: review-gate panel data — thread counts + the RunDiff
  // review context. Computed ONLY when the pending gate is a human review
  // gate (one threads query + at most one diff prep, per the D5 perf rule);
  // every other run pays nothing.
  const hasReviewGate =
    flowGraphData !== null && isHumanReviewGate(detail.pendingHitl);
  let reviewGateCounts: ReviewThreadCounts | null = null;
  let gateDiffReview: RunDiffReviewContext | undefined;
  const flowResultDegradations: FlowResultDegradationCode[] = [];

  // M30 (ADR-082): pre-review dirty detection — no auto-commit, the gate is
  // never blocked. Best-effort: a gone/non-git worktree simply hides the
  // banner.
  let dirtySummary: DirtySummary | null = null;

  if (
    hasReviewGate &&
    (detail.status === "NeedsInput" || detail.status === "NeedsInputIdle")
  ) {
    try {
      const porcelain = await statusPorcelain({
        worktreePath: detail.worktreePath,
      });
      const summary = computeDirtySummary(porcelain);

      dirtySummary = summary.total > 0 ? summary : null;
    } catch {
      dirtySummary = null;
      flowResultDegradations.push("dirty-summary-unavailable");
    }
  }

  if (hasReviewGate) {
    reviewGateCounts = await getReviewGateThreadCounts(
      detail.runId,
      detail.projectId,
    );

    gateDiffReview = {
      currentUserId: user.id,
      // Composing requires answerHitl (member+, same predicate the routes
      // enforce) AND an actually-open gate: HumanWorking parks the pending
      // hitl row but closes the write window (service guard allow-list).
      canComment: canAct && PENDING_HITL_RUN_STATUS.has(detail.status),
      labels: {
        composerPlaceholder: tWorkbench("diff.review.composerPlaceholder"),
        composerSubmit: tWorkbench("diff.review.submit"),
        composerCancel: tWorkbench("diff.review.cancel"),
        reply: tWorkbench("diff.review.reply"),
        edit: tWorkbench("diff.review.edit"),
        delete: tWorkbench("diff.review.delete"),
        resolve: tWorkbench("diff.review.resolve"),
        unresolve: tWorkbench("diff.review.unresolve"),
        resolved: tWorkbench("diff.review.resolved"),
        iteration: tWorkbench("diff.review.iteration"),
        expand: tWorkbench("diff.review.expand"),
        collapse: tWorkbench("diff.review.collapse"),
        outdatedTitle: tWorkbench("diff.review.outdatedTitle"),
        sideOld: tWorkbench("diff.review.sideOld"),
        sideNew: tWorkbench("diff.review.sideNew"),
        error: tWorkbench("diff.review.error"),
      },
    };
  }

  // M18/M34: the base→run→target review surface for workspace-backed runs at
  // `Review`. Scratch keeps its conversation-specific promote affordance.
  const showReview =
    detail.status === "Review" &&
    (detail.runKind === "flow" || detail.runKind === "agent");
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
        const fallbackPolicy =
          detail.deliveryPolicySnapshot ??
          deliveryPolicyFromLegacyPromotionMode({
            projectPromotionMode: detail.promotionMode,
            projectMainBranch: detail.targetBranch ?? detail.projectMainBranch,
          });

        reviewData = {
          baseBranch: detail.baseBranch,
          baseCommit: detail.baseCommit,
          targetBranch: null,
          reviewedTargetCommit: null,
          promotionMode: fallbackPolicy.strategy,
          deliveryPolicy: fallbackPolicy,
          diff: EMPTY_DIFF,
          driftDetected: false,
          legacyNeedsRelaunch: true,
        };
        flowResultDegradations.push("review-diff-fallback");
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
    promotionMerge: t("promotionMerge"),
    promotionRebaseMerge: t("promotionRebaseMerge"),
    promotionPullRequest: t("promotionPullRequest"),
    promotionAiRebaseMerge: t("promotionAiRebaseMerge"),
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
    duration: t("duration"),
    tokenTotal: t("tokenTotal"),
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
  const agentRunCenterLabels: AgentRunCenterLabels = {
    title: t("agentCenterTitle"),
    subtitle: t("agentCenterSubtitle"),
    status: t("agentCenterStatus"),
    runner: t("agentCenterRunner"),
    latestActivity: t("agentCenterLatestActivity"),
    noActivity: t("agentCenterNoActivity"),
    evidence: t("agentCenterEvidence"),
    terminal: t("agentCenterTerminal"),
    reviewChanges: t("agentCenterReviewChanges"),
    openDiff: t("agentCenterOpenDiff"),
  };
  const flowRunCenterLabels: FlowRunCenterLabels = {
    title: t("flowCenterTitle"),
    fullscreen: t("flowCenterFullscreen"),
    reviewChanges: t("flowCenterReviewChanges"),
    nodes: t("flowCenterNodes"),
    selectedNode: t("flowCenterSelectedNode"),
    currentNode: t("flowCenterCurrentNode"),
    status: t("flowCenterStatus"),
    attempt: t("flowCenterAttempt"),
    attempts: t("flowCenterAttempts"),
    gates: t("flowCenterGates"),
    artifacts: t("flowCenterArtifacts"),
    hitl: t("flowCenterHitl"),
    review: t("flowCenterReview"),
    readiness: t("flowCenterReadiness"),
    failed: t("flowCenterFailed"),
    reworked: t("flowCenterReworked"),
    openThreads: t("flowCenterOpenThreads"),
    outdatedThreads: t("flowCenterOutdatedThreads"),
    options: t("flowCenterOptions"),
    tokens: t("flowCenterTokens"),
    prompt: t("flowCenterPrompt"),
    promptCopy: t("flowCenterPromptCopy"),
    noGraph: t("flowCenterNoGraph"),
    noNode: t("flowCenterNoNode"),
  };
  const activeDurationMs = timeline.entries.reduce<number>(
    (sum, entry) => sum + (entry.durationMs ?? 0),
    0,
  );

  const flowResultDto = buildFlowRunResultReadModel({
    run: {
      runId: detail.runId,
      projectId: detail.projectId,
      projectSlug: detail.projectSlug,
      taskNumber: detail.taskNumber,
      taskRef: detail.taskRef,
      status: detail.status,
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
      currentStepId: detail.currentStepId,
      branch: detail.branch,
      agent: detail.agent,
      runKind: detail.runKind,
      recoverable: detail.recoverable,
      takeoverOwnerUserId: detail.takeoverOwnerUserId,
      ttlState: detail.ttlState,
      effectiveRemovalAt: detail.effectiveRemovalAt,
      archived: detail.archived,
      pruned: detail.pruned,
      baseBranch: detail.baseBranch,
      baseCommit: detail.baseCommit,
      targetBranch: detail.targetBranch,
      prUrl: detail.prUrl,
      prNumber: detail.prNumber,
    },
    graph: flowGraphData
      ? {
          topology: flowGraphData.topology,
          layout: flowGraphData.layout,
          statuses: flowGraphData.statuses,
        }
      : null,
    timeline,
    evidence,
    readiness,
    cost: costSummary,
    settings,
    pendingHitl: detail.pendingHitl,
    dirtySummary,
    review: reviewData
      ? {
          baseBranch: reviewData.baseBranch,
          baseCommit: reviewData.baseCommit,
          targetBranch: reviewData.targetBranch,
          reviewedTargetCommit: reviewData.reviewedTargetCommit,
          promotionMode: reviewData.promotionMode,
          deliveryPolicy: reviewData.deliveryPolicy,
          diff: reviewData.diff,
          driftDetected: reviewData.driftDetected,
          legacyNeedsRelaunch: reviewData.legacyNeedsRelaunch,
        }
      : null,
    reviewGate: {
      active: hasReviewGate,
      canComment: canAct && PENDING_HITL_RUN_STATUS.has(detail.status),
      threadCounts: reviewGateCounts,
    },
    capabilityNodes,
    resolvedCapabilitySet: resolvedSet,
    degradations: flowResultDegradations,
    nowMs: Date.now(),
  });
  const showAgentCenter = shouldRenderAgentRunCenter(flowResultDto);

  const wallDurationMs = detail.endedAt
    ? Math.max(0, detail.endedAt.getTime() - detail.startedAt.getTime())
    : Math.max(0, Date.now() - detail.startedAt.getTime());
  const policy = detail.deliveryPolicySnapshot;
  const displayWorktreePath = formatRunWorktreePath(
    detail.worktreePath,
    worktreesRoot(),
  );
  const displayParentRepoPath = formatProjectRepoPath(
    detail.parentRepoPath,
    reposRoot(),
  );
  const dirtyDiffHref = `/runs/${detail.runId}?wb=diff&scope=uncommitted`;
  const inspectorChangeScope = dirtySummary ? "uncommitted" : "run";
  let changeSummary: RunInspectorChangeSummary | null = null;

  try {
    changeSummary = await getRunChangeSummary({
      runId: detail.runId,
      scope: inspectorChangeScope,
    });
  } catch (err) {
    if (!isMaisterError(err)) throw err;

    changeSummary = unavailableChangeSummary(t("inspectorUnavailable"));
  }

  const shellLabels: RunShellLabels = {
    branch: t("headerBranch"),
    changes: t("headerChanges"),
    changesUnavailable: t("headerChangesUnavailable"),
    changedFiles: t("headerChangedFilesUnit"),
    openInspector: t("headerOpenInspector"),
    closeInspector: t("headerCloseInspector"),
    task: t("headerTask"),
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
  const inspectorFacts = [
    { label: t("flowCenterStatus"), value: detail.status },
    { label: t("agentCenterRunner"), value: detail.agent },
    { label: t("inspectorRunKind"), value: detail.runKind },
    { label: t("headerBranch"), value: detail.branch },
    { label: t("baseBranch"), value: detail.baseBranch ?? "-" },
    { label: t("targetBranch"), value: detail.targetBranch ?? "-" },
    {
      label: t("inspectorWorktree"),
      value: detail.pruned
        ? `${displayWorktreePath} (${t("inspectorWorktreeRemoved")})`
        : detail.archived
          ? `${displayWorktreePath} (${t("inspectorWorktreeArchived")})`
          : displayWorktreePath,
    },
    ...(detail.prNumber !== null || detail.prUrl
      ? [
          {
            label: t("prLink"),
            value:
              detail.prNumber !== null
                ? `#${detail.prNumber}`
                : (detail.prUrl ?? "-"),
          },
        ]
      : []),
    {
      label: t("costSummaryTitle"),
      value: formatTokens(costSummary.totalTokens),
    },
    { label: t("activeTime"), value: formatDuration(activeDurationMs) },
    { label: t("wallClock"), value: formatDuration(wallDurationMs) },
    {
      label: t("deliveryPolicyTitle"),
      value: policy
        ? `${policy.strategy} / ${policy.push} / ${policy.trigger}`
        : t("policyLegacy"),
    },
    {
      label: t("executionPolicyTitle"),
      value: detail.executionPolicy
        ? `${detail.executionPolicy.preset}${detail.executionPolicy.overrides ? " *" : ""}`
        : "supervised",
    },
    {
      label: t("settingsTitle"),
      value: settings ? String(settings.nodes.length) : "-",
    },
    {
      label: t("capabilityTitle"),
      value: capabilityNodes.length > 0 ? String(capabilityNodes.length) : "-",
    },
    {
      label: t("resolvedSet.title"),
      value: resolvedSet ? String(resolvedSet.capabilities.length) : "-",
    },
  ];
  const timelineByNode = new Map(
    timeline.entries.map((entry) => [entry.nodeId, entry]),
  );
  const flowSummary: RunInspectorFlowSummary | null =
    flowResultDto.graph.kind === "ready"
      ? {
          title: t("flowCenterTitle"),
          subtitle: t("inspectorFlowSubtitle", {
            count: flowResultDto.graph.nodeCount,
          }),
          nodes: flowResultDto.graph.nodes.map((node) => {
            const entry = timelineByNode.get(node.id);
            const tokenTotal = timeline.entries
              .filter((candidate) => candidate.nodeId === node.id)
              .reduce((sum, candidate) => sum + candidate.tokens.total, 0);

            return {
              id: node.id,
              label: node.displayLabel,
              status: node.runtimeStatus,
              current: node.current,
              durationLabel: entry ? formatDuration(entry.durationMs) : null,
              tokenLabel:
                tokenTotal > 0
                  ? `${formatTokens(tokenTotal)} ${t("flowCenterTokens")}`
                  : null,
            };
          }),
        }
      : showAgentCenter
        ? {
            title: t("agentCenterTitle"),
            subtitle: t("agentCenterSubtitle"),
            nodes: flowResultDto.timeline.entries.slice(-5).map((entry) => ({
              id: entry.nodeAttemptId,
              label: entry.nodeId,
              status: entry.status,
              current: false,
              durationLabel: formatDuration(entry.durationMs),
              tokenLabel:
                entry.tokens.total > 0
                  ? `${formatTokens(entry.tokens.total)} ${t("flowCenterTokens")}`
                  : null,
            })),
          }
        : null;
  const inspectorActionLabels: Record<InspectorActionId, string> = {
    stop: t("inspectorActionStop"),
    recover: t("inspectorActionRecover"),
    snapshotCommit: t("inspectorActionSnapshotCommit"),
    exportBranch: t("inspectorActionExportBranch"),
    handoffBranch: t("inspectorActionHandoffBranch"),
    promote: t("inspectorActionPromote"),
    promotePullRequest: t("inspectorActionPromotePullRequest"),
    archive: t("inspectorActionArchive"),
    drop: t("inspectorActionDrop"),
  };
  const deliveryMode =
    reviewData?.deliveryPolicy.strategy === "pull_request"
      ? "pull_request"
      : showReview
        ? "local"
        : null;
  const policyActions = deriveInspectorActions({
    runId: detail.runId,
    runKind: detail.runKind,
    runStatus: workbenchRunStatus(detail.status),
    scratchDialogStatus: null,
    hasWorkspace: Boolean(detail.worktreePath),
    workspaceRemoved: detail.pruned,
    workspaceArchived: detail.archived,
    recoverable: detail.recoverable,
    canPromote: canAct && showReview,
    reviewReady: reviewReadiness?.readiness === "ready",
    targetDriftDetected: reviewData?.driftDetected ?? false,
    diffTruncated: reviewData?.diff.truncated ?? false,
    reviewedTargetCommit: reviewData?.reviewedTargetCommit ?? null,
    deliveryMode,
  }).map<RunInspectorAction>((action) => ({
    id: action.id,
    label: inspectorActionLabels[action.id],
    disabled: !action.enabled,
    disabledReason: action.enabled ? null : t("inspectorDisabled"),
  }));
  const visiblePolicyActions = policyActions.filter(
    (action) =>
      !action.disabled ||
      (detail.status === "Crashed" && action.id === "recover"),
  );
  const pendingInputActions: RunInspectorAction[] = detail.pendingHitl
    ? [
        {
          id: "openPendingInput",
          label: t("inspectorActionOpenPendingInput"),
          href: "#pending-input",
        },
      ]
    : [];
  const gateChatActions: RunInspectorAction[] =
    detail.pendingHitl &&
    (detail.pendingHitl.kind === "human" || detail.pendingHitl.kind === "form")
      ? [
          {
            id: "openAgentChat",
            label: t("inspectorActionOpenAgentChat"),
            href: "#agent-chat",
          },
        ]
      : [];
  const dirtyGateActions: RunInspectorAction[] = dirtySummary
    ? [
        {
          id: "viewUncommittedDiff",
          label: t("inspectorActionViewUncommittedDiff"),
          href: dirtyDiffHref,
        },
      ]
    : [];
  const inspectorActions: RunInspectorAction[] = [
    ...dirtyGateActions,
    ...pendingInputActions,
    ...gateChatActions,
    ...(showReview
      ? [
          {
            id: "reviewChanges",
            label: t("flowCenterReviewChanges"),
            href: `/runs/${detail.runId}?wb=diff`,
          },
        ]
      : []),
    ...visiblePolicyActions,
  ];
  const currentNodeLabel =
    flowGraphData?.topology.nodes.find((n) => n.id === detail.currentStepId)
      ?.displayLabel ?? null;
  const shellTitle = detail.taskTitle ?? detail.taskRef ?? detail.branch;
  const shellSubtitle = detail.flowRef
    ? `${detail.flowRef}${currentNodeLabel ? ` › ${currentNodeLabel}` : ""}`
    : `${t("eyebrow")} / ${detail.projectSlug}`;

  return (
    <RunShell
      branch={detail.branch}
      changeSummary={changeSummary}
      inspector={
        <LiveRunInspector
          actions={inspectorActions}
          changeScope={inspectorChangeScope}
          changeSummary={changeSummary}
          childRuns={inspectorChildRuns}
          childRunsLabels={inspectorChildRunsLabels}
          facts={inspectorFacts}
          flowSummary={flowSummary}
          labels={inspectorLabels}
          runId={detail.runId}
          runStatus={detail.status}
          search={changeSummary?.dirty ? "scope=uncommitted" : ""}
        />
      }
      keyRef={detail.taskRef}
      labels={shellLabels}
      projectHref={`/projects/${detail.projectSlug}`}
      projectLabel={t("backToBoard")}
      status={detail.status}
      subtitle={shellSubtitle}
      targetBranch={detail.targetBranch}
      taskHref={
        detail.taskNumber != null
          ? `/projects/${detail.projectSlug}/tasks/${detail.taskNumber}`
          : null
      }
      taskPrompt={detail.taskPrompt}
      title={shellTitle}
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <ExecutionPolicyBadge
            labels={{
              supervised: t("execPolicySupervised"),
              assisted: t("execPolicyAssisted"),
              unattended: t("execPolicyUnattended"),
              custom: t("execPolicyCustom"),
            }}
            policy={detail.executionPolicy}
          />
        </div>

        {detail.lifecycleActions.length > 0 ? (
          <WorkbenchLifecycleActions
            actions={detail.lifecycleActions}
            runId={detail.runId}
            runKind={detail.runKind}
            variant="detail"
          />
        ) : null}

        {readiness ? (
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
        ) : null}

        {policy?.trigger === "auto_on_ready" && detail.status === "Review" ? (
          <section
            className="rounded-[10px] border border-amber-line bg-amber-soft p-4"
            data-testid="run-delivery-policy-auto"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 font-mono text-[11px] text-amber">
                {t("policyAutoBanner")}
              </p>
              <DeliveryPolicyCancelButton
                labels={{
                  cancel: t("policyCancelAuto"),
                  cancelling: t("policyCancelling"),
                  error: t("policyCancelError"),
                }}
                runId={detail.runId}
              />
            </div>
          </section>
        ) : null}

        {flowGraphData || showAgentCenter ? (
          <section data-testid="run-primary-result">
            {flowGraphData ? (
              <FlowRunCenter
                graphView={
                  <FlowGraphViewSection
                    labels={flowGraphData.labels}
                    layout={flowGraphData.layout}
                    runContext={{
                      runId: detail.runId,
                      initialStatuses: flowGraphData.statuses.nodes,
                      currentStepId: flowGraphData.statuses.currentStepId,
                      runStatus: detail.status,
                    }}
                    topology={flowGraphData.topology}
                  />
                }
                labels={flowRunCenterLabels}
                result={flowResultDto}
              />
            ) : (
              <AgentRunCenter
                labels={agentRunCenterLabels}
                result={flowResultDto}
              />
            )}
            {isOrchestratorRun ? (
              <OrchestratorRunSubtree
                childRuns={childRuns}
                labels={orchestratorSubtreeLabels}
              />
            ) : null}
          </section>
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
              <section
                className="rounded-[14px] border border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-5"
                id="pending-input"
              >
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
                {detail.pendingHitl &&
                (detail.pendingHitl.kind === "human" ||
                  detail.pendingHitl.kind === "form") ? (
                  <div id="agent-chat">
                    <GateChatPanel
                      canAct={canAct}
                      hitlRequestId={detail.pendingHitl.hitlRequestId}
                      labels={{
                        title: t("chatTitle"),
                        placeholder: t("chatPlaceholder"),
                        send: t("chatSend"),
                        sending: t("chatSending"),
                        unavailable: t("chatUnavailable"),
                        idleCostWarning: t("chatIdleCostWarning"),
                        revertNotice: t("chatRevertNotice"),
                        agentLabel: t("chatAgentLabel"),
                        error: t("chatError"),
                        transcript: {
                          thinking: t("chatThinking"),
                          rawEvent: t("chatRawEvent"),
                          input: t("chatToolInput"),
                          result: t("chatToolResult"),
                          copy: t("chatCopy"),
                          copied: t("chatCopied"),
                          toolCount: "{name} ×{count}",
                        },
                      }}
                      runId={detail.runId}
                    />
                  </div>
                ) : null}
                {detail.pendingHitl &&
                hasReviewGate &&
                (dirtySummary || detail.pendingHitl.dirtyResolution) ? (
                  <DirtyResolutionBanner
                    canAct={canAct}
                    diffHref={dirtyDiffHref}
                    dirty={
                      dirtySummary ?? {
                        files: [],
                        staged: 0,
                        unstaged: 0,
                        untracked: 0,
                        total: 0,
                      }
                    }
                    dirtyResolution={detail.pendingHitl.dirtyResolution}
                    hitlRequestId={detail.pendingHitl.hitlRequestId}
                    labels={{
                      title: t("dirtyTitle"),
                      summary: t("dirtySummary", {
                        staged: dirtySummary?.staged ?? 0,
                        unstaged: dirtySummary?.unstaged ?? 0,
                        untracked: dirtySummary?.untracked ?? 0,
                      }),
                      viewDiff: t("dirtyViewDiff"),
                      commit: t("dirtyCommit"),
                      discard: t("dirtyDiscard"),
                      discardConfirm: t("dirtyDiscardConfirm"),
                      proceed: t("dirtyProceed"),
                      recordedBadge: t("dirtyProceedBadge"),
                      error: t("dirtyError"),
                    }}
                    runId={detail.runId}
                  />
                ) : null}
                <RunHitlResponse
                  canAct={canAct}
                  criticality={detail.pendingHitl.criticality}
                  hitlRequestId={detail.pendingHitl.hitlRequestId}
                  kind={detail.pendingHitl.kind}
                  options={detail.pendingHitl.options}
                  reviewCounts={reviewGateCounts}
                  runId={detail.runId}
                  schema={detail.pendingHitl.schema}
                />
                {canClaim ? (
                  <div className="mt-4 border-t border-dashed border-amber-line pt-4">
                    <RunTakeoverActions
                      branch={detail.branch}
                      canAct={canAct}
                      displayWorktreePath={displayWorktreePath}
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
              displayWorktreePath={displayWorktreePath}
              isOwner={detail.takeoverOwnerUserId === user.id}
              mode="working"
              runId={detail.runId}
              worktreePath={detail.worktreePath}
            />
          </section>
        ) : null}

        {flowGraphData || showAgentCenter ? (
          <section data-testid="run-workbench">
            <WorkbenchPanel
              diff={
                <RunDiff
                  labels={flowGraphData?.diffLabels ?? workbenchDiffLabels}
                  review={hasReviewGate ? gateDiffReview : undefined}
                  runId={detail.runId}
                  scopeSwitcher={workbenchDiffScopeLabels}
                />
              }
              evidence={
                <section>
                  <h2 className="mb-3 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink">
                    {evidenceLabels.title}
                  </h2>
                  <EvidenceGraphSection
                    graph={evidence}
                    labels={evidenceLabels}
                    runId={detail.runId}
                  />
                </section>
              }
              filesPane={children}
              filesTree={
                <FileTree
                  filesApiBase={`/api/runs/${detail.runId}/files`}
                  labels={flowGraphData?.filesLabels ?? workbenchFilesLabels}
                />
              }
              runId={detail.runId}
              tabLabels={flowGraphData?.tabLabels ?? workbenchTabLabels}
              timeline={
                <RunTimeline
                  assignmentEvents={timeline.assignmentEvents}
                  entries={timeline.entries as TimelineEntry[]}
                  labels={timelineLabels}
                />
              }
            />
          </section>
        ) : null}

        {settings ? (
          <details className="rounded-[10px] border border-line bg-paper p-4">
            <summary className="cursor-pointer font-sans text-[14px] font-bold text-ink">
              {t("settingsTitle")}
            </summary>
            <div className="mt-3">
              <FlowSettingsPanel
                labels={settingsLabels}
                nodes={settings.nodes}
                refusalReason={settings.refusalReason}
              />
            </div>
          </details>
        ) : null}

        {capabilityProfiles ? (
          <details className="rounded-[10px] border border-line bg-paper p-4">
            <summary className="cursor-pointer font-sans text-[14px] font-bold text-ink">
              {t("capabilityTitle")}
            </summary>
            <div className="mt-3">
              <CapabilityProfilePanel
                labels={capabilityLabels}
                nodes={capabilityNodes}
              />
            </div>
          </details>
        ) : null}

        {resolvedSet ? (
          <details className="rounded-[10px] border border-line bg-paper p-4">
            <summary className="cursor-pointer font-sans text-[14px] font-bold text-ink">
              {t("resolvedSet.title")}
            </summary>
            <div className="mt-3">
              <ResolvedCapabilitySetPanel
                labels={resolvedSetLabels}
                resolved={resolvedSet}
              />
            </div>
          </details>
        ) : null}

        {showReview && reviewData ? (
          <ReviewPanel
            baseBranch={reviewData.baseBranch}
            baseCommit={reviewData.baseCommit}
            canPromote={canAct}
            deliveryPolicy={reviewData.deliveryPolicy}
            diff={reviewData.diff}
            displayParentRepoPath={displayParentRepoPath}
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
    </RunShell>
  );
}
