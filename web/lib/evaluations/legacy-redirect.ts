import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { evaluationStudies } from "@/lib/db/schema";

// ADR-150 T4.1: the retired Experiments routes redirect into the Evaluation Lab.
// A legacy experiment deep-link resolves to the backfilled Study that carries
// its `legacy_experiment_id`; an unknown id (never migrated, or another
// project's) resolves to null so the caller falls back to the evaluations list.
export async function resolveLegacyExperimentStudyId(
  projectId: string,
  legacyExperimentId: string,
  db = getDb() as never,
): Promise<string | null> {
  const rows = await (db as ReturnType<typeof getDb>)
    .select({ id: evaluationStudies.id })
    .from(evaluationStudies)
    .where(
      and(
        eq(evaluationStudies.projectId, projectId),
        eq(evaluationStudies.legacyExperimentId, legacyExperimentId),
      ),
    )
    .limit(1);

  return rows[0]?.id ?? null;
}
