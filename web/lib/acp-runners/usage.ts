import "server-only";

import type { InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  flowRevisions,
  flowRunnerRemaps,
  platformAcpRunners,
  platformRuntimeSettings,
  projectFlowRunnerDefaults,
  projects,
  runs,
} from "@/lib/db/schema";

type Db = {
  select: () => {
    from: <TTable extends PgTable>(
      table: TTable,
    ) => Promise<InferSelectModel<TTable>[]> | InferSelectModel<TTable>[];
  };
};

const ACTIVE_RUN_STATUSES = new Set([
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
  "Crashed",
]);

export type RunnerUsageReference =
  | { readonly kind: "platformDefault"; readonly runnerId: string }
  | {
      readonly kind: "projectDefault";
      readonly projectId: string;
      readonly runnerId: string;
    }
  | {
      readonly kind: "platformFlowDefault";
      readonly flowRevisionId: string;
      readonly flowRefId: string;
      readonly runnerId: string;
    }
  | {
      readonly kind: "projectFlowDefault";
      readonly projectId: string;
      readonly flowId: string;
      readonly runnerId: string;
    }
  | {
      readonly kind: "flowStepRemap";
      readonly projectId: string | null;
      readonly flowRevisionId: string;
      readonly slotKey: string;
      readonly mappedRunnerId: string;
    }
  | {
      readonly kind: "activeRun";
      readonly runId: string;
      // ADR-097: null for a project-less local-package assistant run (still
      // pins its runner → still blocks deletion).
      readonly projectId: string | null;
      readonly runnerId: string;
    }
  | {
      readonly kind: "historicalRunSnapshot";
      readonly runId: string;
      readonly projectId: string | null;
      readonly runnerId: string;
    }
  | {
      readonly kind: "scratchRun";
      readonly runId: string;
      readonly projectId: string | null;
      readonly runnerId: string;
    };

export type SidecarUsageReference = {
  readonly kind: "runnerSidecar";
  readonly runnerId: string;
  readonly sidecarId: string;
};

type RunnerUsageInput = {
  readonly runnerId: string;
  readonly platformDefaultRunnerId?: string | null;
  readonly projectDefaults: readonly {
    readonly projectId: string;
    readonly runnerId?: string | null;
  }[];
  readonly platformFlowDefaults: readonly {
    readonly flowRevisionId: string;
    readonly flowRefId: string;
    readonly runnerId?: string | null;
  }[];
  readonly projectFlowDefaults: readonly {
    readonly projectId: string;
    readonly flowId: string;
    readonly runnerId?: string | null;
  }[];
  readonly flowStepRemaps: readonly {
    readonly projectId?: string | null;
    readonly flowRevisionId: string;
    readonly slotKey: string;
    readonly mappedRunnerId?: string | null;
  }[];
  readonly activeRuns: readonly {
    readonly runId: string;
    readonly projectId: string | null;
    readonly runnerId?: string | null;
  }[];
  readonly historicalRunSnapshots: readonly {
    readonly runId: string;
    readonly projectId: string | null;
    readonly runnerSnapshot?: { readonly id?: string | null } | null;
  }[];
  readonly scratchRuns: readonly {
    readonly runId: string;
    readonly projectId: string | null;
    readonly runnerId?: string | null;
  }[];
};

type SidecarUsageInput = {
  readonly sidecarId: string;
  readonly runners: readonly {
    readonly runnerId: string;
    readonly sidecarId?: string | null;
  }[];
};

export function collectRunnerUsageReferences(
  input: RunnerUsageInput,
): RunnerUsageReference[] {
  const refs: RunnerUsageReference[] = [];

  if (input.platformDefaultRunnerId === input.runnerId) {
    refs.push({ kind: "platformDefault", runnerId: input.runnerId });
  }

  for (const project of input.projectDefaults) {
    if (project.runnerId !== input.runnerId) continue;
    refs.push({
      kind: "projectDefault",
      projectId: project.projectId,
      runnerId: input.runnerId,
    });
  }

  for (const flow of input.platformFlowDefaults) {
    if (flow.runnerId !== input.runnerId) continue;
    refs.push({
      kind: "platformFlowDefault",
      flowRevisionId: flow.flowRevisionId,
      flowRefId: flow.flowRefId,
      runnerId: input.runnerId,
    });
  }

  for (const flow of input.projectFlowDefaults) {
    if (flow.runnerId !== input.runnerId) continue;
    refs.push({
      kind: "projectFlowDefault",
      projectId: flow.projectId,
      flowId: flow.flowId,
      runnerId: input.runnerId,
    });
  }

  for (const remap of input.flowStepRemaps) {
    if (remap.mappedRunnerId !== input.runnerId) continue;
    refs.push({
      kind: "flowStepRemap",
      projectId: remap.projectId ?? null,
      flowRevisionId: remap.flowRevisionId,
      slotKey: remap.slotKey,
      mappedRunnerId: input.runnerId,
    });
  }

  for (const run of input.activeRuns) {
    if (run.runnerId !== input.runnerId) continue;
    refs.push({
      kind: "activeRun",
      runId: run.runId,
      projectId: run.projectId,
      runnerId: input.runnerId,
    });
  }

  for (const run of input.historicalRunSnapshots) {
    if (run.runnerSnapshot?.id !== input.runnerId) continue;
    refs.push({
      kind: "historicalRunSnapshot",
      runId: run.runId,
      projectId: run.projectId,
      runnerId: input.runnerId,
    });
  }

  for (const run of input.scratchRuns) {
    if (run.runnerId !== input.runnerId) continue;
    refs.push({
      kind: "scratchRun",
      runId: run.runId,
      projectId: run.projectId,
      runnerId: input.runnerId,
    });
  }

  return refs;
}

export function collectSidecarUsageReferences(
  input: SidecarUsageInput,
): SidecarUsageReference[] {
  return input.runners
    .filter((runner) => runner.sidecarId === input.sidecarId)
    .map((runner) => ({
      kind: "runnerSidecar",
      runnerId: runner.runnerId,
      sidecarId: input.sidecarId,
    }));
}

function snapshotRunnerId(snapshot: unknown): string | null {
  if (
    snapshot &&
    typeof snapshot === "object" &&
    "id" in snapshot &&
    typeof snapshot.id === "string"
  ) {
    return snapshot.id;
  }

  return null;
}

export async function loadRunnerUsageReferences(
  db: Db,
  runnerId: string,
): Promise<RunnerUsageReference[]> {
  const [
    platformRuntimeRows,
    projectRows,
    flowRevisionRows,
    projectFlowDefaultRows,
    flowStepRemapRows,
    runRows,
  ] = await Promise.all([
    db.select().from(platformRuntimeSettings),
    db.select().from(projects),
    db.select().from(flowRevisions),
    db.select().from(projectFlowRunnerDefaults),
    db.select().from(flowRunnerRemaps),
    db.select().from(runs),
  ]);

  return collectRunnerUsageReferences({
    runnerId,
    platformDefaultRunnerId: platformRuntimeRows[0]?.defaultRunnerId ?? null,
    projectDefaults: projectRows.map((project) => ({
      projectId: project.id,
      runnerId: project.defaultRunnerId ?? null,
    })),
    platformFlowDefaults: flowRevisionRows.map((revision) => ({
      flowRevisionId: revision.id,
      flowRefId: revision.flowRefId,
      runnerId: revision.defaultRunnerId ?? null,
    })),
    projectFlowDefaults: projectFlowDefaultRows.map((flow) => ({
      projectId: flow.projectId,
      flowId: flow.flowId,
      runnerId: flow.runnerId ?? null,
    })),
    flowStepRemaps: flowStepRemapRows.map((remap) => ({
      projectId: remap.projectId ?? null,
      flowRevisionId: remap.flowRevisionId,
      slotKey: remap.slotKey,
      mappedRunnerId: remap.mappedRunnerId ?? null,
    })),
    activeRuns: runRows
      .filter((run) => ACTIVE_RUN_STATUSES.has(run.status))
      .map((run) => ({
        runId: run.id,
        projectId: run.projectId,
        runnerId: run.runnerId ?? null,
      })),
    historicalRunSnapshots: runRows
      .filter((run) => snapshotRunnerId(run.runnerSnapshot) !== null)
      .map((run) => ({
        runId: run.id,
        projectId: run.projectId,
        runnerSnapshot: { id: snapshotRunnerId(run.runnerSnapshot) },
      })),
    scratchRuns: runRows
      .filter((run) => run.runKind === "scratch")
      .map((run) => ({
        runId: run.id,
        projectId: run.projectId,
        runnerId: run.runnerId ?? null,
      })),
  });
}

export async function loadSidecarUsageReferences(
  db: Db,
  sidecarId: string,
): Promise<SidecarUsageReference[]> {
  const runnerRows = await db.select().from(platformAcpRunners);

  return collectSidecarUsageReferences({
    sidecarId,
    runners: runnerRows.map((runner) => ({
      runnerId: runner.id,
      sidecarId: runner.sidecarId ?? null,
    })),
  });
}
