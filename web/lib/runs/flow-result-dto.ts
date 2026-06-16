import type { ResolvedCapabilitySet, RunKind } from "@/lib/db/schema";
import type {
  GraphTopology,
  GraphTopologyEdge,
  GraphTopologyNode,
} from "@/lib/queries/flow-graph-view";
import type { ReadinessDTO } from "@/lib/queries/readiness";
import type {
  RunCostSummary,
  RunPendingHitl,
  RunSettings,
  RunTimeline,
  TimelineAssignmentEvent,
  TimelineEntry,
} from "@/lib/queries/run";
import type {
  RuntimeGateSummary,
  RunNodeStatuses,
} from "@/lib/queries/run-node-status";
import type { EvidenceGraph } from "@/lib/queries/evidence-graph";
import type { DirtySummary } from "@/lib/runs/dirty-resolution";
import type { DeliveryPolicy } from "@/lib/runs/delivery-policy";

export type FlowResultDegradationCode =
  | "dirty-summary-unavailable"
  | "review-diff-fallback";

export interface FlowResultCapabilityNodeDto {
  nodeId: string;
  nodeType: string;
  profileDigest: string;
  resolvedRevisions: Array<{
    refId: string;
    kind: string;
    sha: string;
    trustStatus?: string | null;
  }>;
  enforcedClasses: string[];
  instructedClasses: string[];
  refusedClasses: string[];
  cleanupFailed: boolean;
}

export interface FlowResultRunInput {
  runId: string;
  projectId: string;
  projectSlug: string;
  taskNumber: number | null;
  taskRef: string | null;
  status: string;
  startedAt: Date | string;
  endedAt: Date | string | null;
  currentStepId: string | null;
  branch: string;
  agent: string;
  runKind: RunKind;
  recoverable: boolean;
  takeoverOwnerUserId: string | null;
  ttlState: string;
  effectiveRemovalAt: Date | string | null;
  archived: boolean;
  pruned: boolean;
  baseBranch: string | null;
  baseCommit: string | null;
  targetBranch: string | null;
  prUrl: string | null;
  prNumber: number | null;
}

export interface FlowResultGraphInput {
  topology: GraphTopology;
  layout: Record<string, { x: number; y: number }>;
  statuses: RunNodeStatuses;
}

export interface FlowResultReviewInput {
  baseBranch: string | null;
  baseCommit: string | null;
  targetBranch: string | null;
  reviewedTargetCommit: string | null;
  promotionMode: DeliveryPolicy["strategy"];
  deliveryPolicy: DeliveryPolicy;
  diff: {
    files: readonly unknown[];
    truncated: boolean;
  };
  driftDetected: boolean;
  legacyNeedsRelaunch: boolean;
}

export interface FlowResultReviewGateInput {
  active: boolean;
  canComment: boolean;
  threadCounts: { openCount: number; outdatedCount: number } | null;
}

export interface BuildFlowRunResultDtoInput {
  run: FlowResultRunInput;
  graph: FlowResultGraphInput | null;
  timeline: RunTimeline;
  evidence: EvidenceGraph;
  readiness: ReadinessDTO | null;
  cost: RunCostSummary;
  settings: RunSettings | null;
  pendingHitl: RunPendingHitl | null;
  dirtySummary: DirtySummary | null;
  review: FlowResultReviewInput | null;
  reviewGate: FlowResultReviewGateInput;
  capabilityNodes: readonly FlowResultCapabilityNodeDto[];
  resolvedCapabilitySet: ResolvedCapabilitySet | null;
  degradations?: readonly FlowResultDegradationCode[];
  nowMs: number;
}

export interface FlowRunNodeDto {
  id: string;
  nodeType: string;
  label: string;
  displayLabel: string;
  nodeTypeLabel: string;
  nodeRole: GraphTopologyNode["nodeRole"];
  declaredGateSummary: GraphTopologyNode["declaredGateSummary"];
  runtimeStatus: string;
  attempt: number;
  autoRetry: boolean;
  rollup: string;
  gateSummary: RuntimeGateSummary;
  layout: { x: number; y: number } | null;
  current: boolean;
  selected: boolean;
}

export type FlowRunGraphDto =
  | {
      kind: "ready";
      nodeCount: number;
      currentNodeId: string | null;
      selectedNodeId: string | null;
      nodes: FlowRunNodeDto[];
      edges: GraphTopologyEdge[];
    }
  | {
      kind: "missing-manifest";
      nodeCount: 0;
      currentNodeId: null;
      selectedNodeId: null;
      nodes: [];
      edges: [];
    };

export type FlowResultTimelineEntryDto = Omit<TimelineEntry, "acpSessionId">;

export interface FlowRunResultDto {
  run: {
    runId: string;
    projectId: string;
    projectSlug: string;
    taskNumber: number | null;
    taskRef: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
    currentStepId: string | null;
    branch: string;
    agent: string;
    runKind: RunKind;
    recoverable: boolean;
    takeoverOwnerUserId: string | null;
    ttlState: string;
    effectiveRemovalAt: string | null;
    archived: boolean;
    pruned: boolean;
    baseBranch: string | null;
    baseCommit: string | null;
    targetBranch: string | null;
    prUrl: string | null;
    prNumber: number | null;
    wallDurationMs: number;
  };
  graph: FlowRunGraphDto;
  timeline: {
    entries: FlowResultTimelineEntryDto[];
    assignmentEvents: TimelineAssignmentEvent[];
    entryCount: number;
    activeDurationMs: number;
  };
  evidence: EvidenceGraph;
  readiness: ReadinessDTO | null;
  cost: RunCostSummary;
  settings: RunSettings | null;
  hitl: {
    hitlRequestId: string;
    kind: RunPendingHitl["kind"];
    assignmentId: string | null;
    assignmentStatus: RunPendingHitl["assignmentStatus"];
    assignmentActionKind: RunPendingHitl["assignmentActionKind"];
    assignmentRoleRefs: string[];
    assignmentStaleEvidenceCount: number | null;
    assigneeLabel: string | null;
    assigneeUserId: string | null;
    prompt: string;
    optionCount: number;
    schemaPresent: boolean;
    criticality: RunPendingHitl["criticality"];
    dirtyResolution: RunPendingHitl["dirtyResolution"];
  } | null;
  dirtyState: DirtySummary | null;
  review: {
    baseBranch: string | null;
    baseCommit: string | null;
    targetBranch: string | null;
    reviewedTargetCommit: string | null;
    promotionMode: DeliveryPolicy["strategy"];
    deliveryPolicy: DeliveryPolicy;
    diff: {
      fileCount: number;
      truncated: boolean;
    };
    driftDetected: boolean;
    legacyNeedsRelaunch: boolean;
  } | null;
  reviewGate: FlowResultReviewGateInput;
  capabilities: {
    materializedNodes: FlowResultCapabilityNodeDto[];
    resolvedSet: ResolvedCapabilitySet | null;
  };
  degradations: FlowResultDegradationCode[];
}

const EMPTY_GATE_SUMMARY: RuntimeGateSummary = {
  total: 0,
  blockingTotal: 0,
  advisoryTotal: 0,
  worstBlockingStatus: null,
  failedBlocking: 0,
  staleBlocking: 0,
};

function iso(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function runtimeGateSummary(status: RuntimeGateSummary | undefined) {
  return status ?? { ...EMPTY_GATE_SUMMARY };
}

function validNodeId(
  nodeIds: ReadonlySet<string>,
  nodeId: string | null,
): string | null {
  return nodeId !== null && nodeIds.has(nodeId) ? nodeId : null;
}

function lastTimelineNodeId(
  entries: readonly TimelineEntry[],
  nodeIds: ReadonlySet<string>,
): string | null {
  return entries.reduce<string | null>(
    (selected, entry) => (nodeIds.has(entry.nodeId) ? entry.nodeId : selected),
    null,
  );
}

function timelineEntry(entry: TimelineEntry): FlowResultTimelineEntryDto {
  return {
    nodeAttemptId: entry.nodeAttemptId,
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    attempt: entry.attempt,
    status: entry.status,
    decision: entry.decision,
    reworkFromNode: entry.reworkFromNode,
    autoRetry: entry.autoRetry,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    tokens: entry.tokens,
    gates: entry.gates,
    handoff: entry.handoff,
    resolvedPrompt: entry.resolvedPrompt,
  };
}

function buildGraphDto(
  graph: FlowResultGraphInput | null,
  timeline: RunTimeline,
  runCurrentStepId: string | null,
): FlowRunGraphDto {
  if (graph === null) {
    return {
      kind: "missing-manifest",
      nodeCount: 0,
      currentNodeId: null,
      selectedNodeId: null,
      nodes: [],
      edges: [],
    };
  }

  const nodeIds = new Set(graph.topology.nodes.map((node) => node.id));
  const currentNodeId =
    validNodeId(nodeIds, runCurrentStepId) ??
    validNodeId(nodeIds, graph.statuses.currentStepId);
  const selectedNodeId =
    currentNodeId ??
    lastTimelineNodeId(timeline.entries, nodeIds) ??
    graph.topology.nodes[0]?.id ??
    null;
  const nodes = graph.topology.nodes.map<FlowRunNodeDto>((node) => {
    const status = graph.statuses.nodes[node.id];

    return {
      id: node.id,
      nodeType: node.nodeType,
      label: node.label,
      displayLabel: node.displayLabel,
      nodeTypeLabel: node.nodeTypeLabel,
      nodeRole: node.nodeRole,
      declaredGateSummary: node.declaredGateSummary,
      runtimeStatus: status?.status ?? "Pending",
      attempt: status?.attempt ?? 0,
      autoRetry: status?.autoRetry ?? false,
      rollup: status?.rollup ?? "none",
      gateSummary: runtimeGateSummary(status?.gateSummary),
      layout: graph.layout[node.id] ?? null,
      current: node.id === currentNodeId,
      selected: node.id === selectedNodeId,
    };
  });

  return {
    kind: "ready",
    nodeCount: nodes.length,
    currentNodeId,
    selectedNodeId,
    nodes,
    edges: graph.topology.edges,
  };
}

function staleEvidenceCount(
  summary: Record<string, unknown> | null,
): number | null {
  if (summary === null) return null;
  const count = summary.count;

  return typeof count === "number" ? count : null;
}

function hitlDto(hitl: RunPendingHitl | null): FlowRunResultDto["hitl"] {
  if (hitl === null) return null;

  return {
    hitlRequestId: hitl.hitlRequestId,
    kind: hitl.kind,
    assignmentId: hitl.assignmentId,
    assignmentStatus: hitl.assignmentStatus,
    assignmentActionKind: hitl.assignmentActionKind,
    assignmentRoleRefs: hitl.assignmentRoleRefs,
    assignmentStaleEvidenceCount: staleEvidenceCount(
      hitl.assignmentStaleEvidenceSummary,
    ),
    assigneeLabel: hitl.assigneeLabel,
    assigneeUserId: hitl.assigneeUserId,
    prompt: hitl.prompt,
    optionCount: hitl.options.length,
    schemaPresent: hitl.schema !== null,
    criticality: hitl.criticality,
    dirtyResolution: hitl.dirtyResolution,
  };
}

function reviewDto(
  review: FlowResultReviewInput | null,
): FlowRunResultDto["review"] {
  if (review === null) return null;

  return {
    baseBranch: review.baseBranch,
    baseCommit: review.baseCommit,
    targetBranch: review.targetBranch,
    reviewedTargetCommit: review.reviewedTargetCommit,
    promotionMode: review.promotionMode,
    deliveryPolicy: review.deliveryPolicy,
    diff: {
      fileCount: review.diff.files.length,
      truncated: review.diff.truncated,
    },
    driftDetected: review.driftDetected,
    legacyNeedsRelaunch: review.legacyNeedsRelaunch,
  };
}

function uniqueDegradations(
  explicit: readonly FlowResultDegradationCode[] | undefined,
  review: FlowResultReviewInput | null,
): FlowResultDegradationCode[] {
  const values = new Set<FlowResultDegradationCode>(explicit ?? []);

  if (review?.legacyNeedsRelaunch) {
    values.add("review-diff-fallback");
  }

  return [...values];
}

export function buildFlowRunResultDto(
  input: BuildFlowRunResultDtoInput,
): FlowRunResultDto {
  const startedAt = iso(input.run.startedAt);
  const endedAt = isoOrNull(input.run.endedAt);
  const activeDurationMs = input.timeline.entries.reduce<number>(
    (sum, entry) => sum + (entry.durationMs ?? 0),
    0,
  );
  const wallDurationMs = input.run.endedAt
    ? Math.max(
        0,
        new Date(iso(input.run.endedAt)).getTime() -
          new Date(startedAt).getTime(),
      )
    : Math.max(0, input.nowMs - new Date(startedAt).getTime());

  return {
    run: {
      runId: input.run.runId,
      projectId: input.run.projectId,
      projectSlug: input.run.projectSlug,
      taskNumber: input.run.taskNumber,
      taskRef: input.run.taskRef,
      status: input.run.status,
      startedAt,
      endedAt,
      currentStepId: input.run.currentStepId,
      branch: input.run.branch,
      agent: input.run.agent,
      runKind: input.run.runKind,
      recoverable: input.run.recoverable,
      takeoverOwnerUserId: input.run.takeoverOwnerUserId,
      ttlState: input.run.ttlState,
      effectiveRemovalAt: isoOrNull(input.run.effectiveRemovalAt),
      archived: input.run.archived,
      pruned: input.run.pruned,
      baseBranch: input.run.baseBranch,
      baseCommit: input.run.baseCommit,
      targetBranch: input.run.targetBranch,
      prUrl: input.run.prUrl,
      prNumber: input.run.prNumber,
      wallDurationMs,
    },
    graph: buildGraphDto(input.graph, input.timeline, input.run.currentStepId),
    timeline: {
      entries: input.timeline.entries.map(timelineEntry),
      assignmentEvents: input.timeline.assignmentEvents,
      entryCount: input.timeline.entries.length,
      activeDurationMs,
    },
    evidence: input.evidence,
    readiness: input.readiness,
    cost: input.cost,
    settings: input.settings,
    hitl: hitlDto(input.pendingHitl),
    dirtyState: input.dirtySummary,
    review: reviewDto(input.review),
    reviewGate: input.reviewGate,
    capabilities: {
      materializedNodes: [...input.capabilityNodes],
      resolvedSet: input.resolvedCapabilitySet,
    },
    degradations: uniqueDegradations(input.degradations, input.review),
  };
}
