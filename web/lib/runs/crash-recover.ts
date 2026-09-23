import "server-only";

import type { FlowActionCompletion } from "@/lib/flows/graph/action-completion";

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { CRASH_RECOVER_DECISION } from "@/lib/flows/graph/attempt-decisions";
import { decodeNodePromptCompletion } from "@/lib/flows/graph/node-prompt-owner";
import { readPromptOutput } from "@/lib/execution-host/prompt-output";
import { reconcilePromptCommand } from "@/lib/execution-host/prompt-reconciliation";
import { isTurnLostError } from "@/lib/reconcile-evidence";
import { CURRENT_TURN_VARIANTS } from "@/lib/reconcile-evidence-db";
import { resolveNodeResumeSessionId } from "@/lib/runs/node-resume-session";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executionCommands, nodeAttempts, runs, runSessionIncarnations } =
  schemaModule as unknown as Record<string, any>;

// Re-exported so the recover path keeps a single import surface; the resolution
// itself lives in a dependency-light module the graph runner can import without
// pulling the prompt-owner decode path in behind it.
export { resolveNodeResumeSessionId };

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "crash-recover",
  level: process.env.LOG_LEVEL ?? "info",
});

// The open, still-`Running` ledger rows of the recover-target node.
async function openRunningAttempts(
  db: Db,
  input: { runId: string; nodeId: string },
): Promise<
  Array<{ id: string; actionCompletion: FlowActionCompletion | null }>
> {
  return await db
    .select({
      id: nodeAttempts.id,
      actionCompletion: nodeAttempts.actionCompletion,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, input.nodeId),
        eq(nodeAttempts.status, "Running"),
        isNull(nodeAttempts.endedAt),
      ),
    );
}

// Did this command's completion land on the attempt after all? A 0-row
// completion CAS says only that SOMETHING changed; re-reading says what. The
// answer decides between "continue the graph" and "buy the turn again", so it
// must be a durable read, never inferred from the CAS's row count.
async function evidenceAlreadyApplied(
  db: Db,
  nodeAttemptId: string,
  commandId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ actionCompletion: nodeAttempts.actionCompletion })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, nodeAttemptId));

  return row?.actionCompletion?.commandId === commandId;
}

/** ADR-175's refusal to re-prompt from disagreeing evidence, preserved after
 * ADR-177 started CLOSING the attempt at crash time.
 *
 * `openRunningAttempts` only sees `Running` attempts with a null `ended_at`.
 * The `owner-poisoned` boundary closes the attempt `Reworked`, so by the time
 * an operator clicks Recover there is no open attempt left and this function
 * answered `absent` — which routes straight to a fresh dispatch. That silently
 * undid the one thing the quarantine arm exists to guarantee: a turn whose
 * receipt and terminal event DISAGREE must never be re-prompted, because
 * nobody knows what the original turn actually did.
 *
 * So when no open attempt remains, the node's most recent CLOSED attempt is
 * checked for a quarantined command before the caller is allowed to dispatch.
 * The marker survives the boundary by design: it writes `application_state`
 * without clearing `application_error`.
 */
async function quarantinedOnClosedAttempt(
  db: Db,
  input: { runId: string; nodeId: string },
): Promise<CrashEvidenceOutcome> {
  const [row] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .innerJoin(
      nodeAttempts,
      sql`${nodeAttempts.id} = ${executionCommands.ownerRef}->>'nodeAttemptId'`,
    )
    .where(
      and(
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.kind, "session.prompt"),
        // Every turn the sweep's boundary can close on: since the ADR-177
        // amendment (2026-09-23) that is a permission resume or a gate too.
        inArray(sql`${executionCommands.ownerRef}->>'variant'`, [
          ...CURRENT_TURN_VARIANTS,
        ]),
        sql`${executionCommands.applicationError}->>'reason' = 'prompt_terminal_conflict'`,
        eq(nodeAttempts.nodeId, input.nodeId),
      ),
    )
    .orderBy(desc(executionCommands.createdAt))
    .limit(1);

  if (!row) return "absent";
  log.warn(
    { runId: input.runId, nodeId: input.nodeId, commandId: row.id },
    "crash-recover: evidence-first {quarantined} on a CLOSED attempt — refusing to re-prompt a disagreeing turn",
  );

  return "quarantined";
}

export type CrashEvidenceOutcome =
  | "applied"
  | "absent"
  | "quarantined"
  // ADR-177: the crashed turn's evidence says the HOST lost it. Not a result,
  // so it is declined rather than applied — and the caller routes it exactly
  // like "absent": close the attempt, dispatch one fresh prompt.
  | "turn-lost";

// Another writer applied this command between the read and the write. Rolls the
// handoff transaction back so the recover falls through to an ordinary
// re-dispatch instead of double-applying.
class PromptOwnerHandoffLost extends MaisterError {
  constructor() {
    super("CONFLICT", "prompt owner completion was applied elsewhere", {
      details: { reason: "prompt_owner_handoff_lost" },
    });
    Object.setPrototypeOf(this, PromptOwnerHandoffLost.prototype);
  }
}

// ADR-175 Scope 2. Apply the crashed turn's own terminal evidence BEFORE any
// re-dispatch, so a recover never buys a turn the host already finished.
//
// This is the eligibility table's explicit generation handoff, not a second
// terminal writer: the reducer is the SAME `decodeNodePromptCompletion` the
// live owner uses. The live owner itself cannot serve this, by construction —
// its `lockFlowPromptOwner` requires `runs.execution_assignment_id` to still be
// the command's assignment, and the recover claim has already minted the next
// epoch. Left to the owner worker the evidence would be marked `superseded`
// and lost.
//
// Host I/O, so it runs OUTSIDE every transaction; only the application itself
// is transactional.
export async function applyCrashedTurnEvidence(
  db: Db,
  input: { runId: string; nodeId: string; assignmentId: string },
): Promise<CrashEvidenceOutcome> {
  const attempts = await openRunningAttempts(db, input);

  if (attempts.length === 0) return await quarantinedOnClosedAttempt(db, input);

  for (const attempt of attempts) {
    // Newest first, so a node re-prompted within one attempt reconciles the
    // turn that was actually in flight when the crash happened. Owner-filtered
    // in SQL and capped: selecting every prompt command of the run pulled each
    // turn's whole `request_canonical_json` back to satisfy one match.
    const [command] = await db
      .select({
        id: executionCommands.id,
        completionAppliedAt: executionCommands.completionAppliedAt,
      })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, input.runId),
          eq(executionCommands.kind, "session.prompt"),
          sql`${executionCommands.ownerRef}->>'variant' = 'node'`,
          sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${attempt.id}`,
        ),
      )
      .orderBy(desc(executionCommands.createdAt))
      .limit(1);

    if (!command) continue;

    // ADR-175: an earlier recover already folded this turn into the ledger and
    // its graph continuation then failed, so the operator recovered again. The
    // applied completion is the ANSWER here, not a row to skip past — falling
    // through would close the attempt `crash_recover` and buy the finished turn
    // a SECOND time, which is the one thing this whole arm exists to prevent.
    if (attempt.actionCompletion?.commandId === command.id) {
      log.info(
        {
          runId: input.runId,
          nodeId: input.nodeId,
          nodeAttemptId: attempt.id,
          commandId: command.id,
          outcome: "applied",
          source: "ledger",
        },
        "crash-recover: evidence-first — already applied by an earlier recover",
      );

      return "applied";
    }
    if (command.completionAppliedAt) continue;

    // Fold a terminal receipt the crash lost into the ledger. Never sends a
    // prompt; a missing or unreachable receipt never terminalizes execution.
    const reconciled = await reconcilePromptCommand({
      db,
      commandId: command.id,
    });

    if (reconciled.disposition === "quarantined") {
      log.warn(
        { runId: input.runId, commandId: command.id },
        "crash-recover: evidence-first {quarantined} — refusing to re-prompt a disagreeing turn",
      );

      return "quarantined";
    }
    if (reconciled.disposition !== "settled") continue;

    const settled = reconciled.command;

    if (settled.state !== "succeeded" && settled.state !== "failed") continue;

    const ref = settled.ownerRef;

    if (ref?.variant !== "node") continue;
    if (settled.state === "failed" && !settled.lastError) continue;

    // ADR-177 D5. A lost turn is not the node's outcome — it is the absence of
    // one. ADR-175's rule ("agreeing terminal evidence the owner never applied
    // is applied first") reads it as agreeing evidence and would decode it into
    // a failed node action; the graph then fails the node, `PRECONDITION` is not
    // retryable, and `runs.status` lands `Failed` — which `isRunRecoverable`
    // refuses. Recover would turn a recoverable run into a dead one.
    //
    // Declining is NOT enough. Left at `pending` the command strands
    // `owner_unapplied` forever and `execution_commands_protected_evidence`
    // then blocks deleting the run — and the sweep can never reach it, because
    // the probe is attempt-scoped and this command belongs to the attempt the
    // recover is about to close. So the obligation is discharged HERE, as
    // `superseded`: the existing first-class disposition for "the obligation is
    // met, the result was consciously not applied".
    //
    // `completion_applied_at` stays NULL. `execution_commands_application_shape_check`
    // is an EQUIVALENCE — `(application_state = 'applied') = (completion_applied_at
    // IS NOT NULL)` — so stamping it beside `superseded` is refused by the
    // database. Retirement never reads it; `superseded` alone discharges.
    if (isTurnLostError(settled.lastError)) {
      const discharged = await db
        .update(executionCommands)
        .set({
          applicationState: "superseded",
          applicationClaimOwner: null,
          applicationClaimExpiresAt: null,
          applicationNextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(executionCommands.id, settled.id),
            eq(executionCommands.applicationState, "pending"),
            isNull(executionCommands.completionAppliedAt),
          ),
        )
        .returning({ id: executionCommands.id });

      log.warn(
        {
          runId: input.runId,
          nodeId: input.nodeId,
          nodeAttemptId: attempt.id,
          commandId: settled.id,
          outcome: "turn-lost",
          discharged: discharged.length > 0,
        },
        "crash-recover: evidence-first {turn_lost} — declining a lost turn as a result and superseding it",
      );

      return "turn-lost";
    }

    const [incarnation] = await db
      .select({ acpSessionId: runSessionIncarnations.acpSessionId })
      .from(runSessionIncarnations)
      .where(eq(runSessionIncarnations.id, ref.incarnationId));
    const completion: FlowActionCompletion = await decodeNodePromptCompletion({
      commandId: settled.id,
      promptOrdinal: ref.promptOrdinal,
      acpSessionId: incarnation?.acpSessionId ?? null,
      outcome:
        settled.state === "succeeded"
          ? {
              state: "succeeded",
              ...(await readPromptOutput({
                db,
                commandId: settled.id,
                signal: AbortSignal.timeout(30_000),
              })),
            }
          : { state: "failed", error: settled.lastError! },
    });

    const applied = await db
      .transaction(async (tx: Db) => {
        // Re-bind the applied attempt to the epoch the recover claim minted,
        // inside the SAME transaction as the completion. `applyCreateAck` does
        // exactly this for a fresh dispatch; doing it here keeps
        // `staleSessionBinding` meaning what it says instead of granting the
        // crash-recover path an exemption from it.
        const rows = await tx
          .update(nodeAttempts)
          .set({
            actionCompletion: completion,
            executionAssignmentId: input.assignmentId,
          })
          .where(
            and(
              eq(nodeAttempts.id, attempt.id),
              eq(nodeAttempts.status, "Running"),
              isNull(nodeAttempts.actionCompletion),
            ),
          )
          .returning({ id: nodeAttempts.id });

        // Another writer won the application between the read above and this
        // write. The evidence is in the ledger either way, so that is `applied`
        // — never a reason to buy the turn again. A 0-row update for any OTHER
        // reason (the attempt is no longer `Running`) falls through.
        if (rows.length === 0)
          return await evidenceAlreadyApplied(tx, attempt.id, settled.id);

        // `execution_commands_application_shape_check` binds the disposition to
        // the claim fields: `applied` requires `completion_applied_at`, and
        // `applying` requires BOTH claim columns — so the claim has to be
        // released in the same write, exactly as `applyClaimedPromptOwner` does.
        //
        // An UNEXPIRED owner claim is not a reason to yield here, and waiting
        // out its 30 s lease in the request path would be worse than useless:
        // the claim was taken under the RETIRED generation, and the recover
        // claim has already minted the next epoch, so `lockFlowPromptOwner` can
        // no longer match and that worker's only possible disposition is
        // `superseded`. The claim is dead by construction, not merely stale.
        // Concurrency is still covered — the `resume_started_at` CAS makes
        // recover single-winner, and `completion_applied_at` makes this write
        // idempotent against a handoff that already ran.
        const marked = await tx
          .update(executionCommands)
          .set({
            applicationState: "applied",
            completionAppliedAt: new Date(),
            applicationClaimOwner: null,
            applicationClaimExpiresAt: null,
            applicationNextRetryAt: null,
            applicationError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(executionCommands.id, settled.id),
              isNull(executionCommands.completionAppliedAt),
            ),
          )
          .returning({ id: executionCommands.id });

        if (marked.length === 0) throw new PromptOwnerHandoffLost();

        return true;
      })
      .catch(async (error: unknown) => {
        if (error instanceof PromptOwnerHandoffLost) {
          log.info(
            { runId: input.runId, commandId: settled.id },
            "crash-recover: evidence-first lost the handoff to another writer",
          );

          // The winner wrote BOTH halves in one transaction, so if its
          // completion is on the attempt the evidence is applied and must not
          // be re-prompted just because this writer rolled back.
          return await evidenceAlreadyApplied(db, attempt.id, settled.id);
        }

        throw error;
      });

    if (applied) {
      log.info(
        {
          runId: input.runId,
          nodeId: input.nodeId,
          nodeAttemptId: attempt.id,
          commandId: settled.id,
          assignmentId: input.assignmentId,
          outcome: "applied",
        },
        "crash-recover: evidence-first",
      );

      return "applied";
    }
  }

  log.info(
    { runId: input.runId, nodeId: input.nodeId, outcome: "absent" },
    "crash-recover: evidence-first",
  );

  return "absent";
}

// ADR-175 Scope 1. Close the ledger rows the crash left open, so the graph
// appends a FRESH attempt stamped with the new epoch — which is what makes
// `admitNodePrompt` pass by construction and the logical operation key
// collision-free, without relaxing either.
//
// The `status = 'Running'` guard is LOAD-BEARING, not defensive: it is what
// keeps a parked orchestrator's `NeedsInput` attempt invisible to this close,
// so the all-children-settled arm can still reuse the row `resumingThisNode`
// needs. Widening this to "any open attempt" silently breaks that arm.
export async function closeCrashedNodeAttempts(
  db: Db,
  input: { runId: string; nodeId: string },
): Promise<string[]> {
  const closed = await db
    .update(nodeAttempts)
    .set({
      status: "Reworked",
      decision: CRASH_RECOVER_DECISION,
      endedAt: new Date(),
    })
    .where(
      and(
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, input.nodeId),
        eq(nodeAttempts.status, "Running"),
        isNull(nodeAttempts.endedAt),
      ),
    )
    .returning({ id: nodeAttempts.id });

  return closed.map((row: { id: string }) => row.id);
}

// ADR-175. `runs.resume_started_at` means "a committed crash-recover intent
// nobody has taken yet" — it is both the single-winner claim and the predicate
// `classifyRunReconcile` re-enters a web death on. `runGraph` CAS-clears it for
// a `crashResume` re-entry, but the two arms that re-enter WITHOUT that signal
// (an applied-evidence continuation, an all-settled orchestrator resume) have
// no such clear, and a marker left behind makes the sweep read this run's NEXT,
// unrelated crash as an unclaimed recover intent — silently re-dispatching a
// paid turn in place of the `Crashed` row an operator is supposed to decide on.
//
// ADR-176 D3 — the per-run bound on AUTOMATED crash-recover re-entry.
//
// `driveResume` deliberately returns `transient` for a fenced error and for
// EXECUTOR_UNAVAILABLE, leaving the run `Running` and un-rolled-back so a
// sweeper can retry. That is correct against the sweep's <= 60 s cadence. The
// continuation worker wakes roughly every second on two slots and does host I/O
// (`applyCrashedTurnEvidence`) before failing again, so without a bound a
// supervisor outage becomes a hot retry loop against an already-failing
// supervisor. ADR-175 named this boundary and declined to cross it; automating
// the re-entry is what makes the bound this change's to supply.
export const CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS = 5;

/** The reset applied at every claim-marker WRITE site (D4). Exported as a
 * spread so the three sites cannot disagree about what "fresh intent" means. */
export const CRASH_RECOVER_BUDGET_RESET = {
  crashRecoverAttempts: 0,
  crashRecoverNextRetryAt: null,
} as const;

export type CrashRecoverContinuationOutcome =
  | "resumed"
  | "redispatched"
  | "unresumable"
  | "transient";

/**
 * Records what an automated re-entry produced.
 *
 * Only the `recover` route writes here. A `reattach` carries no new bound — it
 * is the sweep's pre-existing behaviour, and charging it against the budget
 * would let a healthy live session exhaust an allowance it never needed.
 */
export async function recordCrashRecoverContinuationOutcome(
  db: Db,
  runId: string,
  outcome: CrashRecoverContinuationOutcome,
): Promise<{ attempts: number; nextRetryAt: Date | null }> {
  if (outcome !== "transient") {
    // `unresumable` clears too: the run is terminal via `crashRunningRun`, and
    // a clean row keeps a future unrelated crash unbiased.
    const [cleared] = await db
      .update(runs)
      .set(CRASH_RECOVER_BUDGET_RESET)
      .where(eq(runs.id, runId))
      .returning({
        attempts: runs.crashRecoverAttempts,
        nextRetryAt: runs.crashRecoverNextRetryAt,
      });

    log.debug(
      { runId, outcome, attempts: 0 },
      "crash-recover: continuation budget cleared",
    );

    return {
      attempts: cleared?.attempts ?? 0,
      nextRetryAt: cleared?.nextRetryAt ?? null,
    };
  }

  // Exponential, capped at 60 s — converging on the sweep's own honest cadence
  // rather than backing off past the point where the sweep would have retried
  // anyway. `clock_timestamp()` so the deadline is the database's, like every
  // predicate that reads it.
  const [updated] = await db
    .update(runs)
    .set({
      crashRecoverAttempts: sql`${runs.crashRecoverAttempts} + 1`,
      crashRecoverNextRetryAt: sql`clock_timestamp() + least(power(2, ${runs.crashRecoverAttempts} + 1), 60) * interval '1 second'`,
    })
    .where(eq(runs.id, runId))
    .returning({
      attempts: runs.crashRecoverAttempts,
      nextRetryAt: runs.crashRecoverNextRetryAt,
    });
  const attempts = updated?.attempts ?? 0;

  log.debug(
    { runId, outcome, attempts, nextRetryAt: updated?.nextRetryAt ?? null },
    "crash-recover: continuation retry scheduled",
  );
  // Poison-item policy: at the cap the worker stops serving this run and the
  // unchanged reconcile arm remains its backstop. Logged ONCE, on the write
  // that reaches the cap, not on every later pass that skips the row.
  if (attempts === CRASH_RECOVER_CONTINUATION_MAX_ATTEMPTS)
    log.info(
      { runId, attempts },
      "flow-continuation-crash-recover-budget-exhausted",
    );

  return { attempts, nextRetryAt: updated?.nextRetryAt ?? null };
}

// Called AFTER the re-entry returns, never before: while the dispatch is in
// flight the marker is exactly what lets the sweep recover a web death.
export async function clearCrashRecoverMarker(
  db: Db,
  runId: string,
): Promise<void> {
  const cleared = await db
    .update(runs)
    .set({ resumeStartedAt: null })
    .where(and(eq(runs.id, runId), isNotNull(runs.resumeStartedAt)))
    .returning({ id: runs.id });

  log.debug(
    { runId, cleared: cleared.length > 0 },
    "crash-recover: released the recover intent marker",
  );
}
