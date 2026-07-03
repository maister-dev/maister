import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { experimentToDetailDTO, type ExperimentDetailDTO } from "@/lib/experiments/dto";
import {
  assertExperimentTransition,
  deriveExperimentProgressStatus,
} from "@/lib/experiments/fsm";
import type {
  ExperimentDiffFileSummary,
  ExperimentLaunchReason,
  ExperimentMaterializationDelta,
  ExperimentMemberRunProgress,
  ExperimentMemberRunStatus,
  ExperimentStatus,
  ExperimentVariant,
  ExperimentVerdictEnvelope,
} from "@/lib/experiments/types";
import { runStatusTone, type RunStatusTone } from "@/lib/runs/run-status-tone";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  experimentRuns,
  experiments,
  gateResults,
  runCostRollups,
  runs,
  runSessions,
} = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "experiments-comparison",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ExperimentComparisonCostDTO =
  | { hasData: false }
  | {
      hasData: true;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      resumeInputTokens: number;
      resumeOutputTokens: number;
      resumeCacheReadTokens: number;
      resumeCacheCreationTokens: number;
      byModel: Record<string, Record<string, number>>;
      byRunner: Record<string, Record<string, number>>;
      sourceEventCount: number;
    };

export type ExperimentComparisonGateDTO = {
  gateId: string;
  kind: string;
  mode: string;
  status: string;
  verdict: unknown;
};

export type ExperimentComparisonRunDTO = {
  runId: string;
  variantKey: string;
  replicateOrdinal: number;
  launchReason: ExperimentLaunchReason;
  status: ExperimentMemberRunStatus;
  statusTone: RunStatusTone;
  durationMs: number | null;
  queuePosition: number | null;
  runnerLabels: string[];
  gates: ExperimentComparisonGateDTO[];
  cost: ExperimentComparisonCostDTO;
  diff: {
    snapshot: string | null;
    truncated: boolean;
    bytes: number | null;
    capturedAt: string | null;
  };
  files: ExperimentDiffFileSummary[];
  materializationDelta: ExperimentMaterializationDelta | null;
};

export type ExperimentComparisonDTO = {
  experiment: ExperimentDetailDTO;
  variants: ExperimentVariant[];
  runs: ExperimentComparisonRunDTO[];
  verdict: ExperimentVerdictEnvelope | null;
  generatedAt: string;
};

export type GetExperimentComparisonArgs = {
  projectId: string;
  experimentId: string;
  viewerType: "session" | "external";
};

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();

  return value;
}

function asStatus(value: unknown): ExperimentMemberRunStatus {
  return String(value) as ExperimentMemberRunStatus;
}

function durationMs(row: Record<string, unknown> | undefined): number | null {
  if (!row?.startedAt || !row.endedAt) return null;

  return (
    new Date(row.endedAt as Date | string).getTime() -
    new Date(row.startedAt as Date | string).getTime()
  );
}

function runnerLabel(row: Record<string, unknown>): string {
  const snapshot = row.runnerSnapshot as Record<string, unknown> | null;

  if (snapshot && typeof snapshot.label === "string") return snapshot.label;
  if (snapshot && typeof snapshot.name === "string") return snapshot.name;
  if (snapshot && typeof snapshot.model === "string") return snapshot.model;
  if (typeof row.runnerId === "string") return row.runnerId;

  return String(row.sessionName ?? "default");
}

function costDto(row: Record<string, unknown> | undefined): ExperimentComparisonCostDTO {
  if (!row) return { hasData: false };

  return {
    hasData: true,
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
    resumeInputTokens: Number(row.resumeInputTokens ?? 0),
    resumeOutputTokens: Number(row.resumeOutputTokens ?? 0),
    resumeCacheReadTokens: Number(row.resumeCacheReadTokens ?? 0),
    resumeCacheCreationTokens: Number(row.resumeCacheCreationTokens ?? 0),
    byModel: (row.byModel as Record<string, Record<string, number>>) ?? {},
    byRunner: (row.byRunner as Record<string, Record<string, number>>) ?? {},
    sourceEventCount: Number(row.sourceEventCount ?? 0),
  };
}

async function verifyStatusOnRead(args: {
  db: Db;
  experiment: Record<string, unknown>;
  members: Array<Record<string, unknown>>;
  runById: Map<string, Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const currentStatus = String(args.experiment.status) as ExperimentStatus;
  const memberRuns = args.members.map(
    (member): ExperimentMemberRunProgress => ({
      variantKey: String(member.variantKey),
      status: asStatus(args.runById.get(String(member.runId))?.status ?? "Failed"),
    }),
  );
  const derivedStatus = deriveExperimentProgressStatus({
    currentStatus,
    memberRuns,
  });

  assertExperimentTransition(currentStatus, derivedStatus);

  if (currentStatus === derivedStatus) return args.experiment;

  const now = new Date();
  const patch = {
    status: derivedStatus,
    updatedAt: now,
    ...(derivedStatus === "running" ? { launchedAt: now } : {}),
    ...(derivedStatus === "comparable" ? { comparableAt: now } : {}),
  };

  await args.db
    .update(experiments)
    .set(patch)
    .where(eq(experiments.id, args.experiment.id));

  log.warn(
    {
      experimentId: args.experiment.id,
      fromStatus: currentStatus,
      toStatus: derivedStatus,
      memberCount: memberRuns.length,
    },
    "experiment status healed on read",
  );

  return { ...args.experiment, ...patch };
}

export async function getExperimentComparison(
  args: GetExperimentComparisonArgs,
  db?: Db,
): Promise<ExperimentComparisonDTO> {
  const d = db ?? getDb();
  const experimentRows = await d
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.id, args.experimentId),
        eq(experiments.projectId, args.projectId),
      ),
    )
    .limit(1);
  const experiment = (experimentRows as Array<Record<string, unknown>>).find(
    (row) =>
      row.id === args.experimentId && row.projectId === args.projectId,
  );

  if (!experiment) {
    throw new Error(`experiment not found: ${args.experimentId}`);
  }

  const memberRows = (
    await d
      .select()
      .from(experimentRuns)
      .where(eq(experimentRuns.experimentId, args.experimentId))
  ).filter(
    (row: Record<string, unknown>) => row.experimentId === args.experimentId,
  ) as Array<Record<string, unknown>>;
  const runIds = memberRows.map((row) => String(row.runId));
  const runRows = runIds.length
    ? ((await d.select().from(runs).where(inArray(runs.id, runIds))) as Array<
        Record<string, unknown>
      >)
    : [];
  const sessionRows = runIds.length
    ? ((await d
        .select()
        .from(runSessions)
        .where(inArray(runSessions.runId, runIds))) as Array<
        Record<string, unknown>
      >)
    : [];
  const gateRows = runIds.length
    ? ((await d
        .select()
        .from(gateResults)
        .where(inArray(gateResults.runId, runIds))) as Array<
        Record<string, unknown>
      >)
    : [];
  const costRows = runIds.length
    ? ((await d
        .select()
        .from(runCostRollups)
        .where(inArray(runCostRollups.runId, runIds))) as Array<
        Record<string, unknown>
      >)
    : [];
  const runById = new Map(runRows.map((row) => [String(row.id), row]));
  const sessionsByRunId = Map.groupBy(sessionRows, (row) => String(row.runId));
  const gatesByRunId = Map.groupBy(gateRows, (row) => String(row.runId));
  const costByRunId = new Map(costRows.map((row) => [String(row.runId), row]));
  const healedExperiment = await verifyStatusOnRead({
    db: d,
    experiment,
    members: memberRows,
    runById,
  });
  const variants = healedExperiment.variants as ExperimentVariant[];
  const variantOrder = new Map(variants.map((variant, index) => [variant.key, index]));
  const comparisonRuns = memberRows
    .map((member): ExperimentComparisonRunDTO => {
      const runId = String(member.runId);
      const runRow = runById.get(runId);

      return {
        runId,
        variantKey: String(member.variantKey),
        replicateOrdinal: Number(member.replicateOrdinal),
        launchReason: String(member.launchReason) as ExperimentLaunchReason,
        status: asStatus(runRow?.status ?? "Failed"),
        statusTone: runStatusTone(String(runRow?.status ?? "Failed")),
        durationMs: durationMs(runRow),
        queuePosition: null,
        runnerLabels: (sessionsByRunId.get(runId) ?? []).map(runnerLabel),
        gates: (gatesByRunId.get(runId) ?? []).map((gate) => ({
          gateId: String(gate.gateId),
          kind: String(gate.kind),
          mode: String(gate.mode),
          status: String(gate.status),
          verdict: gate.verdict ?? null,
        })),
        cost: costDto(costByRunId.get(runId)),
        diff: {
          snapshot:
            typeof member.diffSnapshot === "string"
              ? member.diffSnapshot
              : null,
          truncated: Boolean(member.diffSnapshotTruncated),
          bytes:
            member.diffSnapshotBytes === null || member.diffSnapshotBytes === undefined
              ? null
              : Number(member.diffSnapshotBytes),
          capturedAt: iso(
            member.diffSnapshotCapturedAt as Date | string | null | undefined,
          ),
        },
        files:
          (member.diffFilesSummary as ExperimentDiffFileSummary[] | null) ?? [],
        materializationDelta:
          (member.materializationDelta as ExperimentMaterializationDelta | null) ??
          null,
      };
    })
    .sort((left, right) => {
      const byVariant =
        (variantOrder.get(left.variantKey) ?? 999) -
        (variantOrder.get(right.variantKey) ?? 999);

      return byVariant !== 0
        ? byVariant
        : left.replicateOrdinal - right.replicateOrdinal;
    });

  log.debug(
    {
      experimentId: args.experimentId,
      projectId: args.projectId,
      viewerType: args.viewerType,
      runCount: comparisonRuns.length,
      gateCount: gateRows.length,
      costRowCount: costRows.length,
    },
    "experiment comparison loaded",
  );

  return {
    experiment: experimentToDetailDTO(healedExperiment as never),
    variants,
    runs: comparisonRuns,
    verdict: (healedExperiment.verdict as ExperimentVerdictEnvelope | null) ?? null,
    generatedAt: new Date().toISOString(),
  };
}
