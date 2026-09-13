import "server-only";

/**
 * The ONE writer of `hitl_requests` (ADR-169 amendment).
 *
 * A HITL row IS a decision opening — it is the moment a run starts waiting on a
 * human — and `domain_events` had no kind for that, so the attention consumer
 * could not wake on the commonest decision there is. Emitting from fifteen
 * independent `insert(hitlRequests)` call sites would have made a MISSED site a
 * silent gap: no error, no notification, no way to notice. So the insert and the
 * event are one function, and `UT-NTF-13` fails the build if a sixteenth writer
 * appears.
 *
 * It is deliberately a THIN wrapper. `values` is passed through untouched,
 * because `hitl_requests` carries four shape CHECK constraints that differ per
 * `kind` (agent-question supersession, activation state, retrigger mode,
 * decision-request shape) — redesigning the call sites' value objects would put
 * every one of those at risk for no benefit. The only thing this adds is the
 * event.
 *
 * The event is emitted in the SAME transaction as the insert (ADR-086): a
 * decision that exists without its event would be one nobody is told about, and
 * an event without its decision would notify about nothing.
 */

import { eq } from "drizzle-orm";

import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { hitlRequests, runs } from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants, as elsewhere in lib/runs.
type Db = any;

type HitlInsertValues = typeof hitlRequests.$inferInsert;

export interface CreateHitlRequestOptions {
  /**
   * Suppresses the event for a row that does not open a NEW decision — a
   * supersession replacing a row the reader was already told about. The default
   * is to emit, so a caller has to think to opt out rather than to opt in.
   */
  silent?: boolean;
}

export async function createHitlRequest(
  tx: Db,
  values: HitlInsertValues,
  options: CreateHitlRequestOptions = {},
): Promise<void> {
  await tx.insert(hitlRequests).values(values);
  await emitNeedsInput(tx, values, options);
}

/**
 * The idempotent variant, for a caller that re-derives the same decision on a
 * retry (plan-review re-runs its decision set). Returns the inserted columns, or
 * `undefined` when the row already existed — and emits ONLY on a real insert,
 * because a decision the reader was already told about has not re-opened.
 */
export async function createHitlRequestIfAbsent<
  T extends Record<string, unknown>,
>(
  tx: Db,
  values: HitlInsertValues,
  returning: T,
  options: CreateHitlRequestOptions = {},
): Promise<Record<string, unknown> | undefined> {
  const [inserted] = (await tx
    .insert(hitlRequests)
    .values(values)
    .onConflictDoNothing()
    .returning(returning)) as Array<Record<string, unknown>>;

  if (inserted) await emitNeedsInput(tx, values, options);

  return inserted;
}

async function emitNeedsInput(
  tx: Db,
  values: HitlInsertValues,
  options: CreateHitlRequestOptions,
): Promise<void> {
  if (options.silent === true) return;

  // `project_id` and `task_id` are not on the HITL row, and threading them
  // through fifteen call sites is exactly the per-site change this wrapper
  // exists to avoid — so they are read back from the run the row points at.
  // HITL creation is rare (once per human decision), so the extra SELECT costs
  // nothing that matters.
  const [run] = (await tx
    .select({ projectId: runs.projectId, taskId: runs.taskId })
    .from(runs)
    .where(eq(runs.id, values.runId))
    .limit(1)) as Array<{ projectId: string; taskId: string | null }>;

  if (!run) return;

  await emitDomainEvent({
    db: tx,
    kind: "run.needs_input",
    projectId: run.projectId,
    taskId: values.taskId ?? run.taskId ?? null,
    runId: values.runId,
    payload: { hitlRequestId: values.id, kind: values.kind },
  });
}
