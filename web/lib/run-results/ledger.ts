import type {
  RunResultArtifactRef,
  RunResultContract,
  RunResultInvalidReason,
  RunResultProducerKind,
  RunResultRow,
} from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MAISTER_ENGINE_VERSION } from "@/lib/flows/engine-version";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runResults } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-results",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165 (D9/D11): the run-result ledger. EVERY function here takes the
// caller's transaction — a result row must be committed in the same transaction
// as the state it describes (the attempt close, the terminal flip), or a woken
// parent can observe a settle without its result.
//
// Logging is keys-only. A result VALUE is never logged: it is the payload a
// coordinator asked for, it can be large, and it can carry private repository
// content.

/** How much of a sha256 goes into a log line — enough to correlate, not to leak. */
const SHA_PREFIX_LEN = 12;

type PublishArgs = {
  runId: string;
  value: Record<string, unknown>;
  valueBytes: number;
  contract: RunResultContract;
  producerKind: RunResultProducerKind;
  /** A flow node id, or `session:default` for an agent session. */
  producerRef: string;
  nodeAttemptId?: string | null;
  artifactManifest?: RunResultArtifactRef[];
};

async function nextRevision(tx: Db, runId: string): Promise<number> {
  const rows = (await tx
    .select({ max: sql<number>`coalesce(max(${runResults.revision}), 0)::int` })
    .from(runResults)
    .where(eq(runResults.runId, runId))) as { max: number }[];

  return (rows[0]?.max ?? 0) + 1;
}

/**
 * Retire every `valid | stale` row of the run.
 *
 * Runs BEFORE the insert: the partial unique index
 * `run_results_one_valid_per_run_uq` is checked per statement, so the slot must
 * be free before the new `valid` row lands. `superseded_by_id` is deliberately
 * NOT set here — the FK points at a row that does not exist yet — so the caller
 * backlinks in a third statement inside the same transaction.
 */
async function retirePrior(tx: Db, runId: string): Promise<string[]> {
  const retired = (await tx
    .update(runResults)
    .set({ validity: "superseded", supersededAt: new Date() })
    .where(
      and(
        eq(runResults.runId, runId),
        inArray(runResults.validity, ["valid", "stale"]),
      ),
    )
    .returning({ id: runResults.id })) as { id: string }[];

  return retired.map((r) => r.id);
}

/**
 * Publish a validated public result as the run's new current revision.
 *
 * MUST be called inside the transaction that also commits the state making the
 * result collectable.
 */
export async function publishRunResult(
  tx: Db,
  args: PublishArgs,
): Promise<RunResultRow> {
  const id = randomUUID();
  const revision = await nextRevision(tx, args.runId);
  const retiredIds = await retirePrior(tx, args.runId);

  const inserted = (await tx
    .insert(runResults)
    .values({
      id,
      runId: args.runId,
      revision,
      validity: "valid",
      schemaRef: args.contract.schemaRef,
      schemaSha256: args.contract.sha256,
      schemaVersion: args.contract.schemaVersion,
      producerKind: args.producerKind,
      producerRef: args.producerRef,
      nodeAttemptId: args.nodeAttemptId ?? null,
      value: args.value,
      valueBytes: args.valueBytes,
      invalidReason: null,
      artifactManifest: args.artifactManifest ?? [],
      engineVersion: MAISTER_ENGINE_VERSION,
    })
    .returning()) as RunResultRow[];

  if (retiredIds.length > 0) {
    await tx
      .update(runResults)
      .set({ supersededById: id })
      .where(inArray(runResults.id, retiredIds));
  }

  log.info(
    {
      runId: args.runId,
      revision,
      schemaRef: args.contract.schemaRef,
      sha256Prefix: args.contract.sha256.slice(0, SHA_PREFIX_LEN),
      valueBytes: args.valueBytes,
      producer: args.producerRef,
      producerKind: args.producerKind,
    },
    "[run-result.publish] public result published",
  );
  if (retiredIds.length > 0) {
    log.info(
      { runId: args.runId, revision, supersededCount: retiredIds.length },
      "[run-result.supersede] prior revisions superseded",
    );
  }

  return inserted[0];
}

/**
 * Record a FAILED publish attempt: a row with a reason and NO value.
 *
 * The `invalid` row is the ONE durable source for a coordinator's
 * `resultFailure`, which is why a failed publish still writes rather than
 * silently leaving the run result-less.
 */
export async function recordInvalidRunResult(
  tx: Db,
  args: {
    runId: string;
    contract: RunResultContract;
    reason: RunResultInvalidReason;
    producerKind: RunResultProducerKind;
    producerRef: string;
    nodeAttemptId?: string | null;
    /** Bytes of the REJECTED payload, for the operator's sense of scale. */
    valueBytes?: number;
    artifactManifest?: RunResultArtifactRef[];
  },
): Promise<RunResultRow> {
  const id = randomUUID();
  const revision = await nextRevision(tx, args.runId);

  const inserted = (await tx
    .insert(runResults)
    .values({
      id,
      runId: args.runId,
      revision,
      validity: "invalid",
      schemaRef: args.contract.schemaRef,
      schemaSha256: args.contract.sha256,
      schemaVersion: args.contract.schemaVersion,
      producerKind: args.producerKind,
      producerRef: args.producerRef,
      nodeAttemptId: args.nodeAttemptId ?? null,
      value: null,
      valueBytes: args.valueBytes ?? 0,
      invalidReason: args.reason,
      artifactManifest: args.artifactManifest ?? [],
      engineVersion: MAISTER_ENGINE_VERSION,
    })
    .returning()) as RunResultRow[];

  log.warn(
    {
      runId: args.runId,
      revision,
      reasonClass: args.reason,
      valueBytes: args.valueBytes ?? 0,
      producer: args.producerRef,
    },
    "[run-result.invalid] publish attempt failed",
  );

  return inserted[0];
}

/**
 * Mark the run's CURRENT result stale because one of the named nodes — its
 * producer among them — was reworked without re-publishing.
 *
 * A no-op when the current result came from a node outside `staledNodeIds`:
 * staling a sibling node does not invalidate this run's answer.
 */
export async function markRunResultStale(
  tx: Db,
  runId: string,
  staledNodeIds: readonly string[],
): Promise<boolean> {
  if (staledNodeIds.length === 0) return false;

  const staled = (await tx
    .update(runResults)
    .set({ validity: "stale" })
    .where(
      and(
        eq(runResults.runId, runId),
        eq(runResults.validity, "valid"),
        eq(runResults.producerKind, "flow_node"),
        inArray(runResults.producerRef, [...staledNodeIds]),
      ),
    )
    .returning({ id: runResults.id, revision: runResults.revision })) as {
    id: string;
    revision: number;
  }[];

  if (staled.length > 0) {
    log.info(
      { runId, revision: staled[0].revision, staledNodeIds },
      "[run-result.stale] current result staled by rework",
    );
  }

  return staled.length > 0;
}

/**
 * Stamp `first_collected_at` on the run's current result. Write-once by the
 * `IS NULL` guard, so a repeated collect never moves it — this half of the
 * Lab's consumption metric must mean "the FIRST time the engine served it".
 */
export async function markRunResultCollected(
  tx: Db,
  runId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const marked = (await tx
    .update(runResults)
    .set({ firstCollectedAt: at })
    .where(
      and(
        eq(runResults.runId, runId),
        eq(runResults.validity, "valid"),
        isNull(runResults.firstCollectedAt),
      ),
    )
    .returning({ id: runResults.id })) as { id: string }[];

  return marked.length > 0;
}

/** The run's current `valid` row, or null. */
export async function currentRunResult(
  tx: Db,
  runId: string,
): Promise<RunResultRow | null> {
  const rows = (await tx
    .select()
    .from(runResults)
    .where(and(eq(runResults.runId, runId), eq(runResults.validity, "valid")))
    .limit(1)) as RunResultRow[];

  return rows[0] ?? null;
}

/** The run's highest-revision row whatever its validity, or null. */
export async function newestRunResult(
  tx: Db,
  runId: string,
): Promise<RunResultRow | null> {
  const rows = (await tx
    .select()
    .from(runResults)
    .where(eq(runResults.runId, runId))
    .orderBy(desc(runResults.revision))
    .limit(1)) as RunResultRow[];

  return rows[0] ?? null;
}

/**
 * Both rows a `resultStatus` derivation needs, in one round trip.
 *
 * They are read separately rather than "newest, and it is valid if it says so"
 * because a `valid` row is NOT always the newest: a rework can supersede it
 * only when a new publish lands, so a `valid` revision 1 can coexist with
 * nothing newer, while an `invalid` revision 2 can sit above a superseded 1.
 */
export async function resolvePublicResult(
  tx: Db,
  runId: string,
): Promise<{ newest: RunResultRow | null; valid: RunResultRow | null }> {
  const rows = (await tx
    .select()
    .from(runResults)
    .where(eq(runResults.runId, runId))
    .orderBy(desc(runResults.revision))) as RunResultRow[];

  return {
    newest: rows[0] ?? null,
    valid: rows.find((r) => r.validity === "valid") ?? null,
  };
}
