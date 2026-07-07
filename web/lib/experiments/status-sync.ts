import "server-only";

import type {
  ExperimentMemberRunProgress,
  ExperimentMemberRunStatus,
  ExperimentStatus,
} from "@/lib/experiments/types";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { selectForUpdate } from "@/lib/db/select-for-update";
import * as schemaModule from "@/lib/db/schema";
import {
  assertExperimentTransition,
  deriveExperimentProgressStatus,
} from "@/lib/experiments/fsm";
import { experimentStatusTimestampPatch } from "@/lib/experiments/repository";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { experiments, experimentRuns, runs } = schemaModule as unknown as Record<
  string,
  any
>;

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

  return MEMBER_RUN_STATUSES.has(status) ? status : "Running";
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

function statusUpdateValues(
  fromStatus: ExperimentStatus,
  toStatus: ExperimentStatus,
  now: Date,
) {
  return {
    status: toStatus,
    updatedAt: now,
    ...experimentStatusTimestampPatch(fromStatus, toStatus, now),
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
  ).filter((row: Record<string, unknown>) => row.experimentId === experimentId);
  const memberRunIds = allMemberRows.map((row: Record<string, unknown>) =>
    String(row.runId),
  );
  const runRows =
    memberRunIds.length === 0
      ? []
      : await args.db.select().from(runs).where(inArray(runs.id, memberRunIds));
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

  const updateQuery = args.db
    .update(experiments)
    .set(statusUpdateValues(fromStatus, toStatus, new Date()))
    .where(
      and(eq(experiments.id, experimentId), eq(experiments.status, fromStatus)),
    );

  if (typeof updateQuery.returning === "function") {
    const updatedRows = await updateQuery.returning({ id: experiments.id });

    if (updatedRows.length === 0) {
      log.info(
        {
          experimentId,
          runId: args.runId,
          observedStatus: fromStatus,
          skippedStatus: toStatus,
        },
        "experiment status sync skipped after concurrent status change",
      );

      return {
        experimentId,
        changed: false,
        fromStatus,
        toStatus: fromStatus,
        memberCount: memberRuns.length,
        readinessByVariant: readiness,
      };
    }
  } else {
    await updateQuery;
  }

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
