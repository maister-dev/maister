import "server-only";

import { and, asc, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// Board-axis terminal task statuses (a Done/Abandoned task is no longer actionable).
const TERMINAL_TASK_STATUSES = ["Done", "Abandoned"] as const;

// ADR-121 (G6 read half): the Observatory surfaces advisory triage confidence as a
// read-only low-confidence signal. This module is the ONLY admission-adjacent reader
// of `triage_confidence`, and it is read-only — it NEVER feeds any launch/admission
// path (INV-5 is unaffected: confidence influences no routing decision).

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export type LowConfidenceTask = {
  taskId: string;
  projectId: string;
  number: number;
  title: string;
  priority: string;
  confidence: number;
};

export type LowConfidenceSignal = {
  threshold: number;
  count: number;
  tasks: LowConfidenceTask[];
};

// Non-terminal tasks whose advisory triage confidence is at/below the threshold,
// ordered least-confident first. Scoped to `projectIds` when given.
export async function getLowConfidenceSignal(
  opts: { projectIds?: string[]; threshold?: number; db?: Db } = {},
): Promise<LowConfidenceSignal> {
  const db = opts.db ?? getDb();
  const threshold = opts.threshold ?? LOW_CONFIDENCE_THRESHOLD;

  const rows: Array<{
    taskId: string;
    projectId: string;
    number: number;
    title: string;
    priority: string;
    confidence: string;
  }> = await db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      number: tasks.number,
      title: tasks.title,
      priority: tasks.priority,
      confidence: tasks.triageConfidence,
    })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.triageConfidence),
        sql`${tasks.triageConfidence} <= ${threshold}`,
        notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        ...(opts.projectIds?.length
          ? [inArray(tasks.projectId, opts.projectIds)]
          : []),
      ),
    )
    .orderBy(asc(tasks.triageConfidence), asc(tasks.number));

  const mapped: LowConfidenceTask[] = rows.map((r) => ({
    taskId: r.taskId,
    projectId: r.projectId,
    number: r.number,
    title: r.title,
    priority: r.priority,
    confidence: Number(r.confidence),
  }));

  return { threshold, count: mapped.length, tasks: mapped };
}
