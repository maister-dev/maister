import "server-only";

import type { GlobalRole } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { harnessNeverFiredMin } from "@/lib/instance-config";
import { requireRunProjectId } from "@/lib/runs/run-kind-invariants";
import {
  buildCoverageMap,
  declaredGatesFromManifests,
  detectNeverFired,
  flowNodeKey,
  groupArtifactContributions,
  groupBy,
  rollupAutonomyMetrics,
  rollupCapabilityEffectiveness,
  rollupControlEffectiveness,
  rollupCorrectionMetrics,
  rollupGateFiringStats,
  uniqueSorted,
  type ArtifactContribution,
  type AutonomyMetric,
  type CorrectionMetric,
  type FlowManifestInput,
  type HarnessGateInput,
  type ManifestNodeInput,
  type ObservatoryArtifactInput,
  type ObservatoryHarness,
  type ObservatoryHitlInput,
  type ObservatoryNodeAttemptInput,
  type ObservatoryRunInput,
  type ObservatoryTimedRunInput,
} from "@/lib/queries/observatory-core";
import {
  clusterGateSignals,
  clusterRetrySignals,
  clusterReworkSignals,
  rankSignals,
  type SignalCluster,
} from "@/lib/queries/observatory-signals";

const {
  artifactInstances,
  domainEvents,
  flowRevisions,
  flows,
  gateResults,
  hitlRequests,
  nodeAttemptCostRollups,
  nodeAttempts,
  projectMembers,
  projects,
  runCostRollups,
  runs,
} = schema;

type ArtifactKind = (typeof schema.artifactInstances.$inferSelect)["kind"];
type RunStatus = (typeof schema.runs.$inferSelect)["status"];

const log = pino({
  name: "observatory-queries",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface ObservatoryFilters {
  now?: Date;
  windowDays?: number;
  flowId?: string;
  nodeId?: string;
  artifactKind?: ArtifactKind;
  artifactDefId?: string;
}

export interface ObservatoryProjectSummary {
  projectId: string;
  projectSlug: string;
  projectName: string;
  correction: CorrectionMetric;
  autonomy: AutonomyMetric;
}

export interface ObservatoryFlowSummary {
  flowId: string;
  flowRefId: string;
  correction: CorrectionMetric;
  autonomy: AutonomyMetric;
}

export interface ObservatoryNodeSummary {
  flowId: string;
  nodeId: string;
  nodeType: string;
  runCount: number;
  reworkCount: number;
  retryCount: number;
  correctionRate: number;
}

export interface ObservatoryArtifactSummary {
  artifactKey: string;
  artifactDefId: string | null;
  kind: string;
  artifactCount: number;
  runCount: number;
}

export interface ObservatoryCostSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  resumeTokens: number;
  totalTokens: number;
  projectCount: number;
  flowCount: number;
  nodeCount: number;
}

export interface ObservatoryBudgetSummary {
  budgetEscalations: number;
  budgetTerminations: number;
  // ADR-108 (M40): run.escalated events with reason "hook_trip" — a guardrail
  // liveness breaker (repetition / no_progress) halted + escalated a run.
  hookTripEscalations: number;
}

export interface ObservatoryTotals {
  correction: CorrectionMetric;
  autonomy: AutonomyMetric;
}

export interface ObservatoryPortfolio {
  totals: ObservatoryTotals;
  projects: ObservatoryProjectSummary[];
  flows: ObservatoryFlowSummary[];
  nodes: ObservatoryNodeSummary[];
  artifacts: ObservatoryArtifactSummary[];
  cost: ObservatoryCostSummary;
  budget: ObservatoryBudgetSummary;
  topSignals: SignalCluster[];
  harness: ObservatoryHarness;
}

export interface ObservatoryProject {
  projectId: string;
  totals: ObservatoryTotals;
  flows: ObservatoryFlowSummary[];
  nodes: ObservatoryNodeSummary[];
  artifacts: ObservatoryArtifactSummary[];
  cost: ObservatoryCostSummary;
  budget: ObservatoryBudgetSummary;
  topSignals: SignalCluster[];
  harness: ObservatoryHarness;
}

export interface ObservatoryNodeDetail {
  projectId: string;
  nodeId: string;
  correction: CorrectionMetric;
  autonomy: AutonomyMetric;
  runs: {
    runId: string;
    flowId: string;
    startedAt: Date;
    endedAt: Date | null;
    volatile: boolean;
  }[];
  attempts: {
    id: string;
    runId: string;
    attempt: number;
    status: string;
    errorCode: string | null;
    exitCode: number | null;
  }[];
  gates: {
    id: string;
    runId: string;
    gateId: string;
    kind: string;
    status: string;
  }[];
  hitlWaits: {
    id: string;
    runId: string;
    createdAt: Date;
    respondedAt: Date | null;
  }[];
  artifacts: ObservatoryArtifactSummary[];
  signals: SignalCluster[];
}

type ProjectScopeRow = {
  id: string;
  slug: string;
  name: string;
};

type RunRow = {
  id: string;
  projectId: string;
  flowId: string;
  flowRefId: string;
  flowRevisionId: string | null;
  resolvedCapabilitySet: schema.ResolvedCapabilitySet | null;
  startedAt: Date;
  endedAt: Date | null;
  status: RunStatus;
};

type AttemptRow = ObservatoryNodeAttemptInput;
type HitlRow = ObservatoryHitlInput & {
  stepId: string;
  decision: string | null;
  reworkTarget: string | null;
  workspacePolicy: string | null;
};
type GateRow = {
  id: string;
  runId: string;
  nodeAttemptId: string;
  gateId: string;
  kind: string;
  mode: string;
  status: string;
  verdict: schema.GateVerdict | null;
};
type ArtifactRow = ObservatoryArtifactInput;
type RevisionRow = {
  id: string;
  manifest: unknown;
};

function emptyCostSummary(): ObservatoryCostSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    resumeTokens: 0,
    totalTokens: 0,
    projectCount: 0,
    flowCount: 0,
    nodeCount: 0,
  };
}

async function getCostSummary(
  client: NodePgDatabase<typeof schema>,
  projectScope: readonly ProjectScopeRow[],
  filters: ObservatoryFilters,
): Promise<ObservatoryCostSummary> {
  if (projectScope.length === 0) return emptyCostSummary();

  const projectIds = projectScope.map((project) => project.id);

  const runCostConditions: SQL[] = [
    inArray(runCostRollups.projectId, projectIds),
  ];
  const nodeCostConditions: SQL[] = [
    inArray(nodeAttemptCostRollups.projectId, projectIds),
  ];

  if (filters.flowId) {
    runCostConditions.push(eq(runCostRollups.flowId, filters.flowId));
  }
  if (filters.nodeId) {
    nodeCostConditions.push(eq(nodeAttemptCostRollups.nodeId, filters.nodeId));
  }

  const [runRows, nodeRows] = await Promise.all([
    client
      .select({
        projectId: runCostRollups.projectId,
        flowId: runCostRollups.flowId,
        inputTokens: runCostRollups.inputTokens,
        outputTokens: runCostRollups.outputTokens,
        cacheReadTokens: runCostRollups.cacheReadTokens,
        cacheCreationTokens: runCostRollups.cacheCreationTokens,
        resumeInputTokens: runCostRollups.resumeInputTokens,
        resumeOutputTokens: runCostRollups.resumeOutputTokens,
        resumeCacheReadTokens: runCostRollups.resumeCacheReadTokens,
        resumeCacheCreationTokens: runCostRollups.resumeCacheCreationTokens,
      })
      .from(runCostRollups)
      .where(and(...runCostConditions)),
    client
      .select({ nodeId: nodeAttemptCostRollups.nodeId })
      .from(nodeAttemptCostRollups)
      .where(and(...nodeCostConditions)),
  ]);

  const projectsWithCost = new Set<string>();
  const flowsWithCost = new Set<string>();
  const nodesWithCost = new Set<string>();

  const totals = runRows.reduce(
    (acc, row) => {
      if (row.projectId) projectsWithCost.add(row.projectId);
      if (row.flowId) flowsWithCost.add(row.flowId);

      return {
        inputTokens: acc.inputTokens + row.inputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + row.cacheCreationTokens,
        resumeTokens:
          acc.resumeTokens +
          row.resumeInputTokens +
          row.resumeOutputTokens +
          row.resumeCacheReadTokens +
          row.resumeCacheCreationTokens,
      };
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      resumeTokens: 0,
    },
  );

  for (const row of nodeRows) nodesWithCost.add(row.nodeId);

  log.debug(
    {
      projectCount: projectScope.length,
      runCostRowCount: runRows.length,
      nodeCostRowCount: nodeRows.length,
    },
    "[FIX:observatory-cost-read] cost summary read from stored rollups",
  );

  return {
    ...totals,
    totalTokens:
      totals.inputTokens +
      totals.outputTokens +
      totals.cacheReadTokens +
      totals.cacheCreationTokens,
    projectCount: projectsWithCost.size,
    flowCount: flowsWithCost.size,
    nodeCount: nodesWithCost.size,
  };
}

function emptyBudgetSummary(): ObservatoryBudgetSummary {
  return {
    budgetEscalations: 0,
    budgetTerminations: 0,
    hookTripEscalations: 0,
  };
}

async function getBudgetSummary(
  client: NodePgDatabase<typeof schema>,
  projectScope: readonly ProjectScopeRow[],
  filters: ObservatoryFilters,
  now: Date,
): Promise<ObservatoryBudgetSummary> {
  if (projectScope.length === 0) return emptyBudgetSummary();

  const projectIds = projectScope.map((project) => project.id);
  const since = new Date(
    now.getTime() - (filters.windowDays ?? 30) * 24 * 60 * 60 * 1000,
  );

  // Terminate emits are not normalized — flow/scratch use BUDGET_EXCEEDED, the
  // agent finalizer uses budget_breach, the tree-root uses budget_exceeded;
  // all three must be matched. WARN is a logExecPolicyAction log line (no
  // domain event) so it is not surfaceable here. ADR-108: a hook_trip escalate
  // shares the run.escalated kind, distinguished by reason. One grouped scan,
  // no N+1.
  const rows = await client
    .select({
      escalations: sql<number>`count(*) filter (where ${domainEvents.kind} = 'run.escalated' and ${domainEvents.payload}->>'reason' = 'budget_exceeded')::int`,
      terminations: sql<number>`count(*) filter (where ${domainEvents.kind} = 'run.failed' and ${domainEvents.payload}->>'reason' in ('budget_exceeded', 'BUDGET_EXCEEDED', 'budget_breach'))::int`,
      hookTrips: sql<number>`count(*) filter (where ${domainEvents.kind} = 'run.escalated' and ${domainEvents.payload}->>'reason' = 'hook_trip')::int`,
    })
    .from(domainEvents)
    .where(
      and(
        inArray(domainEvents.projectId, projectIds),
        gte(domainEvents.createdAt, since),
        lte(domainEvents.createdAt, now),
        inArray(domainEvents.kind, ["run.escalated", "run.failed"]),
      ),
    );

  const row = rows[0];

  return {
    budgetEscalations: row?.escalations ?? 0,
    budgetTerminations: row?.terminations ?? 0,
    hookTripEscalations: row?.hookTrips ?? 0,
  };
}

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export async function getPortfolioObservatory(
  userId: string,
  globalRole: GlobalRole,
  filters: ObservatoryFilters = {},
  client: NodePgDatabase<typeof schema> = db(),
): Promise<ObservatoryPortfolio> {
  const now = filters.now ?? new Date();
  const visibleProjects = await getVisibleProjects(client, userId, globalRole);

  log.debug(
    {
      projectCount: visibleProjects.length,
      windowDays: filters.windowDays ?? 30,
    },
    "getPortfolioObservatory scope resolved",
  );

  const readModel = await loadObservatoryRows(
    client,
    visibleProjects,
    filters,
    now,
  );
  const portfolio = buildPortfolio(
    readModel,
    visibleProjects,
    now,
    harnessNeverFiredMin(),
  );
  const [cost, budget] = await Promise.all([
    getCostSummary(client, visibleProjects, filters),
    getBudgetSummary(client, visibleProjects, filters, now),
  ]);

  log.info(
    {
      projectCount: portfolio.projects.length,
      runCount: portfolio.totals.correction.runCount,
      nodeCount: portfolio.nodes.length,
    },
    "getPortfolioObservatory aggregated",
  );

  return { ...portfolio, cost, budget };
}

export async function getProjectObservatory(
  projectId: string,
  filters: ObservatoryFilters = {},
  client: NodePgDatabase<typeof schema> = db(),
): Promise<ObservatoryProject> {
  const now = filters.now ?? new Date();
  const projectRows = await client
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)));
  const project = projectRows[0];

  if (!project) {
    return emptyProject(projectId, now);
  }

  const readModel = await loadObservatoryRows(client, [project], filters, now);
  const portfolio = buildPortfolio(
    readModel,
    [project],
    now,
    harnessNeverFiredMin(),
  );
  const [cost, budget] = await Promise.all([
    getCostSummary(client, [project], filters),
    getBudgetSummary(client, [project], filters, now),
  ]);

  log.info(
    {
      projectId,
      runCount: portfolio.totals.correction.runCount,
      nodeCount: portfolio.nodes.length,
    },
    "getProjectObservatory aggregated",
  );

  return {
    projectId,
    totals: portfolio.totals,
    flows: portfolio.flows,
    nodes: portfolio.nodes,
    artifacts: portfolio.artifacts,
    cost,
    budget,
    topSignals: portfolio.topSignals,
    harness: portfolio.harness,
  };
}

export async function getNodeObservatoryDetail(
  projectId: string,
  nodeId: string,
  filters: ObservatoryFilters = {},
  client: NodePgDatabase<typeof schema> = db(),
): Promise<ObservatoryNodeDetail> {
  const now = filters.now ?? new Date();
  // Callers that drilled in from a heatmap/signal row pass the originating
  // `flowId` so this detail reconciles with the per-flow portfolio row; without
  // it, a node id reused across flows aggregates across all of them.
  const effectiveFilters = { ...filters, nodeId };
  const projectRows = await client
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.archivedAt)));
  const project = projectRows[0];

  if (!project) {
    return emptyNodeDetail(projectId, nodeId);
  }

  const readModel = await loadObservatoryRows(
    client,
    [project],
    effectiveFilters,
    now,
  );
  const nodeAttemptsForDetail = readModel.attempts.filter(
    (attempt) => attempt.nodeId === nodeId,
  );
  const detailRunIds = uniqueSorted(
    nodeAttemptsForDetail.map((row) => row.runId),
  );
  const detailRunSet = new Set(detailRunIds);
  const runsForDetail = readModel.runs.filter((run) =>
    detailRunSet.has(run.id),
  );
  const gatesForDetail = readModel.gates.filter((gate) =>
    nodeAttemptsForDetail.some((attempt) => attempt.id === gate.nodeAttemptId),
  );
  const hitlForDetail = readModel.hitl.filter((hitl) =>
    detailRunSet.has(hitl.runId),
  );
  const artifactsForDetail = summarizeArtifacts(
    groupArtifactContributions(
      readModel.artifacts.filter((artifact) =>
        detailRunSet.has(artifact.runId),
      ),
    ),
  );
  const signalsForDetail = buildTopSignals({
    runs: runsForDetail,
    attempts: nodeAttemptsForDetail,
    gates: gatesForDetail,
    hitl: hitlForDetail.filter((hitl) => hitl.stepId === nodeId),
    artifacts: readModel.artifacts.filter((artifact) =>
      detailRunSet.has(artifact.runId),
    ),
  });

  log.debug(
    {
      projectId,
      nodeId,
      runCount: runsForDetail.length,
      attemptCount: nodeAttemptsForDetail.length,
    },
    "getNodeObservatoryDetail aggregated",
  );

  return {
    projectId,
    nodeId,
    correction: rollupCorrectionMetrics({
      runs: runsForDetail.map(toCorrectionRun),
      nodeAttempts: nodeAttemptsForDetail,
    }),
    autonomy: rollupAutonomyMetrics({
      now,
      runs: runsForDetail.map(toTimedRun),
      hitlRequests: hitlForDetail,
    }),
    runs: runsForDetail.map((run) => ({
      runId: run.id,
      flowId: run.flowId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      volatile: run.endedAt === null,
    })),
    attempts: nodeAttemptsForDetail
      .map((attempt) => ({
        id: attempt.id,
        runId: attempt.runId,
        attempt: attempt.attempt,
        status: attempt.status,
        errorCode: attempt.errorCode ?? null,
        exitCode: attempt.exitCode ?? null,
      }))
      .sort((left, right) => left.attempt - right.attempt),
    gates: gatesForDetail.map((gate) => ({
      id: gate.id,
      runId: gate.runId,
      gateId: gate.gateId,
      kind: gate.kind,
      status: gate.status,
    })),
    hitlWaits: hitlForDetail.map((hitl) => ({
      id: hitl.id,
      runId: hitl.runId,
      createdAt: hitl.createdAt,
      respondedAt: hitl.respondedAt,
    })),
    artifacts: artifactsForDetail,
    signals: signalsForDetail,
  };
}

async function getVisibleProjects(
  client: NodePgDatabase<typeof schema>,
  userId: string,
  globalRole: GlobalRole,
): Promise<ProjectScopeRow[]> {
  if (globalRole === "admin") {
    return client
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
      })
      .from(projects)
      .where(isNull(projects.archivedAt));
  }

  return client
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(projects)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
    .where(and(eq(projectMembers.userId, userId), isNull(projects.archivedAt)));
}

async function loadObservatoryRows(
  client: NodePgDatabase<typeof schema>,
  projectScope: readonly ProjectScopeRow[],
  filters: ObservatoryFilters,
  now: Date,
): Promise<{
  runs: RunRow[];
  attempts: AttemptRow[];
  gates: GateRow[];
  hitl: HitlRow[];
  artifacts: ArtifactRow[];
  revisions: RevisionRow[];
}> {
  const emptyRows = {
    runs: [],
    attempts: [],
    gates: [],
    hitl: [],
    artifacts: [],
    revisions: [],
  };

  if (projectScope.length === 0) {
    return emptyRows;
  }

  const projectIds = projectScope.map((project) => project.id);
  const since = new Date(
    now.getTime() - (filters.windowDays ?? 30) * 24 * 60 * 60 * 1000,
  );
  const runPredicates: SQL[] = [
    inArray(runs.projectId, projectIds),
    eq(runs.runKind, "flow"),
    gte(runs.startedAt, since),
  ];

  if (filters.flowId) runPredicates.push(eq(runs.flowId, filters.flowId));

  const runRows = await client
    .select({
      id: runs.id,
      projectId: runs.projectId,
      flowId: runs.flowId,
      flowRefId: flows.flowRefId,
      flowRevisionId: runs.flowRevisionId,
      resolvedCapabilitySet: runs.resolvedCapabilitySet,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      status: runs.status,
    })
    .from(runs)
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(and(...runPredicates));
  const typedRuns: RunRow[] = runRows
    .flatMap((run) =>
      run.flowId === null
        ? []
        : [
            {
              ...run,
              flowId: run.flowId,
              // Inner join on flows ⇒ a flow run ⇒ non-null project (ADR-097).
              projectId: requireRunProjectId(run.projectId, run.id),
            },
          ],
    )
    .sort(
      (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
    );
  const runIds = typedRuns.map((run) => run.id);

  if (runIds.length === 0) {
    return emptyRows;
  }

  const attemptPredicates: SQL[] = [inArray(nodeAttempts.runId, runIds)];

  if (filters.nodeId) {
    attemptPredicates.push(eq(nodeAttempts.nodeId, filters.nodeId));
  }

  const attemptRows: AttemptRow[] = await client
    .select({
      id: nodeAttempts.id,
      runId: nodeAttempts.runId,
      nodeId: nodeAttempts.nodeId,
      nodeType: nodeAttempts.nodeType,
      attempt: nodeAttempts.attempt,
      status: nodeAttempts.status,
      errorCode: nodeAttempts.errorCode,
      exitCode: nodeAttempts.exitCode,
    })
    .from(nodeAttempts)
    .where(and(...attemptPredicates));

  if (!filters.nodeId) {
    const attemptRunIds = new Set(attemptRows.map((attempt) => attempt.runId));
    const noLedgerRunIds = runIds.filter((runId) => !attemptRunIds.has(runId));

    if (noLedgerRunIds.length > 0) {
      log.warn(
        {
          runCount: noLedgerRunIds.length,
          projectCount: projectScope.length,
        },
        "observatory excluded legacy flow runs without node_attempts",
      );
    }
  }

  const scopedRunIds = uniqueSorted(
    attemptRows.map((attempt) => attempt.runId),
  );

  if (scopedRunIds.length === 0) {
    return emptyRows;
  }

  const artifactPredicates: SQL[] = [
    inArray(artifactInstances.runId, scopedRunIds),
  ];
  const artifactFilterApplied = Boolean(
    filters.artifactKind || filters.artifactDefId,
  );

  if (filters.artifactKind) {
    artifactPredicates.push(eq(artifactInstances.kind, filters.artifactKind));
  }
  if (filters.artifactDefId) {
    artifactPredicates.push(
      eq(artifactInstances.artifactDefId, filters.artifactDefId),
    );
  }

  const artifactRows: ArtifactRow[] = await client
    .select({
      id: artifactInstances.id,
      runId: artifactInstances.runId,
      nodeAttemptId: artifactInstances.nodeAttemptId,
      artifactDefId: artifactInstances.artifactDefId,
      kind: artifactInstances.kind,
    })
    .from(artifactInstances)
    .where(and(...artifactPredicates));
  const effectiveRunIds = artifactFilterApplied
    ? uniqueSorted(artifactRows.map((artifact) => artifact.runId))
    : scopedRunIds;

  if (effectiveRunIds.length === 0) {
    return emptyRows;
  }

  const effectiveRunSet = new Set(effectiveRunIds);
  const effectiveAttempts = attemptRows.filter((attempt) =>
    effectiveRunSet.has(attempt.runId),
  );

  log.debug(
    {
      candidateRunCount: runIds.length,
      eligibleRunCount: effectiveRunIds.length,
      artifactFilterApplied,
      artifactRunCount: uniqueSorted(
        artifactRows.map((artifact) => artifact.runId),
      ).length,
      nodeFilterApplied: Boolean(filters.nodeId),
    },
    "observatory eligible run scope resolved",
  );

  const scopedRevisionIds = uniqueSorted(
    typedRuns.flatMap((run) =>
      effectiveRunSet.has(run.id) && run.flowRevisionId !== null
        ? [run.flowRevisionId]
        : [],
    ),
  );
  const [gateRows, hitlRows, revisionRows] = await Promise.all([
    client
      .select({
        id: gateResults.id,
        runId: gateResults.runId,
        nodeAttemptId: gateResults.nodeAttemptId,
        gateId: gateResults.gateId,
        kind: gateResults.kind,
        mode: gateResults.mode,
        status: gateResults.status,
        verdict: gateResults.verdict,
      })
      .from(gateResults)
      .where(inArray(gateResults.runId, effectiveRunIds)),
    client
      .select({
        id: hitlRequests.id,
        runId: hitlRequests.runId,
        stepId: hitlRequests.stepId,
        createdAt: hitlRequests.createdAt,
        respondedAt: hitlRequests.respondedAt,
        decision: hitlRequests.decision,
        reworkTarget: hitlRequests.reworkTarget,
        workspacePolicy: hitlRequests.workspacePolicy,
      })
      .from(hitlRequests)
      .where(inArray(hitlRequests.runId, effectiveRunIds)),
    scopedRevisionIds.length === 0
      ? Promise.resolve([] as RevisionRow[])
      : client
          .select({
            id: flowRevisions.id,
            manifest: flowRevisions.manifest,
          })
          .from(flowRevisions)
          .where(inArray(flowRevisions.id, scopedRevisionIds)),
  ]);

  log.debug(
    {
      projectCount: projectScope.length,
      runCount: typedRuns.length,
      attemptCount: effectiveAttempts.length,
      gateCount: gateRows.length,
      hitlCount: hitlRows.length,
      artifactCount: artifactRows.length,
    },
    "loadObservatoryRows fetched",
  );

  return {
    runs: typedRuns.filter((run) => effectiveRunSet.has(run.id)),
    attempts: effectiveAttempts,
    gates: gateRows,
    hitl: hitlRows,
    artifacts: artifactRows,
    revisions: revisionRows,
  };
}

function buildPortfolio(
  rows: {
    runs: RunRow[];
    attempts: AttemptRow[];
    gates: GateRow[];
    hitl: HitlRow[];
    artifacts: ArtifactRow[];
    revisions: RevisionRow[];
  },
  projectScope: readonly ProjectScopeRow[],
  now: Date,
  minExecutions: number,
): Omit<ObservatoryPortfolio, "cost" | "budget"> {
  const projectsById = new Map(
    projectScope.map((project) => [project.id, project]),
  );
  const flowGroups = groupBy(rows.runs, (run) => run.flowId);
  const runById = new Map(rows.runs.map((run) => [run.id, run]));
  const nodeGroups = groupBy(rows.attempts, (attempt) => {
    const run = runById.get(attempt.runId);

    return `${run?.projectId ?? "unknown"}::${run?.flowId ?? "unknown"}::${attempt.nodeId}::${attempt.nodeType}`;
  });
  const topSignals = buildTopSignals(rows);
  const projectSummaries = projectScope.map((project) => {
    const projectRuns = rows.runs.filter((run) => run.projectId === project.id);
    const projectRunSet = new Set(projectRuns.map((run) => run.id));

    return {
      projectId: project.id,
      projectSlug: project.slug,
      projectName: project.name,
      correction: rollupCorrectionMetrics({
        runs: projectRuns.map(toCorrectionRun),
        nodeAttempts: rows.attempts.filter((attempt) =>
          projectRunSet.has(attempt.runId),
        ),
      }),
      autonomy: rollupAutonomyMetrics({
        now,
        runs: projectRuns.map(toTimedRun),
        hitlRequests: rows.hitl.filter((hitl) => projectRunSet.has(hitl.runId)),
      }),
    };
  });

  return {
    totals: {
      correction: rollupCorrectionMetrics({
        runs: rows.runs.map(toCorrectionRun),
        nodeAttempts: rows.attempts,
      }),
      autonomy: rollupAutonomyMetrics({
        now,
        runs: rows.runs.map(toTimedRun),
        hitlRequests: rows.hitl,
      }),
    },
    projects: projectSummaries.filter((project) =>
      projectsById.has(project.projectId),
    ),
    flows: [...flowGroups.entries()].map(([flowId, flowRuns]) => {
      const flowRunSet = new Set(flowRuns.map((run) => run.id));
      const flowRefId = flowRuns[0]?.flowRefId ?? flowId;

      return {
        flowId,
        flowRefId,
        correction: rollupCorrectionMetrics({
          runs: flowRuns.map(toCorrectionRun),
          nodeAttempts: rows.attempts.filter((attempt) =>
            flowRunSet.has(attempt.runId),
          ),
        }),
        autonomy: rollupAutonomyMetrics({
          now,
          runs: flowRuns.map(toTimedRun),
          hitlRequests: rows.hitl.filter((hitl) => flowRunSet.has(hitl.runId)),
        }),
      };
    }),
    nodes: [...nodeGroups.entries()]
      .flatMap(([, attempts]) => {
        const firstAttempt = attempts[0];
        const firstRun = firstAttempt ? runById.get(firstAttempt.runId) : null;

        if (!firstAttempt || !firstRun) return [];

        const correction = rollupCorrectionMetrics({
          runs: rows.runs.map(toCorrectionRun),
          nodeAttempts: attempts,
        });

        return [
          {
            flowId: firstRun.flowId,
            nodeId: firstAttempt.nodeId,
            nodeType: firstAttempt.nodeType,
            runCount: correction.runCount,
            reworkCount: correction.reworkCount,
            retryCount: correction.retryCount,
            correctionRate: correction.correctionRate,
          },
        ];
      })
      .sort(
        (left, right) =>
          left.nodeId.localeCompare(right.nodeId) ||
          left.flowId.localeCompare(right.flowId) ||
          left.nodeType.localeCompare(right.nodeType),
      ),
    artifacts: summarizeArtifacts(groupArtifactContributions(rows.artifacts)),
    topSignals,
    harness: buildHarness(rows, minExecutions),
  };
}

function buildHarness(
  rows: {
    runs: RunRow[];
    attempts: AttemptRow[];
    gates: GateRow[];
    revisions: RevisionRow[];
  },
  minExecutions: number,
): ObservatoryHarness {
  const runById = new Map(rows.runs.map((run) => [run.id, run]));
  const attemptById = new Map(
    rows.attempts.map((attempt) => [attempt.id, attempt]),
  );
  const harnessGates: HarnessGateInput[] = rows.gates.flatMap((gate) => {
    const run = runById.get(gate.runId);
    const attempt = attemptById.get(gate.nodeAttemptId);

    if (!run || !attempt) return [];

    return [
      {
        projectId: run.projectId,
        flowId: run.flowId,
        flowRefId: run.flowRefId,
        nodeId: attempt.nodeId,
        nodeAttemptId: gate.nodeAttemptId,
        gateId: gate.gateId,
        kind: gate.kind,
        mode: gate.mode,
        status: gate.status,
      },
    ];
  });
  const firing = rollupGateFiringStats(harnessGates);
  const manifests = parseRevisionManifests(rows.revisions, rows.runs);

  return {
    firing,
    neverFired: detectNeverFired({
      declaredGates: declaredGatesFromManifests(manifests),
      firingStats: firing.groups,
      minExecutions,
    }),
    effectiveness: {
      gates: rollupControlEffectiveness({
        gates: harnessGates,
        attempts: rows.attempts,
      }),
      capabilities: rollupCapabilityEffectiveness({
        runs: rows.runs.map((run) => ({
          id: run.id,
          active: run.endedAt === null,
          capabilities:
            run.resolvedCapabilitySet === null
              ? null
              : run.resolvedCapabilitySet.capabilities.map((capability) => ({
                  refId: capability.refId,
                  kind: capability.kind,
                })),
        })),
        attempts: rows.attempts,
      }),
    },
    coverage: buildCoverageMap({
      manifests,
      nodeAttemptCounts: countNodeAttempts(rows.attempts, runById),
    }),
  };
}

function countNodeAttempts(
  attempts: readonly AttemptRow[],
  runById: ReadonlyMap<string, RunRow>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const attempt of attempts) {
    const run = runById.get(attempt.runId);

    if (!run) continue;
    const key = flowNodeKey(run.flowId, attempt.nodeId);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function parseRevisionManifests(
  revisions: readonly RevisionRow[],
  runRows: readonly RunRow[],
): FlowManifestInput[] {
  const flowsByRevision = new Map<string, Map<string, string>>();

  for (const run of runRows) {
    if (run.flowRevisionId === null) continue;

    const flowRefIds =
      flowsByRevision.get(run.flowRevisionId) ?? new Map<string, string>();

    flowRefIds.set(run.flowId, run.flowRefId);
    flowsByRevision.set(run.flowRevisionId, flowRefIds);
  }

  return revisions.flatMap((revision) => {
    const flowRefIds = flowsByRevision.get(revision.id);

    if (!flowRefIds) return [];

    const nodes = parseManifestNodes(revision.manifest);

    if (nodes === null) {
      log.warn(
        { flowRevisionId: revision.id },
        "coverage: manifest parse failed — revision skipped",
      );

      return [];
    }

    return [...flowRefIds.entries()].map(([flowId, flowRefId]) => ({
      flowId,
      flowRefId,
      revisionId: revision.id,
      nodes,
    }));
  });
}

function parseManifestNodes(manifest: unknown): ManifestNodeInput[] | null {
  if (manifest === null || typeof manifest !== "object") return null;

  const nodes = (manifest as Record<string, unknown>).nodes;

  // Legacy linear (steps-only) manifests have no graph nodes — and nothing
  // declared for the coverage map.
  if (nodes === undefined) return [];
  if (!Array.isArray(nodes)) return null;

  const parsed: ManifestNodeInput[] = [];

  for (const node of nodes) {
    if (node === null || typeof node !== "object") return null;

    const record = node as Record<string, unknown>;

    if (typeof record.id !== "string") return null;

    const gates = parseManifestGates(record.pre_finish);

    if (gates === null) return null;

    parsed.push({
      nodeId: record.id,
      gates,
      guideCount: countGuides(record.settings),
    });
  }

  return parsed;
}

function parseManifestGates(
  preFinish: unknown,
): { gateId: string; kind: string; mode: string }[] | null {
  if (preFinish === undefined || preFinish === null) return [];
  if (typeof preFinish !== "object") return null;

  const gates = (preFinish as Record<string, unknown>).gates;

  if (gates === undefined || gates === null) return [];
  if (!Array.isArray(gates)) return null;

  const parsed: { gateId: string; kind: string; mode: string }[] = [];

  for (const gate of gates) {
    if (gate === null || typeof gate !== "object") return null;

    const record = gate as Record<string, unknown>;

    if (typeof record.id !== "string" || typeof record.kind !== "string") {
      return null;
    }

    parsed.push({
      gateId: record.id,
      kind: record.kind,
      // mirrors the gateSchema zod default
      mode: record.mode === "advisory" ? "advisory" : "blocking",
    });
  }

  return parsed;
}

function countGuides(settings: unknown): number {
  if (settings === null || typeof settings !== "object") return 0;

  const record = settings as Record<string, unknown>;

  return ["skills", "rules", "restrictions"].reduce((sum, key) => {
    const value = record[key];

    return sum + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

function emptyHarness(): ObservatoryHarness {
  return {
    firing: { groups: [], byKind: [] },
    neverFired: [],
    effectiveness: { gates: [], capabilities: [] },
    coverage: [],
  };
}

function buildTopSignals(rows: {
  runs: RunRow[];
  attempts: AttemptRow[];
  gates: GateRow[];
  hitl: HitlRow[];
  artifacts: ArtifactRow[];
}): SignalCluster[] {
  const runById = new Map(rows.runs.map((run) => [run.id, run]));
  const attemptById = new Map(
    rows.attempts.map((attempt) => [attempt.id, attempt]),
  );
  const artifactsByAttemptId = groupBy(
    rows.artifacts.filter((artifact) => artifact.nodeAttemptId !== null),
    (artifact) => artifact.nodeAttemptId ?? "",
  );
  const reworkSignals = clusterReworkSignals(
    rows.hitl.flatMap((hitl) => {
      const run = runById.get(hitl.runId);

      if (!run) return [];

      return [
        {
          id: hitl.id,
          projectId: run.projectId,
          runId: hitl.runId,
          flowId: run.flowId,
          stepId: hitl.stepId,
          decision: hitl.decision,
          reworkTarget: hitl.reworkTarget,
          workspacePolicy: hitl.workspacePolicy,
        },
      ];
    }),
  );
  const gateSignals = clusterGateSignals(
    rows.gates.flatMap((gate) => {
      const run = runById.get(gate.runId);
      const attempt = attemptById.get(gate.nodeAttemptId);

      if (!run || !attempt) return [];

      return [
        {
          id: gate.id,
          projectId: run.projectId,
          runId: gate.runId,
          flowId: run.flowId,
          nodeId: attempt.nodeId,
          gateId: gate.gateId,
          kind: gate.kind,
          mode: gate.mode,
          status: gate.status,
          verdict: gate.verdict,
        },
      ];
    }),
  );
  const retrySignals = clusterRetrySignals(
    rows.attempts.flatMap((attempt) => {
      const run = runById.get(attempt.runId);

      if (!run) return [];

      const firstArtifact = artifactsByAttemptId.get(attempt.id)?.[0];

      return [
        {
          id: attempt.id,
          projectId: run.projectId,
          runId: attempt.runId,
          flowId: run.flowId,
          nodeId: attempt.nodeId,
          nodeType: attempt.nodeType,
          attempt: attempt.attempt,
          errorCode: attempt.errorCode ?? null,
          exitCode: attempt.exitCode ?? null,
          artifactKind: firstArtifact?.kind ?? null,
          artifactDefId: firstArtifact?.artifactDefId ?? null,
        },
      ];
    }),
  );
  const topSignals = rankSignals([
    ...reworkSignals,
    ...gateSignals,
    ...retrySignals,
  ]).slice(0, 10);

  log.debug(
    {
      reworkCandidateCount: reworkSignals.length,
      gateCandidateCount: gateSignals.length,
      retryCandidateCount: retrySignals.length,
      returnedSignalCount: topSignals.length,
      discardedUnsafeTextCount: 0,
    },
    "observatory signal clusters ranked",
  );

  return topSignals;
}

function summarizeArtifacts(
  contributions: readonly ArtifactContribution[],
): ObservatoryArtifactSummary[] {
  return contributions.map((artifact) => ({
    artifactKey: artifact.key,
    artifactDefId: artifact.artifactDefId,
    kind: artifact.kind,
    artifactCount: artifact.artifactCount,
    runCount: artifact.runIds.length,
  }));
}

function emptyProject(projectId: string, now: Date): ObservatoryProject {
  return {
    projectId,
    totals: {
      correction: rollupCorrectionMetrics({ runs: [], nodeAttempts: [] }),
      autonomy: rollupAutonomyMetrics({ now, runs: [], hitlRequests: [] }),
    },
    flows: [],
    nodes: [],
    artifacts: [],
    cost: emptyCostSummary(),
    budget: emptyBudgetSummary(),
    topSignals: [],
    harness: emptyHarness(),
  };
}

function emptyNodeDetail(
  projectId: string,
  nodeId: string,
): ObservatoryNodeDetail {
  return {
    projectId,
    nodeId,
    correction: rollupCorrectionMetrics({ runs: [], nodeAttempts: [] }),
    autonomy: rollupAutonomyMetrics({
      now: new Date(0),
      runs: [],
      hitlRequests: [],
    }),
    runs: [],
    attempts: [],
    gates: [],
    hitlWaits: [],
    artifacts: [],
    signals: [],
  };
}

function toCorrectionRun(run: RunRow): ObservatoryRunInput {
  return {
    id: run.id,
    active: run.endedAt === null,
  };
}

function toTimedRun(run: RunRow): ObservatoryTimedRunInput {
  return {
    id: run.id,
    active: run.endedAt === null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}
