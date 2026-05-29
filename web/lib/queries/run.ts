import "server-only";

import type { HitlRequest } from "@/lib/db/schema";
import type { HitlOption } from "@/lib/queries/hitl";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { extractOptions } from "@/lib/queries/hitl";

const { executors, hitlRequests, projects, runs, workspaces } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export interface RunPendingHitl {
  hitlRequestId: string;
  kind: HitlRequest["kind"];
  prompt: string;
  options: HitlOption[];
  schema: unknown;
}

export interface RunDetail {
  runId: string;
  projectId: string;
  projectSlug: string;
  status: string;
  currentStepId: string | null;
  branch: string;
  agent: "claude" | "codex";
  pendingHitl: RunPendingHitl | null;
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const client = db();
  const rows = await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      currentStepId: runs.currentStepId,
      projectSlug: projects.slug,
      branch: workspaces.branch,
      agent: executors.agent,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(executors, eq(executors.id, runs.executorId))
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) return null;

  const hitlRows = await client
    .select({
      id: hitlRequests.id,
      kind: hitlRequests.kind,
      prompt: hitlRequests.prompt,
      rawSchema: hitlRequests.schema,
    })
    .from(hitlRequests)
    .where(and(eq(hitlRequests.runId, runId), isNull(hitlRequests.respondedAt)))
    .orderBy(desc(hitlRequests.createdAt));
  const pending = hitlRows[0];

  return {
    runId: row.runId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    status: row.status,
    currentStepId: row.currentStepId,
    branch: row.branch,
    agent: row.agent,
    pendingHitl: pending
      ? {
          hitlRequestId: pending.id,
          kind: pending.kind,
          prompt: pending.prompt,
          options: extractOptions(pending.kind, pending.rawSchema),
          schema: pending.rawSchema,
        }
      : null,
  };
}
