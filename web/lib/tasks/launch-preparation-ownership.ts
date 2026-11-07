import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

/** A committed allocation owns its rowless checkout until the Run lifecycle takes over. */
export async function taskLaunchPreparationOwnsWorktree(
  db: Db,
  input: Readonly<{
    runId: string;
    worktreePath: string;
    parentRepoPath: string;
    projectId: string;
  }>,
): Promise<boolean> {
  const rows = await db.execute(sql`SELECT id FROM task_launch_intents
    WHERE project_id=${input.projectId} AND run_id IS NULL AND original_run_id IS NULL
      AND preparation_identity->>'runId'=${input.runId}
      AND preparation_identity->>'worktreePath'=${input.worktreePath}
      AND preparation_identity->>'parentRepoPath'=${input.parentRepoPath}
      AND preparation_identity->>'incarnationId' IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM runs linked WHERE linked.id=task_launch_intents.preparation_identity->>'runId' OR linked.task_launch_intent_id=task_launch_intents.id)
    LIMIT 1`);

  return rows.rows.length > 0;
}
