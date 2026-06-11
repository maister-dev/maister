import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

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
// strictly via (project_id, number), never a body id (ADR-075 audit table).
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
