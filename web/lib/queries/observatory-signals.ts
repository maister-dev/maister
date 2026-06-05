import { groupBy, uniqueSorted } from "@/lib/queries/observatory-core";

export type SignalKind = "rework" | "gate" | "retry";

export interface SignalScope {
  projectIds: string[];
  flowIds: string[];
  nodeIds: string[];
}

export interface SignalDrillDown {
  flowId?: string;
  nodeId?: string;
  artifactKind?: string;
  artifactDefId?: string;
}

export interface SignalCluster {
  kind: SignalKind;
  key: string;
  title: string;
  scope: SignalScope;
  occurrenceCount: number;
  affectedRunCount: number;
  affectedProjectCount: number;
  priorityScore: number;
  examples: string[];
  drillDown: SignalDrillDown;
  criticality: null;
  humanConfidence: null;
}

export interface ReworkSignalInput {
  id: string;
  projectId: string;
  runId: string;
  flowId: string;
  stepId: string;
  decision: string | null;
  reworkTarget: string | null;
  workspacePolicy: string | null;
  example?: string | null;
}

export interface GateSignalInput {
  id: string;
  projectId: string;
  runId: string;
  flowId: string;
  nodeId: string;
  gateId: string;
  kind: string;
  mode: string;
  status: string;
  verdict?: {
    verdict?: string;
    reasons?: string[];
    recommendedAction?: string;
    calibration?: { outcome?: string };
  } | null;
}

export interface RetrySignalInput {
  id: string;
  projectId: string;
  runId: string;
  flowId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
  errorCode: string | null;
  exitCode: number | null;
  artifactKind?: string | null;
  artifactDefId?: string | null;
}

type ClusterSeed = {
  kind: SignalKind;
  key: string;
  title: string;
  projectId: string;
  runId: string;
  flowId: string;
  nodeId: string;
  weight: number;
  example?: string | null;
  drillDown: SignalDrillDown;
};

const MAX_EXAMPLES = 3;
const MIN_EXAMPLE_LENGTH = 3;

export function normalizeSignalText(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  const normalized = redactSignalText(value)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

  return normalized.length < MIN_EXAMPLE_LENGTH ? null : normalized;
}

export function redactSignalText(value: string): string {
  return value
    .replace(
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)=([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk|ghp|glpat|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}

export function clusterReworkSignals(
  rows: readonly ReworkSignalInput[],
): SignalCluster[] {
  return clustersFromSeeds(
    rows
      .filter((row) => row.decision === "rework" || row.reworkTarget !== null)
      .map((row) => {
        const reworkTarget = row.reworkTarget ?? "unspecified";
        const workspacePolicy = row.workspacePolicy ?? "unspecified";

        return {
          kind: "rework",
          key: `rework:${row.flowId}:${row.stepId}:${reworkTarget}:${workspacePolicy}`,
          title: `Repeated rework at ${row.stepId}`,
          projectId: row.projectId,
          runId: row.runId,
          flowId: row.flowId,
          nodeId: row.stepId,
          weight: 70,
          example: row.example,
          drillDown: { flowId: row.flowId, nodeId: row.stepId },
        };
      }),
  );
}

export function clusterGateSignals(
  rows: readonly GateSignalInput[],
): SignalCluster[] {
  return clustersFromSeeds(
    rows
      .filter((row) => row.mode === "blocking")
      .filter((row) => row.status === "failed" || row.status === "stale")
      .map((row) => {
        const calibration = row.verdict?.calibration?.outcome ?? "uncalibrated";

        return {
          kind: "gate",
          key: `gate:${row.flowId}:${row.nodeId}:${row.gateId}:${row.status}`,
          title: `Repeated ${row.gateId} gate ${row.status}`,
          projectId: row.projectId,
          runId: row.runId,
          flowId: row.flowId,
          nodeId: row.nodeId,
          weight: row.status === "failed" ? 90 : 80,
          example: firstDefinedText([
            ...(row.verdict?.reasons ?? []),
            row.verdict?.recommendedAction,
            row.verdict?.verdict,
            calibration,
          ]),
          drillDown: { flowId: row.flowId, nodeId: row.nodeId },
        };
      }),
  );
}

export function clusterRetrySignals(
  rows: readonly RetrySignalInput[],
): SignalCluster[] {
  const attemptsByRunNode = groupBy(
    rows,
    (row) => `${row.runId}:${row.flowId}:${row.nodeId}`,
  );
  const retrySeeds: ClusterSeed[] = [];

  for (const attempts of attemptsByRunNode.values()) {
    const latest = attempts.reduce((current, row) =>
      row.attempt > current.attempt ? row : current,
    );
    const retryCount = Math.max(0, latest.attempt - 1);

    if (retryCount === 0) continue;

    const artifactSuffix = latest.artifactDefId
      ? `:${latest.artifactDefId}`
      : latest.artifactKind
        ? `:${latest.artifactKind}`
        : "";
    const errorKey =
      latest.errorCode ?? latest.exitCode?.toString() ?? "unknown";

    retrySeeds.push({
      kind: "retry",
      key: `retry:${latest.flowId}:${latest.nodeId}:${errorKey}${artifactSuffix}`,
      title: `Repeated retries on ${latest.nodeId}`,
      projectId: latest.projectId,
      runId: latest.runId,
      flowId: latest.flowId,
      nodeId: latest.nodeId,
      weight: 60 + retryCount * 10,
      example: latest.errorCode,
      drillDown: {
        flowId: latest.flowId,
        nodeId: latest.nodeId,
        artifactKind: latest.artifactKind ?? undefined,
        artifactDefId: latest.artifactDefId ?? undefined,
      },
    });
  }

  return clustersFromSeeds(retrySeeds);
}

export function rankSignals(
  clusters: readonly SignalCluster[],
): SignalCluster[] {
  return [...clusters].sort((left, right) => {
    const priorityDelta = right.priorityScore - left.priorityScore;

    if (priorityDelta !== 0) return priorityDelta;

    const occurrenceDelta = right.occurrenceCount - left.occurrenceCount;

    if (occurrenceDelta !== 0) return occurrenceDelta;

    return left.key.localeCompare(right.key);
  });
}

function clustersFromSeeds(seeds: readonly ClusterSeed[]): SignalCluster[] {
  return rankSignals(
    [...groupBy(seeds, (seed) => seed.key).entries()].map(([key, rows]) => {
      const first = rows[0];
      const projectIds = uniqueSorted(rows.map((row) => row.projectId));
      const runIds = uniqueSorted(rows.map((row) => row.runId));

      return {
        kind: first?.kind ?? "retry",
        key,
        title: first?.title ?? key,
        scope: {
          projectIds,
          flowIds: uniqueSorted(rows.map((row) => row.flowId)),
          nodeIds: uniqueSorted(rows.map((row) => row.nodeId)),
        },
        occurrenceCount: rows.length,
        affectedRunCount: runIds.length,
        affectedProjectCount: projectIds.length,
        priorityScore: scoreCluster(rows),
        examples: uniqueInOrder(
          rows
            .map((row) => normalizeSignalText(row.example))
            .filter((example): example is string => example !== null),
        ).slice(0, MAX_EXAMPLES),
        drillDown: first?.drillDown ?? {},
        criticality: null,
        humanConfidence: null,
      };
    }),
  );
}

function scoreCluster(rows: readonly ClusterSeed[]): number {
  const baseWeight = rows.reduce((max, row) => Math.max(max, row.weight), 0);
  const affectedRunCount = new Set(rows.map((row) => row.runId)).size;
  const affectedProjectCount = new Set(rows.map((row) => row.projectId)).size;

  return (
    baseWeight +
    rows.length * 10 +
    affectedRunCount * 5 +
    affectedProjectCount * 3
  );
}

function firstDefinedText(
  values: readonly (string | null | undefined)[],
): string | null {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;

    seen.add(value);
    result.push(value);
  }

  return result;
}
