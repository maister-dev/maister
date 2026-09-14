import "server-only";

/**
 * Two of the four populations the `decisions` counter sums (ADR-169 D1):
 * `Crashed` runs owing recover/discard, and tasks a triage verdict flagged.
 *
 * The row → item mappers are exported separately from the queries so the
 * redaction contract has a seam a test can feed a row that ACTUALLY contains
 * `acp_session_id`. Asserting redaction against an already-safe literal is
 * vacuous — a future `{ ...row }` spread would leak with the test still green.
 */

import type { CrashAction } from "@/lib/board";

import { and, desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { crashActionFor } from "@/lib/board";
import { getDb } from "@/lib/db/client";
import { projects, runs, tasks } from "@/lib/db/schema";
import { activeSessionAcpSessionId } from "@/lib/runs/active-run-session";

const log = pino({
  name: "queries-decision-sources",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type DbClient = any;

// The row as SELECTed — carries the session handle, because `crashActionFor`
// needs its presence to choose recover vs discard.
export interface CrashedRunRow {
  runId: string;
  projectId: string;
  projectSlug: string;
  taskId: string | null;
  projectTaskKey: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  runKind: "flow" | "scratch" | "agent";
  status: string;
  acpSessionId: string | null;
  crashedAt: Date | null;
}

export interface CrashedDecisionItem {
  runId: string;
  projectId: string;
  projectSlug: string;
  taskId: string | null;
  taskKey: string | null;
  taskTitle: string | null;
  action: CrashAction | null;
  crashedAt: Date | null;
}

export interface FlaggedTaskRow {
  taskId: string;
  projectId: string;
  projectSlug: string;
  projectTaskKey: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  triageConfidence: string | null;
  flaggedAt: Date | null;
}

export interface FlaggedDecisionItem {
  taskId: string;
  projectId: string;
  projectSlug: string;
  taskKey: string | null;
  taskTitle: string | null;
  flaggedAt: Date | null;
}

function taskKeyOf(
  projectTaskKey: string | null,
  taskNumber: number | null,
): string | null {
  return projectTaskKey !== null && taskNumber !== null
    ? `${projectTaskKey}-${taskNumber}`
    : null;
}

/**
 * Field-by-field, never a spread. `acpSessionId` is consumed to DERIVE the
 * action and is then dropped: the raw session handle never reaches a client.
 */
export function toCrashedDecisionItem(row: CrashedRunRow): CrashedDecisionItem {
  return {
    runId: row.runId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    taskId: row.taskId,
    taskKey: taskKeyOf(row.projectTaskKey, row.taskNumber),
    taskTitle: row.taskTitle,
    action: crashActionFor({
      runKind: row.runKind,
      runStatus: "Crashed",
      acpSessionId: row.acpSessionId,
    }),
    crashedAt: row.crashedAt,
  };
}

/** Drops `triageConfidence` — an internal advisory number, not a decision. */
export function toFlaggedDecisionItem(
  row: FlaggedTaskRow,
): FlaggedDecisionItem {
  return {
    taskId: row.taskId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    taskKey: taskKeyOf(row.projectTaskKey, row.taskNumber),
    taskTitle: row.taskTitle,
    flaggedAt: row.flaggedAt,
  };
}

export async function listCrashedForProjects(
  projectIds: readonly string[],
  deps: { db?: DbClient } = {},
): Promise<CrashedDecisionItem[]> {
  if (projectIds.length === 0) return [];

  const client = deps.db ?? getDb();
  const rows = (await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      projectSlug: projects.slug,
      taskId: runs.taskId,
      projectTaskKey: projects.taskKey,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      runKind: runs.runKind,
      status: runs.status,
      acpSessionId: activeSessionAcpSessionId(runs.id),
      crashedAt: runs.endedAt,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        inArray(runs.projectId, [...projectIds]),
        eq(runs.status, "Crashed"),
        eq(runs.runKind, "flow"),
      ),
    )
    .orderBy(desc(runs.endedAt))) as CrashedRunRow[];

  const items = rows.map(toCrashedDecisionItem);

  log.debug(
    { projectCount: projectIds.length, crashedCount: items.length },
    "crashed decisions",
  );

  return items;
}

export async function listFlaggedForProjects(
  projectIds: readonly string[],
  deps: { db?: DbClient } = {},
): Promise<FlaggedDecisionItem[]> {
  if (projectIds.length === 0) return [];

  const client = deps.db ?? getDb();
  const rows = (await client
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      projectSlug: projects.slug,
      projectTaskKey: projects.taskKey,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      triageConfidence: tasks.triageConfidence,
      flaggedAt: tasks.updatedAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        inArray(tasks.projectId, [...projectIds]),
        eq(tasks.triageStatus, "flagged"),
        // A flagged task is a pending decision only while it is still in the
        // backlog; once it launches, its run's stage owns it.
        eq(tasks.status, "Backlog"),
      ),
    )
    .orderBy(desc(tasks.updatedAt))) as FlaggedTaskRow[];

  const items = rows.map(toFlaggedDecisionItem);

  log.debug(
    { projectCount: projectIds.length, flaggedCount: items.length },
    "flagged decisions",
  );

  return items;
}
