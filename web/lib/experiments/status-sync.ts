import "server-only";

import { eq, inArray } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import {
  assertExperimentTransition,
  deriveExperimentProgressStatus,
} from "@/lib/experiments/fsm";
import type {
  ExperimentMemberRunProgress,
  ExperimentMemberRunStatus,
  ExperimentStatus,
} from "@/lib/experiments/types";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experiments, experimentRuns, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): pg|sqlite drizzle union.
type Db = any;

const log = pino({
  name: "experiments-status-sync",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ExperimentStatusSyncResult = {
  experimentId: string;
  changed: boolean;
  fromStatus: ExperimentStatus;
  toStatus: ExperimentStatus;
  memberCount: number;
  readinessByVariant: Record<
    string,
    { total: number; settled: number; waiting: number }
  >;
};

const MEMBER_RUN_STATUSES = new Set<ExperimentMemberRunStatus>([
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
]);

const TERMINAL_OR_REVIEW_STATUSES = new Set<ExperimentMemberRunStatus>([
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
  "Failed",
]);

function asExperimentStatus(value: unknown): ExperimentStatus {
  return value as ExperimentStatus;
}

function asMemberStatus(value: unknown): ExperimentMemberRunStatus {
  const status = String(value) as ExperimentMemberRunStatus;

  return MEMBER_RUN_STATUSES.has(status) ? status : "Failed";
}

async function selectForUpdate(query: any): Promise<Record<string, unknown>[]> {
  if (typeof query.for === "function") {
    return (await query.for("update")) as Record<string, unknown>[];
  }

  return (await query) as Record<string, unknown>[];
}

function readinessByVariant(
  memberRuns: ExperimentMemberRunProgress[],
): ExperimentStatusSyncResult["readinessByVariant"] {
  const result: ExperimentStatusSyncResult["readinessByVariant"] = {};

  for (const run of memberRuns) {
    const current = result[run.variantKey] ?? {
      total: 0,
      settled: 0,
      waiting: 0,
    };

    current.total += 1;
    if (TERMINAL_OR_REVIEW_STATUSES.has(run.status)) current.settled += 1;
    else current.waiting += 1;
    result[run.variantKey] = current;
  }

  return result;
}

function statusUpdateValues(toStatus: ExperimentStatus, now: Date) {
  return {
    status: toStatus,
    updatedAt: now,
    ...(toStatus === "running" ? { launchedAt: now } : {}),
    ...(toStatus === "comparable" ? { comparableAt: now } : {}),
  };
}

export async function syncExperimentStatusForRun(args: {
  db: Db;
  runId: string;
}): Promise<ExperimentStatusSyncResult | null> {
  const memberRows = await args.db
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.runId, args.runId));
  const sourceMember = memberRows.find(
    (row: Record<string, unknown>) => row.runId === args.runId,
  );

  if (!sourceMember) return null;

  const experimentId = String(sourceMember.experimentId);
  const experimentQuery = args.db
    .select()
    .from(experiments)
    .where(eq(experiments.id, experimentId));
  const experimentRows = await selectForUpdate(experimentQuery);
  const experiment = experimentRows.find(
    (row: Record<string, unknown>) => row.id === experimentId,
  );

  if (!experiment) return null;

  const allMemberRows = (
    await args.db
      .select()
      .from(experimentRuns)
      .where(eq(experimentRuns.experimentId, experimentId))
  ).filter(
    (row: Record<string, unknown>) => row.experimentId === experimentId,
  );
  const memberRunIds = allMemberRows.map((row: Record<string, unknown>) =>
    String(row.runId),
  );
  const runRows =
    memberRunIds.length === 0
      ? []
      : await args.db
          .select()
          .from(runs)
          .where(inArray(runs.id, memberRunIds));
  const statusByRunId = new Map(
    (runRows as Array<Record<string, unknown>>).map((row) => [
      String(row.id),
      asMemberStatus(row.status),
    ]),
  );
  const memberRuns = allMemberRows.map(
    (row: Record<string, unknown>): ExperimentMemberRunProgress => ({
      variantKey: String(row.variantKey),
      status: statusByRunId.get(String(row.runId)) ?? "Failed",
    }),
  );
  const fromStatus = asExperimentStatus(experiment.status);
  const toStatus = deriveExperimentProgressStatus({
    currentStatus: fromStatus,
    memberRuns,
  });
  const readiness = readinessByVariant(memberRuns);

  assertExperimentTransition(fromStatus, toStatus);

  if (fromStatus === toStatus) {
    return {
      experimentId,
      changed: false,
      fromStatus,
      toStatus,
      memberCount: memberRuns.length,
      readinessByVariant: readiness,
    };
  }

  await args.db
    .update(experiments)
    .set(statusUpdateValues(toStatus, new Date()))
    .where(eq(experiments.id, experimentId));

  log.info(
    {
      experimentId,
      runId: args.runId,
      fromStatus,
      toStatus,
      memberCount: memberRuns.length,
      readinessByVariant: readiness,
    },
    "experiment status synchronized from member run",
  );

  return {
    experimentId,
    changed: true,
    fromStatus,
    toStatus,
    memberCount: memberRuns.length,
    readinessByVariant: readiness,
  };
}
