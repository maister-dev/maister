import "server-only";

import type { ObjectiveTreeFacts } from "./providers";
import type { Db } from "@/lib/evaluations/db";

import { sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";

// ADR-165 (T10.2): the RUN-TREE facts the recursive-harness measures read.
//
// ONE recursive CTE over `parent_run_id` builds the descendant set, and every
// measure is aggregated from it in the same statement. Nine separate queries
// would be nine chances for the arms to disagree about what "the tree" is — and
// a comparison whose measures describe different trees compares nothing.
//
// Reads recorded facts only (ADR-143 D11): rows already written by the engine.
// Nothing here executes, and nothing infers a value it did not read.

const log = pino({
  name: "evaluations-objective-tree",
  level: process.env.LOG_LEVEL ?? "info",
});

type TreeRow = {
  child_run_count: number;
  invalid_result_count: number;
  rework_count: number;
  crash_count: number;
  tree_tokens: number;
  tree_wall_clock_minutes: number;
  valid_result_child_run_ids: string[] | null;
  collected_child_run_ids: string[] | null;
  consumed_child_run_ids: unknown;
};

function rowsOf(result: unknown): TreeRow[] {
  // node-postgres returns `{ rows }`; some drizzle drivers return the array
  // directly (matches lib/orchestrator/admission.ts).
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as TreeRow[];
}

/**
 * `consumedChildRunIds` as the ROOT reported it — a self-report, so it is read
 * defensively: a non-array, or an array with non-string members, contributes
 * nothing rather than throwing. The measure's whole job is to intersect this
 * claim with what the engine recorded, and a malformed claim is simply a claim
 * that matches no child.
 */
function selfReportedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Load the tree facts for `rootRunId`, or `null` when it is not a tree root.
 *
 * "Not a tree root" means a run with a PARENT — the flat arms of the Lab
 * protocol (`single-agent`, `externalized-context`) are exactly that, and their
 * harness measures are honestly `unavailable` rather than zero.
 */
export async function loadObjectiveTreeFacts(
  rootRunId: string,
  db?: Db,
): Promise<ObjectiveTreeFacts | null> {
  const d = db ?? getDb();
  const result: unknown = await d.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, status, started_at, ended_at, parent_run_id
        FROM runs WHERE id = ${rootRunId} AND parent_run_id IS NULL
      UNION ALL
      SELECT r.id, r.status, r.started_at, r.ended_at, r.parent_run_id
        FROM runs r JOIN subtree s ON r.parent_run_id = s.id
    ),
    descendants AS (SELECT * FROM subtree WHERE id <> ${rootRunId}),
    root_result AS (
      SELECT value FROM run_results
       WHERE run_id = ${rootRunId} AND validity = 'valid'
       LIMIT 1
    )
    SELECT
      (SELECT count(*)::int FROM descendants) AS child_run_count,
      (SELECT count(*)::int FROM run_results rr JOIN subtree s ON s.id = rr.run_id
        WHERE rr.validity = 'invalid') AS invalid_result_count,
      (SELECT count(*)::int FROM node_attempts na JOIN subtree s ON s.id = na.run_id
        WHERE na.status = 'Reworked') AS rework_count,
      (SELECT count(*)::int FROM subtree WHERE status = 'Crashed') AS crash_count,
      (SELECT coalesce(sum(rc.input_tokens + rc.output_tokens
              + rc.cache_read_tokens + rc.cache_creation_tokens), 0)::int
         FROM run_cost_rollups rc JOIN subtree s ON s.id = rc.run_id) AS tree_tokens,
      (SELECT coalesce(
                extract(epoch FROM (max(coalesce(ended_at, now())) - min(started_at))) / 60,
                0)::int
         FROM subtree WHERE started_at IS NOT NULL) AS tree_wall_clock_minutes,
      (SELECT coalesce(array_agg(rr.run_id::text), '{}')
         FROM run_results rr JOIN descendants dd ON dd.id = rr.run_id
        WHERE rr.validity = 'valid') AS valid_result_child_run_ids,
      (SELECT coalesce(array_agg(rr.run_id::text), '{}')
         FROM run_results rr JOIN descendants dd ON dd.id = rr.run_id
        WHERE rr.validity = 'valid' AND rr.first_collected_at IS NOT NULL)
        AS collected_child_run_ids,
      (SELECT value -> 'consumedChildRunIds' FROM root_result) AS consumed_child_run_ids
    WHERE EXISTS (SELECT 1 FROM subtree)
  `);
  const row = rowsOf(result)[0];

  if (!row) return null;

  // `promotion_readiness` is the SAME classifier the merge guard consults
  // (`assertEvidenceReady`), not a second derivation — a measure that scored a
  // participant "ready" while promotion refused it would be measuring nothing.
  // It derives from recorded artifact and gate rows; it executes nothing.
  const readiness = await assertEvidenceReady(rootRunId, "merge", d);

  const facts: ObjectiveTreeFacts = {
    childRunCount: Number(row.child_run_count ?? 0),
    invalidResultCount: Number(row.invalid_result_count ?? 0),
    validResultChildRunIds: row.valid_result_child_run_ids ?? [],
    collectedChildRunIds: row.collected_child_run_ids ?? [],
    consumedChildRunIds: selfReportedIds(row.consumed_child_run_ids),
    reworkCount: Number(row.rework_count ?? 0),
    crashCount: Number(row.crash_count ?? 0),
    treeTokens: Number(row.tree_tokens ?? 0),
    treeWallClockMinutes: Number(row.tree_wall_clock_minutes ?? 0),
    promotionReadiness: readiness.ready ? "ready" : "blocked",
  };

  log.debug(
    {
      rootRunId,
      childRunCount: facts.childRunCount,
      validResults: facts.validResultChildRunIds.length,
      collected: facts.collectedChildRunIds.length,
      invalidResults: facts.invalidResultCount,
    },
    "objective tree facts loaded",
  );

  return facts;
}
