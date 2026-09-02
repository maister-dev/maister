import "server-only";

import type { ResultStatus } from "@/lib/run-results/types";

import { eq } from "drizzle-orm";

import * as schemaModule from "@/lib/db/schema";
import { deriveResultStatus } from "@/lib/run-results/status";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// ADR-165 (T8.1): the run-detail projection of the public result. An EXPLICIT
// DTO with named columns — never a spread of the row — so a future column
// cannot leak into a client-visible payload by accident.

export type RunPublicResultDto = {
  /** `<flowRefId>@<rev12>:<schemaStem>`; null when the run has no contract. */
  schemaRef: string | null;
  resultStatus: ResultStatus;
  revision: number | null;
  /** How many superseded revisions precede the current one. */
  supersededCount: number;
  collectedAt: string | null;
  /** The validated payload — present only when `resultStatus` is `valid`. */
  value: unknown | null;
  failure: { reason: string } | null;
  /**
   * True for a `Done` run that reached it WITHOUT a promotion — a result-only
   * completion. Derived from the run + workspace state, not a stored column.
   */
  completedWithoutPromotion: boolean;
};

/**
 * The run's public-result facts, or `null` when there is nothing to show.
 *
 * `null` is the signal for "render no panel at all": a run with neither a
 * contract nor any result row has nothing to say, and an empty card would be
 * noise on every ordinary run.
 */
export async function loadRunPublicResult(
  db: Db,
  runId: string,
): Promise<RunPublicResultDto | null> {
  const runRows = (await db
    .select({
      status: runs.status,
      resultContract: runs.resultContract,
      promotedHeadSha: runs.promotedHeadSha,
      mergeCommitSha: runs.mergeCommitSha,
    })
    .from(runs)
    .where(eq(runs.id, runId))) as {
    status: string;
    resultContract: { schemaRef: string; required: boolean } | null;
    promotedHeadSha: string | null;
    mergeCommitSha: string | null;
  }[];
  const run = runRows[0];

  if (!run) return null;

  const { resolvePublicResult } = await import("@/lib/run-results/ledger");
  const { newest, valid } = await resolvePublicResult(db, runId);

  if (!run.resultContract && !newest) return null;

  const rows = (await db
    .select({ validity: schemaModule.runResults.validity })
    .from(schemaModule.runResults)
    .where(eq(schemaModule.runResults.runId, runId))) as {
    validity: string;
  }[];

  return {
    schemaRef: run.resultContract?.schemaRef ?? newest?.schemaRef ?? null,
    resultStatus: deriveResultStatus({
      runStatus: run.status,
      contract: (run.resultContract ?? null) as never,
      newestRow: newest,
      validRow: valid,
    }),
    revision: valid?.revision ?? newest?.revision ?? null,
    supersededCount: rows.filter((r) => r.validity === "superseded").length,
    collectedAt: valid?.firstCollectedAt?.toISOString() ?? null,
    value: valid?.value ?? null,
    failure:
      newest?.validity === "invalid" && newest.invalidReason
        ? { reason: newest.invalidReason }
        : null,
    // A promoted Done carries a head sha; a result-only Done carries neither.
    completedWithoutPromotion:
      run.status === "Done" && !run.promotedHeadSha && !run.mergeCommitSha,
  };
}
