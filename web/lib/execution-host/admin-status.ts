import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionObservabilitySummary } from "@/lib/execution-host/events/lag-observation";
import type { ExecutionEventLagReadModel } from "@/types/execution-host-observability";
import type { SchedulerClockStatus } from "@/types/scheduler";
import type { DurableWorkerState } from "@/lib/workers/health";

import { sql } from "drizzle-orm";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { collectExecutionEventLag } from "@/lib/execution-host/events/lag-read-model";
import { parseExecutionObservability } from "@/lib/execution-host/events/lag-observation";
import { getPlatformStatus } from "@/lib/execution-host/platform-status";
import { getSchedulerClockStatus } from "@/lib/queries/scheduler";
import { DEFAULT_SYSTEM_SWEEP_JOB_ID } from "@/lib/scheduler/jobs";
import { durableWorkersHealth } from "@/lib/workers/health";

const HOST_LIMIT = 20;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^(0|[1-9][0-9]{0,18})$/;

type AdminStatusDb = Db;

type HostRow = {
  id: string;
  host_key: string;
  display_name: string;
  kind: string;
  readiness: string;
  readiness_reason: string | null;
  last_boot_id: string | null;
  last_seen_at: Date | string | null;
  capabilities: Record<string, unknown>;
  registered_at: Date | string;
  retired_at: Date | string | null;
};

type LatestObservationRow = {
  id: string;
  status: string;
  claimed_at: Date | string;
  finished_at: Date | string | null;
  summary: Record<string, unknown> | null;
};

export type AdminExecutionHostRow = Readonly<{
  id: string;
  hostKey: string;
  displayName: string;
  kind: string;
  readiness: string;
  readinessReason: string | null;
  bootId: string | null;
  lastSeenAt: string | null;
  version: string | null;
  capabilities: Record<string, unknown>;
  registeredAt: string;
  retiredAt: string | null;
}>;

export type AdminExecutionHostStatus = Readonly<{
  sampledAt: string;
  hosts: readonly AdminExecutionHostRow[];
  lag: ExecutionEventLagReadModel;
  latestSweep: Readonly<{
    attemptId: string;
    status: string;
    claimedAt: string;
    finishedAt: string | null;
    observation: ExecutionObservabilitySummary | null;
    observationStatus: "available" | "unsupported";
  }> | null;
  workers: Readonly<Record<string, DurableWorkerState>>;
  schedulerClock: SchedulerClockStatus;
}>;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;

  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function rowsOf<T>(result: { rows?: unknown[] }): T[] {
  return (result.rows ?? []) as T[];
}

async function listHosts(db: AdminStatusDb): Promise<AdminExecutionHostRow[]> {
  const result = await db.execute(sql`
    SELECT
      id, host_key, display_name, kind, readiness, readiness_reason,
      last_boot_id, last_seen_at, capabilities, registered_at, retired_at
    FROM execution_hosts
    ORDER BY (retired_at IS NULL) DESC, registered_at DESC, id DESC
    LIMIT ${HOST_LIMIT}
  `);

  return rowsOf<HostRow>(result).map((row) => ({
    id: row.id,
    hostKey: row.host_key,
    displayName: row.display_name,
    kind: row.kind,
    readiness: row.readiness,
    readinessReason: row.readiness_reason,
    bootId: row.last_boot_id,
    lastSeenAt: iso(row.last_seen_at),
    version:
      typeof row.capabilities.supervisorVersion === "string"
        ? row.capabilities.supervisorVersion
        : null,
    capabilities: row.capabilities,
    registeredAt: iso(row.registered_at)!,
    retiredAt: iso(row.retired_at),
  }));
}

async function latestSweepObservation(db: AdminStatusDb) {
  const result = await db.execute(sql`
    SELECT id, status, claimed_at, finished_at, summary
    FROM scheduler_job_runs
    WHERE job_id = ${DEFAULT_SYSTEM_SWEEP_JOB_ID}
      AND status IN ('Succeeded', 'Failed', 'Skipped')
    ORDER BY claimed_at DESC, id DESC
    LIMIT 1
  `);
  const row = rowsOf<LatestObservationRow>(result)[0];

  if (row === undefined) return null;
  const observation = parseExecutionObservability(
    row.summary?.executionObservability,
  );

  return {
    attemptId: row.id,
    status: row.status,
    claimedAt: iso(row.claimed_at)!,
    finishedAt: iso(row.finished_at),
    observation,
    observationStatus: observation ? "available" : "unsupported",
  } as const;
}

export async function getAdminExecutionHostStatus(
  input: {
    db?: AdminStatusDb;
    now?: Date;
    poisonAfter?: { runId: string; consumerName: string };
  } = {},
): Promise<AdminExecutionHostStatus> {
  const db = input.db ?? (getDb() as unknown as AdminStatusDb);
  const now = input.now ?? new Date();
  const health = await getPlatformStatus();
  const [hosts, lag, latestSweep] = await Promise.all([
    listHosts(db),
    collectExecutionEventLag({
      db,
      health,
      now,
      poisonAfter: input.poisonAfter,
    }),
    latestSweepObservation(db),
  ]);

  return {
    sampledAt: now.toISOString(),
    hosts,
    lag,
    latestSweep,
    workers: durableWorkersHealth(),
    schedulerClock: getSchedulerClockStatus(),
  };
}

export async function requireAdminExecutionHostStatus(
  input: {
    db?: AdminStatusDb;
    now?: Date;
    poisonAfter?: { runId: string; consumerName: string };
  } = {},
): Promise<AdminExecutionHostStatus> {
  await requireGlobalRole("admin");

  return getAdminExecutionHostStatus(input);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatProjectionRearmCommand(
  input: Readonly<{
    consumerName: string;
    runId: string;
    poisonEventId: string | null;
    lastRunSequence: string | null;
    errorEventId: string | null;
    errorGeneration: string | null;
  }>,
): string | null {
  if (
    input.consumerName.length === 0 ||
    input.runId.length === 0 ||
    input.poisonEventId === null ||
    input.poisonEventId.length === 0 ||
    input.errorEventId !== input.poisonEventId ||
    input.errorGeneration === null ||
    !UUID.test(input.errorGeneration) ||
    (input.lastRunSequence !== null && !CURSOR.test(input.lastRunSequence))
  )
    return null;

  return [
    "pnpm --filter maister-web execution:projection:rearm",
    `--consumer ${shellQuote(input.consumerName)}`,
    `--run ${shellQuote(input.runId)}`,
    `--event ${shellQuote(input.poisonEventId)}`,
    `--cursor ${shellQuote(input.lastRunSequence ?? "null")}`,
    `--error-generation ${shellQuote(input.errorGeneration)}`,
  ].join(" ");
}
