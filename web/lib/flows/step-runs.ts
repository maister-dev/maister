import "server-only";

import type { MaisterErrorCode } from "@/lib/errors";
import type { StepRun } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { stepRuns } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-step-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

const STDOUT_HARD_CAP_BYTES = 1024 * 1024;

export type StepType = "cli" | "agent" | "guard" | "human";
export type StepMode = "new-session" | "slash-in-existing";
export type StepRunStatus =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Skipped"
  | "NeedsInput";

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

function truncate(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  if (s.length <= STDOUT_HARD_CAP_BYTES) return s;

  return s.slice(0, STDOUT_HARD_CAP_BYTES);
}

export async function createStepRun(args: {
  runId: string;
  stepId: string;
  stepType: StepType;
  mode?: StepMode;
  attempt?: number;
  db?: Db;
}): Promise<{ id: string }> {
  const db = args.db ?? getDb();
  const id = randomUUID();

  await db.insert(stepRuns).values({
    id,
    runId: args.runId,
    stepId: args.stepId,
    stepType: args.stepType,
    mode: args.mode ?? null,
    attempt: args.attempt ?? 1,
    status: "Pending" as StepRunStatus,
  });

  log.info(
    {
      stepRunId: id,
      runId: args.runId,
      stepId: args.stepId,
      stepType: args.stepType,
      status: "Pending",
    },
    "step-run created",
  );

  return { id };
}

export async function markStepRunning(
  stepRunId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(stepRuns)
    .set({ status: "Running" as StepRunStatus })
    .where(eq(stepRuns.id, stepRunId));

  log.info({ stepRunId, status: "Running" }, "step-run transition");
}

export async function markStepSucceeded(
  stepRunId: string,
  args: {
    stdout?: string | null;
    vars?: Record<string, unknown>;
    exitCode?: number;
    acpSessionId?: string;
  },
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(stepRuns)
    .set({
      status: "Succeeded" as StepRunStatus,
      stdout: truncate(args.stdout),
      vars: args.vars ?? {},
      exitCode: args.exitCode ?? null,
      acpSessionId: args.acpSessionId ?? null,
      endedAt: new Date(),
    })
    .where(eq(stepRuns.id, stepRunId));

  log.info(
    {
      stepRunId,
      status: "Succeeded",
      exitCode: args.exitCode ?? null,
      acpSessionId: args.acpSessionId ?? null,
    },
    "step-run transition",
  );
}

export async function markStepFailed(
  stepRunId: string,
  args: {
    errorCode: MaisterErrorCode;
    stdout?: string | null;
    exitCode?: number;
  },
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(stepRuns)
    .set({
      status: "Failed" as StepRunStatus,
      stdout: truncate(args.stdout),
      exitCode: args.exitCode ?? null,
      errorCode: args.errorCode,
      endedAt: new Date(),
    })
    .where(eq(stepRuns.id, stepRunId));

  log.info(
    {
      stepRunId,
      status: "Failed",
      errorCode: args.errorCode,
      exitCode: args.exitCode ?? null,
    },
    "step-run transition",
  );
}

export async function markStepNeedsInput(
  stepRunId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(stepRuns)
    .set({ status: "NeedsInput" as StepRunStatus })
    .where(eq(stepRuns.id, stepRunId));

  log.info({ stepRunId, status: "NeedsInput" }, "step-run transition");
}

export async function getStepRunsForRun(
  runId: string,
  db?: Db,
): Promise<StepRun[]> {
  const d = db ?? getDb();

  const rows: StepRun[] = await d
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.runId, runId))
    .orderBy(asc(stepRuns.startedAt), asc(stepRuns.attempt));

  return rows;
}
