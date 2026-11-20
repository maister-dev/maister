import "server-only";

import type { Db } from "../db";

import { sql } from "drizzle-orm";

import { runContextTranscriptRevisions } from "@/lib/db/schema";

/** Context evidence and transcript text may commit in either order. Count
 * mutations separately from their source sequence so neither commit is lost. */
export async function advanceCompactionTranscriptRevision(
  tx: Db,
  runId: string,
  nodeAttemptId: string | null,
  sequence: bigint,
): Promise<void> {
  const revisions = runContextTranscriptRevisions;

  await tx
    .insert(revisions)
    .values(
      (nodeAttemptId === null ? [null] : [null, nodeAttemptId]).map(
        (attempt) => ({
          runId,
          nodeAttemptId: attempt,
          revision: 1n,
          lastRunSequence: sequence,
        }),
      ),
    )
    .onConflictDoUpdate({
      target: [revisions.runId, revisions.nodeAttemptId],
      set: {
        revision: sql`${revisions.revision} + 1`,
        lastRunSequence: sql`greatest(${revisions.lastRunSequence}, ${sequence})`,
      },
    });
}
