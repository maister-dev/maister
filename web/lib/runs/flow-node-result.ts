import type {
  FlowRunNodeDto,
  FlowRunResultDto,
  FlowResultTimelineEntryDto,
} from "@/lib/runs/flow-result-dto";
import type { TimelineGate } from "@/lib/queries/run";

export interface FlowNodeAttemptResult {
  attempt: number;
  status: string;
  decision: string | null;
  reworkFromNode: string | null;
  autoRetry: boolean;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tokenTotal: number;
}

export interface FlowNodeGateResult {
  attempt: number;
  gateId: string;
  kind: TimelineGate["kind"];
  mode: TimelineGate["mode"];
  status: TimelineGate["status"];
  stale: boolean;
}

export interface FlowNodeArtifactResult {
  id: string;
  label: string;
  state: string | null;
  kind: string | null;
}

export interface FlowNodeHitlResult {
  hitlRequestId: string;
  kind: string;
  criticality: string | null;
  assigneeLabel: string | null;
  optionCount: number;
  dirtyResolution: string | null;
}

export interface FlowNodeReviewResult {
  openCount: number;
  outdatedCount: number;
}

export interface FlowNodeReadinessResult {
  state: string;
  reasons: string[];
}

export interface FlowNodeResultDto {
  nodeId: string;
  attempts: FlowNodeAttemptResult[];
  gates: FlowNodeGateResult[];
  artifacts: FlowNodeArtifactResult[];
  hitl: FlowNodeHitlResult | null;
  review: FlowNodeReviewResult | null;
  readiness: FlowNodeReadinessResult | null;
  flags: {
    failed: boolean;
    reworked: boolean;
  };
}

function attemptsForNode(
  result: FlowRunResultDto,
  node: FlowRunNodeDto,
): FlowResultTimelineEntryDto[] {
  return result.timeline.entries.filter((entry) => entry.nodeId === node.id);
}

function attemptDto(entry: FlowResultTimelineEntryDto): FlowNodeAttemptResult {
  return {
    attempt: entry.attempt,
    status: entry.status,
    decision: entry.decision,
    reworkFromNode: entry.reworkFromNode,
    autoRetry: entry.autoRetry,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    tokenTotal: entry.tokens.total,
  };
}

function gateDtos(
  entries: readonly FlowResultTimelineEntryDto[],
): FlowNodeGateResult[] {
  return entries.flatMap((entry) =>
    entry.gates.map((gate) => ({
      attempt: entry.attempt,
      gateId: gate.gateId,
      kind: gate.kind,
      mode: gate.mode,
      status: gate.status,
      stale: gate.stale,
    })),
  );
}

function artifactDtos(
  result: FlowRunResultDto,
  entries: readonly FlowResultTimelineEntryDto[],
): FlowNodeArtifactResult[] {
  const attemptNodeIds = new Set(
    entries.map((entry) => `na:${entry.nodeAttemptId}`),
  );
  const artifactIds = new Set(
    result.evidence.edges
      .filter(
        (edge) => edge.kind === "output" && attemptNodeIds.has(edge.source),
      )
      .map((edge) => edge.target),
  );

  return result.evidence.nodes
    .filter((node) => artifactIds.has(node.id))
    .map((node) => ({
      id: node.id,
      label: node.label,
      state: node.state,
      kind: typeof node.meta.kind === "string" ? node.meta.kind : null,
    }));
}

function hitlDto(
  result: FlowRunResultDto,
  node: FlowRunNodeDto,
): FlowNodeHitlResult | null {
  if (result.hitl === null) return null;
  if (!node.current && result.run.currentStepId !== node.id) return null;

  return {
    hitlRequestId: result.hitl.hitlRequestId,
    kind: result.hitl.kind,
    criticality: result.hitl.criticality,
    assigneeLabel: result.hitl.assigneeLabel,
    optionCount: result.hitl.optionCount,
    dirtyResolution: result.hitl.dirtyResolution,
  };
}

function reviewDto(
  result: FlowRunResultDto,
  node: FlowRunNodeDto,
): FlowNodeReviewResult | null {
  if (!result.reviewGate.active) return null;
  if (!node.current && result.run.currentStepId !== node.id) return null;

  return {
    openCount: result.reviewGate.threadCounts?.openCount ?? 0,
    outdatedCount: result.reviewGate.threadCounts?.outdatedCount ?? 0,
  };
}

function readinessDto(
  result: FlowRunResultDto,
  node: FlowRunNodeDto,
): FlowNodeReadinessResult | null {
  if (result.readiness === null) return null;
  if (
    !node.current &&
    result.run.status !== "Review" &&
    node.runtimeStatus !== "Failed"
  ) {
    return null;
  }

  return {
    state: result.readiness.readiness,
    reasons: result.readiness.reasons,
  };
}

function isReworked(entries: readonly FlowResultTimelineEntryDto[]): boolean {
  return entries.some(
    (entry) =>
      entry.reworkFromNode !== null ||
      entry.decision === "rework" ||
      entry.status === "Reworked",
  );
}

export function buildFlowNodeResult(
  result: FlowRunResultDto,
  node: FlowRunNodeDto,
): FlowNodeResultDto {
  const entries = attemptsForNode(result, node);
  const gates = gateDtos(entries);

  return {
    nodeId: node.id,
    attempts: entries.map(attemptDto),
    gates,
    artifacts: artifactDtos(result, entries),
    hitl: hitlDto(result, node),
    review: reviewDto(result, node),
    readiness: readinessDto(result, node),
    flags: {
      failed:
        node.runtimeStatus === "Failed" ||
        gates.some((gate) => gate.status === "failed"),
      reworked: isReworked(entries),
    },
  };
}
