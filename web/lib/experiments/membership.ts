import "server-only";

import { desc, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import type { ExperimentLaunchReason } from "@/lib/experiments/types";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experiments, experimentRuns, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): pg|sqlite drizzle union.
type Db = any;

const log = pino({
  name: "experiments-membership",
  level: process.env.LOG_LEVEL ?? "info",
});

const ACTIVE_INHERITANCE_STATUSES = new Set(["running", "comparable"]);

export type InheritedExperimentMembership = {
  experimentId: string;
  variantKey: string;
  replicateOrdinal: number;
  launchReason: ExperimentLaunchReason;
  baseCommit: string;
};

export async function deriveExperimentMembershipFromSource(args: {
  db: Db;
  sourceRunId: string;
  taskId: string;
  launchReason: Extract<
    ExperimentLaunchReason,
    "manual_relaunch" | "budget_restart"
  >;
}): Promise<InheritedExperimentMembership | null> {
  const sourceRows = await args.db
    .select({ id: runs.id, taskId: runs.taskId })
    .from(runs)
    .where(eq(runs.id, args.sourceRunId))
    .limit(1);
  const sourceRun = sourceRows.find(
    (row: Record<string, unknown>) => row.id === args.sourceRunId,
  );

  if (!sourceRun) {
    throw new MaisterError(
      "PRECONDITION",
      `relaunch source run not found: ${args.sourceRunId}`,
    );
  }
  if (sourceRun.taskId !== args.taskId) {
    throw new MaisterError(
      "CONFLICT",
      `relaunch source run ${args.sourceRunId} does not belong to task ${args.taskId}`,
    );
  }

  const sourceMembershipRows = await args.db
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.runId, args.sourceRunId))
    .limit(1);
  const sourceMembership = sourceMembershipRows.find(
    (row: Record<string, unknown>) => row.runId === args.sourceRunId,
  );

  if (!sourceMembership) return null;

  const experimentId = String(sourceMembership.experimentId);
  const variantKey = String(sourceMembership.variantKey);
  const experimentRows = await args.db
    .select()
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .limit(1);
  const experiment = experimentRows.find(
    (row: Record<string, unknown>) => row.id === experimentId,
  );

  if (!experiment) {
    throw new MaisterError(
      "PRECONDITION",
      `experiment not found for source run ${args.sourceRunId}: ${experimentId}`,
    );
  }
  if (!ACTIVE_INHERITANCE_STATUSES.has(String(experiment.status))) {
    return null;
  }

  const memberRows = await args.db
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.experimentId, experimentId))
    .orderBy(desc(experimentRuns.replicateOrdinal));
  const replicateOrdinal =
    memberRows
      .filter(
        (row: Record<string, unknown>) =>
          row.experimentId === experimentId && row.variantKey === variantKey,
      )
      .reduce((max: number, row: Record<string, unknown>) => {
        const ordinal = Number(row.replicateOrdinal);

        return Number.isFinite(ordinal) && ordinal > max ? ordinal : max;
      }, 0) + 1;
  const membership = {
    experimentId,
    variantKey,
    replicateOrdinal,
    launchReason: args.launchReason,
    baseCommit: String(experiment.baseCommit),
  };

  log.info(
    {
      sourceRunId: args.sourceRunId,
      experimentId,
      variantKey,
      replicateOrdinal,
      launchReason: args.launchReason,
    },
    "experiment membership inherited from source run",
  );

  return membership;
}
