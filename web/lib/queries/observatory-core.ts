export type ObservatoryNodeStatus =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "NeedsInput"
  | "Reworked"
  | "Stale";

export interface ObservatoryRunInput {
  id: string;
  active: boolean;
}

export interface ObservatoryTimedRunInput extends ObservatoryRunInput {
  startedAt: Date;
  endedAt: Date | null;
}

export interface ObservatoryNodeAttemptInput {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
  status: ObservatoryNodeStatus;
  errorCode?: string | null;
  exitCode?: number | null;
}

export interface ObservatoryHitlInput {
  id: string;
  runId: string;
  createdAt: Date;
  respondedAt: Date | null;
}

export interface ObservatoryArtifactInput {
  id: string;
  runId: string;
  nodeAttemptId: string | null;
  artifactDefId: string | null;
  kind: string;
}

export interface CorrectionMetric {
  runCount: number;
  reworkCount: number;
  retryCount: number;
  correctionRate: number;
  displayKind: "pressure-ratio";
  volatile: boolean;
  runIds: string[];
}

export interface AutonomyMetric {
  totalSeconds: number;
  waitSeconds: number;
  openWaitCount: number;
  autonomyScore: number;
  volatile: boolean;
  reviewDwellExcluded: true;
  runIds: string[];
}

export interface ArtifactContribution {
  key: string;
  artifactDefId: string | null;
  kind: string;
  artifactCount: number;
  runIds: string[];
}

// ADR-072 honest-N display threshold: groups with fewer terminal executions
// render "—", never 0%.
export const MIN_GROUP_EXECUTIONS = 3;

export const GATE_TERMINAL_STATUSES = [
  "passed",
  "failed",
  "stale",
  "skipped",
  "overridden",
] as const;

export interface HarnessGateInput {
  projectId: string;
  flowId: string;
  flowRefId: string;
  nodeId: string;
  nodeAttemptId: string;
  gateId: string;
  kind: string;
  mode: string;
  status: string;
}

interface GateStatusCounts {
  executions: number;
  passed: number;
  failed: number;
  stale: number;
  skipped: number;
  overridden: number;
  failRate: number | null;
}

export interface GateFiringStat extends GateStatusCounts {
  projectId: string;
  flowId: string;
  flowRefId: string;
  nodeId: string;
  gateId: string;
  kind: string;
  mode: string;
}

export interface GateKindFiringStat extends GateStatusCounts {
  kind: string;
}

export interface GateFiringRollup {
  groups: GateFiringStat[];
  byKind: GateKindFiringStat[];
}

export interface DeclaredGateInput {
  flowId: string;
  flowRefId: string;
  nodeId: string;
  gateId: string;
  kind: string;
  mode: string;
}

export interface NeverFiredFlag {
  flowId: string;
  flowRefId: string;
  nodeId: string;
  gateId: string;
  kind: string;
  executions: number;
}

export interface GateEffectiveness {
  flowId: string;
  flowRefId: string;
  nodeId: string;
  gateId: string;
  kind: string;
  failedAttempts: number;
  failedFollowedByRework: number;
  passedAttempts: number;
  passedFollowedByRework: number;
  reworkRateAfterFail: number | null;
  reworkRateAfterPass: number | null;
  lift: number | null;
}

export interface CapabilityRunInput extends ObservatoryRunInput {
  capabilities: readonly { refId: string; kind: string }[] | null;
}

export interface CapabilityEffectiveness {
  refId: string;
  capabilityKind: string;
  withCapability: CorrectionMetric;
  withoutCapability: CorrectionMetric;
}

export interface ManifestNodeInput {
  nodeId: string;
  gates: readonly { gateId: string; kind: string; mode: string }[];
  guideCount: number;
}

export interface FlowManifestInput {
  flowId: string;
  flowRefId: string;
  revisionId: string;
  nodes: readonly ManifestNodeInput[];
}

export interface CoverageNode {
  nodeId: string;
  gateCount: number;
  blockingGateCount: number;
  advisoryGateCount: number;
  guideCount: number;
  guidesWithoutSensors: boolean;
  executions: number;
}

export interface CoverageFlow {
  flowId: string;
  flowRefId: string;
  revisionCount: number;
  nodes: CoverageNode[];
}

export interface ObservatoryHarness {
  firing: GateFiringRollup;
  neverFired: NeverFiredFlag[];
  effectiveness: {
    gates: GateEffectiveness[];
    capabilities: CapabilityEffectiveness[];
  };
  coverage: CoverageFlow[];
}

type Interval = {
  startMs: number;
  endMs: number;
};

export function rollupCorrectionMetrics(input: {
  runs: readonly ObservatoryRunInput[];
  nodeAttempts: readonly ObservatoryNodeAttemptInput[];
}): CorrectionMetric {
  const attemptsByRun = groupBy(input.nodeAttempts, (attempt) => attempt.runId);
  const eligibleRunIds = input.runs
    .filter((run) => (attemptsByRun.get(run.id) ?? []).length > 0)
    .map((run) => run.id);
  const eligibleRunSet = new Set(eligibleRunIds);
  const attemptsByRunNode = groupBy(
    input.nodeAttempts.filter((attempt) => eligibleRunSet.has(attempt.runId)),
    (attempt) => `${attempt.runId}::${attempt.nodeId}`,
  );

  let retryCount = 0;

  for (const attempts of attemptsByRunNode.values()) {
    retryCount += Math.max(
      0,
      maxNumber(attempts.map((row) => row.attempt)) - 1,
    );
  }

  const reworkCount = input.nodeAttempts.filter(
    (attempt) =>
      eligibleRunSet.has(attempt.runId) && attempt.status === "Reworked",
  ).length;
  const runCount = eligibleRunIds.length;

  return {
    runCount,
    reworkCount,
    retryCount,
    correctionRate: runCount === 0 ? 0 : (reworkCount + retryCount) / runCount,
    displayKind: "pressure-ratio",
    volatile: input.runs.some(
      (run) => eligibleRunSet.has(run.id) && run.active,
    ),
    runIds: eligibleRunIds,
  };
}

export function rollupAutonomyMetrics(input: {
  now: Date;
  runs: readonly ObservatoryTimedRunInput[];
  hitlRequests: readonly ObservatoryHitlInput[];
}): AutonomyMetric {
  const hitlByRun = groupBy(input.hitlRequests, (hitl) => hitl.runId);
  let totalSeconds = 0;
  let waitSeconds = 0;
  let openWaitCount = 0;

  for (const run of input.runs) {
    const runStartMs = run.startedAt.getTime();
    const runEndMs = (run.endedAt ?? input.now).getTime();
    const normalizedRunEndMs = Math.max(runStartMs + 1000, runEndMs);

    totalSeconds += secondsBetween(runStartMs, normalizedRunEndMs);

    const intervals: Interval[] = [];

    for (const hitl of hitlByRun.get(run.id) ?? []) {
      if (hitl.respondedAt === null) openWaitCount += 1;
      const waitStartMs = Math.max(hitl.createdAt.getTime(), runStartMs);
      const waitEndMs = Math.min(
        (hitl.respondedAt ?? input.now).getTime(),
        normalizedRunEndMs,
      );

      if (waitEndMs > waitStartMs) {
        intervals.push({ startMs: waitStartMs, endMs: waitEndMs });
      }
    }

    waitSeconds += mergedIntervalSeconds(intervals);
  }

  const rawScore =
    totalSeconds === 0
      ? 1
      : 1 - Math.min(waitSeconds, totalSeconds) / totalSeconds;

  return {
    totalSeconds,
    waitSeconds,
    openWaitCount,
    autonomyScore: clamp(rawScore, 0, 1),
    volatile: input.runs.some((run) => run.active) || openWaitCount > 0,
    reviewDwellExcluded: true,
    runIds: input.runs.map((run) => run.id),
  };
}

export function groupArtifactContributions(
  artifacts: readonly ObservatoryArtifactInput[],
): ArtifactContribution[] {
  const grouped = groupBy(artifacts, (artifact) =>
    artifact.artifactDefId
      ? `def:${artifact.artifactDefId}`
      : `kind:${artifact.kind}`,
  );

  return [...grouped.entries()]
    .map(([key, rows]) => ({
      key,
      artifactDefId:
        rows.find((row) => row.artifactDefId)?.artifactDefId ?? null,
      kind: rows[0]?.kind ?? "unknown",
      artifactCount: rows.length,
      runIds: uniqueSorted(rows.map((row) => row.runId)),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function rollupGateFiringStats(
  gates: readonly HarnessGateInput[],
): GateFiringRollup {
  const groups = [
    ...groupBy(
      gates,
      (gate) =>
        `${gate.projectId}::${gate.flowId}::${gate.nodeId}::${gate.gateId}`,
    ).values(),
  ]
    .flatMap((rows) => {
      const first = rows[0];

      if (!first) return [];

      return [
        {
          projectId: first.projectId,
          flowId: first.flowId,
          flowRefId: first.flowRefId,
          nodeId: first.nodeId,
          gateId: first.gateId,
          kind: first.kind,
          mode: first.mode,
          ...countTerminalStatuses(rows),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.flowRefId.localeCompare(right.flowRefId) ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.gateId.localeCompare(right.gateId) ||
        left.projectId.localeCompare(right.projectId),
    );
  const byKind = [...groupBy(gates, (gate) => gate.kind).entries()]
    .map(([kind, rows]) => ({ kind, ...countTerminalStatuses(rows) }))
    .sort((left, right) => left.kind.localeCompare(right.kind));

  return { groups, byKind };
}

export function detectNeverFired(input: {
  declaredGates: readonly DeclaredGateInput[];
  firingStats: readonly GateFiringStat[];
  minExecutions: number;
}): NeverFiredFlag[] {
  const statsByGate = groupBy(
    input.firingStats,
    (stat) => `${stat.flowId}::${stat.nodeId}::${stat.gateId}`,
  );
  const declared = new Map<string, DeclaredGateInput>();

  for (const gate of input.declaredGates) {
    const key = `${gate.flowId}::${gate.nodeId}::${gate.gateId}`;

    if (!declared.has(key)) declared.set(key, gate);
  }

  return [...declared.entries()]
    .flatMap(([key, gate]) => {
      const stats = statsByGate.get(key) ?? [];
      const executions = stats.reduce((sum, stat) => sum + stat.executions, 0);
      const fired = stats.reduce(
        (sum, stat) => sum + stat.failed + stat.stale,
        0,
      );

      if (executions < input.minExecutions || fired > 0) return [];

      return [
        {
          flowId: gate.flowId,
          flowRefId: gate.flowRefId,
          nodeId: gate.nodeId,
          gateId: gate.gateId,
          kind: gate.kind,
          executions,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.flowRefId.localeCompare(right.flowRefId) ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.gateId.localeCompare(right.gateId),
    );
}

export function rollupControlEffectiveness(input: {
  gates: readonly HarnessGateInput[];
  attempts: readonly ObservatoryNodeAttemptInput[];
}): GateEffectiveness[] {
  const attemptById = new Map(
    input.attempts.map((attempt) => [attempt.id, attempt]),
  );
  const maxAttemptByRunNode = new Map<string, number>();

  for (const attempt of input.attempts) {
    const key = `${attempt.runId}::${attempt.nodeId}`;

    maxAttemptByRunNode.set(
      key,
      Math.max(maxAttemptByRunNode.get(key) ?? 0, attempt.attempt),
    );
  }

  const verdictGates = input.gates.filter(
    (gate) => gate.status === "failed" || gate.status === "passed",
  );

  return [
    ...groupBy(
      verdictGates,
      (gate) =>
        `${gate.projectId}::${gate.flowId}::${gate.nodeId}::${gate.gateId}`,
    ).values(),
  ]
    .flatMap((rows) => {
      const first = rows[0];

      if (!first) return [];

      let failedAttempts = 0;
      let failedFollowedByRework = 0;
      let passedAttempts = 0;
      let passedFollowedByRework = 0;

      for (const row of rows) {
        const attempt = attemptById.get(row.nodeAttemptId);

        if (!attempt) continue;

        const reworkFollowed =
          attempt.status === "Reworked" ||
          (maxAttemptByRunNode.get(`${attempt.runId}::${attempt.nodeId}`) ??
            attempt.attempt) > attempt.attempt;

        if (row.status === "failed") {
          failedAttempts += 1;
          if (reworkFollowed) failedFollowedByRework += 1;
        } else {
          passedAttempts += 1;
          if (reworkFollowed) passedFollowedByRework += 1;
        }
      }

      const reworkRateAfterFail =
        failedAttempts === 0 ? null : failedFollowedByRework / failedAttempts;
      const reworkRateAfterPass =
        passedAttempts === 0 ? null : passedFollowedByRework / passedAttempts;
      const lift =
        reworkRateAfterFail === null ||
        reworkRateAfterPass === null ||
        reworkRateAfterPass === 0
          ? null
          : reworkRateAfterFail / reworkRateAfterPass;

      return [
        {
          flowId: first.flowId,
          flowRefId: first.flowRefId,
          nodeId: first.nodeId,
          gateId: first.gateId,
          kind: first.kind,
          failedAttempts,
          failedFollowedByRework,
          passedAttempts,
          passedFollowedByRework,
          reworkRateAfterFail,
          reworkRateAfterPass,
          lift,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.flowRefId.localeCompare(right.flowRefId) ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.gateId.localeCompare(right.gateId),
    );
}

export function rollupCapabilityEffectiveness(input: {
  runs: readonly CapabilityRunInput[];
  attempts: readonly ObservatoryNodeAttemptInput[];
}): CapabilityEffectiveness[] {
  const resolvedRuns = input.runs.filter((run) => run.capabilities !== null);
  const attemptsByRun = groupBy(input.attempts, (attempt) => attempt.runId);
  const kindByRefId = new Map<string, string>();
  const refIdsByRun = new Map<string, Set<string>>();

  for (const run of resolvedRuns) {
    const refIds = new Set<string>();

    for (const capability of run.capabilities ?? []) {
      refIds.add(capability.refId);
      if (!kindByRefId.has(capability.refId)) {
        kindByRefId.set(capability.refId, capability.kind);
      }
    }

    refIdsByRun.set(run.id, refIds);
  }

  return [...kindByRefId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([refId, capabilityKind]) => {
      const withRuns = resolvedRuns.filter((run) =>
        refIdsByRun.get(run.id)?.has(refId),
      );
      const withoutRuns = resolvedRuns.filter(
        (run) => !refIdsByRun.get(run.id)?.has(refId),
      );

      return {
        refId,
        capabilityKind,
        withCapability: rollupCorrectionMetrics({
          runs: withRuns,
          nodeAttempts: withRuns.flatMap(
            (run) => attemptsByRun.get(run.id) ?? [],
          ),
        }),
        withoutCapability: rollupCorrectionMetrics({
          runs: withoutRuns,
          nodeAttempts: withoutRuns.flatMap(
            (run) => attemptsByRun.get(run.id) ?? [],
          ),
        }),
      };
    });
}

export function declaredGatesFromManifests(
  manifests: readonly FlowManifestInput[],
): DeclaredGateInput[] {
  const declared = new Map<string, DeclaredGateInput>();

  for (const manifest of manifests) {
    for (const node of manifest.nodes) {
      for (const gate of node.gates) {
        const key = `${manifest.flowId}::${node.nodeId}::${gate.gateId}`;

        if (declared.has(key)) continue;

        declared.set(key, {
          flowId: manifest.flowId,
          flowRefId: manifest.flowRefId,
          nodeId: node.nodeId,
          gateId: gate.gateId,
          kind: gate.kind,
          mode: gate.mode,
        });
      }
    }
  }

  return [...declared.values()].sort(
    (left, right) =>
      left.flowRefId.localeCompare(right.flowRefId) ||
      left.nodeId.localeCompare(right.nodeId) ||
      left.gateId.localeCompare(right.gateId),
  );
}

export function flowNodeKey(flowId: string, nodeId: string): string {
  return `${flowId}::${nodeId}`;
}

export function buildCoverageMap(input: {
  manifests: readonly FlowManifestInput[];
  // node_attempts count per flowNodeKey(flowId, nodeId) — "how many times the
  // node ran in the window", NOT per-gate evaluations (a K-gate node would
  // otherwise display K× its run count).
  nodeAttemptCounts: ReadonlyMap<string, number>;
}): CoverageFlow[] {
  return [...groupBy(input.manifests, (manifest) => manifest.flowId).values()]
    .flatMap((revisions) => {
      const first = revisions[0];

      if (!first) return [];

      const nodesById = new Map<
        string,
        {
          gatesById: Map<
            string,
            { gateId: string; kind: string; mode: string }
          >;
          guideCount: number;
        }
      >();

      for (const revision of revisions) {
        for (const node of revision.nodes) {
          const aggregate = nodesById.get(node.nodeId) ?? {
            gatesById: new Map<
              string,
              { gateId: string; kind: string; mode: string }
            >(),
            guideCount: 0,
          };

          for (const gate of node.gates) {
            if (!aggregate.gatesById.has(gate.gateId)) {
              aggregate.gatesById.set(gate.gateId, gate);
            }
          }

          aggregate.guideCount = Math.max(
            aggregate.guideCount,
            node.guideCount,
          );
          nodesById.set(node.nodeId, aggregate);
        }
      }

      const nodes = [...nodesById.entries()]
        .map(([nodeId, aggregate]) => {
          const gates = [...aggregate.gatesById.values()];
          const blockingGateCount = gates.filter(
            (gate) => gate.mode === "blocking",
          ).length;

          return {
            nodeId,
            gateCount: gates.length,
            blockingGateCount,
            advisoryGateCount: gates.length - blockingGateCount,
            guideCount: aggregate.guideCount,
            guidesWithoutSensors:
              aggregate.guideCount >= 1 && blockingGateCount === 0,
            executions:
              input.nodeAttemptCounts.get(flowNodeKey(first.flowId, nodeId)) ??
              0,
          };
        })
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId));

      return [
        {
          flowId: first.flowId,
          flowRefId: first.flowRefId,
          revisionCount: new Set(
            revisions.map((revision) => revision.revisionId),
          ).size,
          nodes,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.flowRefId.localeCompare(right.flowRefId) ||
        left.flowId.localeCompare(right.flowId),
    );
}

function countTerminalStatuses(
  rows: readonly { status: string }[],
): GateStatusCounts {
  let passed = 0;
  let failed = 0;
  let stale = 0;
  let skipped = 0;
  let overridden = 0;

  for (const row of rows) {
    switch (row.status) {
      case "passed":
        passed += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "stale":
        stale += 1;
        break;
      case "skipped":
        skipped += 1;
        break;
      case "overridden":
        overridden += 1;
        break;
      default:
        break;
    }
  }

  const executions = passed + failed + stale + skipped + overridden;

  return {
    executions,
    passed,
    failed,
    stale,
    skipped,
    overridden,
    failRate: executions === 0 ? null : failed / executions,
  };
}

export function mergedIntervalSeconds(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort(
    (left, right) => left.startMs - right.startMs,
  );
  const merged: Interval[] = [];

  for (const interval of sorted) {
    const previous = merged.at(-1);

    if (!previous || interval.startMs > previous.endMs) {
      merged.push({ ...interval });
      continue;
    }

    previous.endMs = Math.max(previous.endMs, interval.endMs);
  }

  return merged.reduce(
    (sum, interval) => sum + secondsBetween(interval.startMs, interval.endMs),
    0,
  );
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const value of values) {
    const key = keyOf(value);
    const bucket = grouped.get(key);

    if (bucket) {
      bucket.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }

  return grouped;
}

function maxNumber(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function secondsBetween(startMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
