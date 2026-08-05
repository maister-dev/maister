import "server-only";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

const log = pino({
  name: "social-task-lookup",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { projects, tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type ResolvedProjectTask = {
  project: {
    id: string;
    slug: string;
    taskKey: string;
    archivedAt: Date | null;
  };
  task: {
    id: string;
    projectId: string;
    number: number;
    title: string;
    status: string;
    createdByUserId: string | null;
  };
};

// Both identifiers are URL params resolved against server state — the task
// strictly via (project_id, number), never a body id (ADR-078 audit table).
export async function resolveProjectTaskByNumber(
  slug: string,
  number: number,
  db?: Db,
): Promise<ResolvedProjectTask | null> {
  const _db = (db ?? getDb()) as unknown as { select: any };

  const rows = (await _db
    .select({
      projectId: projects.id,
      slug: projects.slug,
      taskKey: projects.taskKey,
      archivedAt: projects.archivedAt,
      taskId: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      createdByUserId: tasks.createdByUserId,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(projects.slug, slug), eq(tasks.number, number)))) as Array<{
    projectId: string;
    slug: string;
    taskKey: string;
    archivedAt: Date | null;
    taskId: string;
    number: number;
    title: string;
    status: string;
    createdByUserId: string | null;
  }>;
  const row = rows[0];

  if (!row) return null;

  return {
    project: {
      id: row.projectId,
      slug: row.slug,
      taskKey: row.taskKey,
      archivedAt: row.archivedAt,
    },
    task: {
      id: row.taskId,
      projectId: row.projectId,
      number: row.number,
      title: row.title,
      status: row.status,
      createdByUserId: row.createdByUserId,
    },
  };
}

// Bounded to match TASK_KEY_REGEX's 2-10 char key: an unbounded pattern lets a
// megabyte-long ref through every gate and into a database query.
const KEY_REF_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,10})$/;

// tasks.number is int4; a ref above the ceiling is unresolvable by definition
// and must not reach the comparison as an out-of-range literal.
const PG_INT4_MAX = 2_147_483_647;

// ADR-155: `projects.task_key` is platform-unique, so `KEY-N` addresses a task
// globally — the one identifier a cross-project relation can be created with.
// A malformed ref is a caller mistake, not a lookup miss: return null, never
// throw, and never let it reach the database.
export async function resolveTaskByKeyRef(
  keyRef: string,
  db?: Db,
): Promise<ResolvedProjectTask | null> {
  const match = KEY_REF_PATTERN.exec(keyRef);

  if (!match) {
    log.debug({ keyRef, resolved: false }, "keyRef rejected by the parser");

    return null;
  }

  const taskKey = match[1].toUpperCase();
  const number = Number(match[2]);

  if (!Number.isSafeInteger(number) || number < 1 || number > PG_INT4_MAX) {
    log.debug({ keyRef, resolved: false }, "keyRef number out of range");

    return null;
  }

  const _db = (db ?? getDb()) as unknown as { select: any };

  const rows = (await _db
    .select({
      projectId: projects.id,
      slug: projects.slug,
      taskKey: projects.taskKey,
      archivedAt: projects.archivedAt,
      taskId: tasks.id,
      number: tasks.number,
      title: tasks.title,
      status: tasks.status,
      createdByUserId: tasks.createdByUserId,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(eq(projects.taskKey, taskKey), eq(tasks.number, number)),
    )) as Array<{
    projectId: string;
    slug: string;
    taskKey: string;
    archivedAt: Date | null;
    taskId: string;
    number: number;
    title: string;
    status: string;
    createdByUserId: string | null;
  }>;
  const row = rows[0];

  log.debug(
    { keyRef, taskKey, number, resolved: Boolean(row) },
    "keyRef lookup",
  );

  if (!row) return null;

  return {
    project: {
      id: row.projectId,
      slug: row.slug,
      taskKey: row.taskKey,
      archivedAt: row.archivedAt,
    },
    task: {
      id: row.taskId,
      projectId: row.projectId,
      number: row.number,
      title: row.title,
      status: row.status,
      createdByUserId: row.createdByUserId,
    },
  };
}
