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

export type SignalClusterSource = "instruction" | "gate" | "retry";

export interface SignalCluster {
  key: string;
  source: SignalClusterSource;
  label: string;
  occurrenceCount: number;
  runIds: string[];
  priority: number;
}

type Interval = {
  startMs: number;
  endMs: number;
};

export function latestAttemptsByNode(
  attempts: readonly ObservatoryNodeAttemptInput[],
): Map<string, ObservatoryNodeAttemptInput> {
  const latest = new Map<string, ObservatoryNodeAttemptInput>();

  for (const attempt of attempts) {
    const key = `${attempt.runId}::${attempt.nodeId}`;
    const current = latest.get(key);

    if (!current || attempt.attempt > current.attempt) {
      latest.set(key, attempt);
    }
  }

  return latest;
}

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

export function rankSignalClusters(
  clusters: readonly SignalCluster[],
): SignalCluster[] {
  return [...clusters]
    .map((cluster) => ({
      ...cluster,
      runIds: uniqueSorted(cluster.runIds),
    }))
    .sort((left, right) => {
      const priorityDelta = right.priority - left.priority;

      if (priorityDelta !== 0) return priorityDelta;

      const occurrenceDelta = right.occurrenceCount - left.occurrenceCount;

      if (occurrenceDelta !== 0) return occurrenceDelta;

      return left.key.localeCompare(right.key);
    });
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
