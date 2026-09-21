import "server-only";

import type { CrashReason } from "@/lib/runs/state-transitions";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { TURN_LOST_DECISION } from "@/lib/flows/graph/attempt-decisions";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executionCommands, nodeAttempts } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "turn-lost-boundary",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TurnLostBoundaryResult = "applied" | "not-claimed" | "lost-cas";

// Rolls the whole transaction back when ANY of the three guards matches zero
// rows. Never a half-apply: a run crashed without its attempt closed re-enters
// the graph on a row the ledger still calls `Running`, and an attempt closed
// without its command discharged strands the command `owner_unapplied` forever.
export class TurnLostCasLost extends MaisterError {
  constructor(readonly guard: "attempt" | "run" | "command") {
    super("CONFLICT", "turn-lost boundary lost a guard", {
      details: { reason: "turn_lost_cas_lost", guard },
    });
    Object.setPrototypeOf(this, TurnLostCasLost.prototype);
  }
}

/** The attempt close + run crash, inside a transaction the CALLER owns.
 *
 * Split out because the two writers reach it holding different obligations.
 * The sweep (`applyTurnLostBoundary` below) owns all three writes, so it opens
 * its own transaction and discharges the command itself. The flow prompt owner
 * is already inside the owner-application transaction, and THAT layer writes
 * the command's disposition from the value `apply` returns — so it must call
 * only this half, or the two would write the same row twice in one transaction.
 *
 * Throws `TurnLostCasLost` on either guard, which rolls the caller's
 * transaction back. Never returns a partial result: a run crashed without its
 * attempt closed re-enters the graph on a row the ledger still calls `Running`.
 */
export async function closeTurnLostAttempt(
  tx: Db,
  input: {
    runId: string;
    nodeAttemptId: string;
    reason: CrashReason;
    fromStatuses?: readonly string[];
    /** The attempt statuses the close admits. Default `Running` — the gate and
     * permission-resume paths can legitimately sit at `NeedsInput`. */
    fromAttemptStatuses?: readonly string[];
  },
): Promise<void> {
  const closed = await tx
    .update(nodeAttempts)
    .set({
      status: "Reworked",
      decision: TURN_LOST_DECISION,
      // NORMALIZED, not copied from the settled command. `error_code` is an
      // Observatory clustering key, and the two source codes (`PRECONDITION`
      // from a rejected receipt, `ACP_PROTOCOL` from the accepted-with-no-
      // terminal fallback) would split ONE root cause across two clusters.
      // Which path terminalized the turn survives on the command's
      // `last_error`, which is the durable evidence.
      errorCode: "CRASH",
      endedAt: new Date(),
    })
    .where(
      and(
        eq(nodeAttempts.id, input.nodeAttemptId),
        inArray(nodeAttempts.status, [
          ...(input.fromAttemptStatuses ?? ["Running"]),
        ]),
        isNull(nodeAttempts.endedAt),
        // A completion already on the attempt means a writer applied a real
        // result between the read and this write. That result is the node's
        // outcome; overwriting it with a crash would discard a paid turn.
        isNull(nodeAttempts.actionCompletion),
      ),
    )
    .returning({ id: nodeAttempts.id });

  if (closed.length === 0) throw new TurnLostCasLost("attempt");

  const crashed = await crashRunningRun(input.runId, input.reason, {
    db: tx,
    fromStatuses: [...(input.fromStatuses ?? ["Running"])],
  });

  if (!crashed.ok) throw new TurnLostCasLost("run");
}

/** ADR-177 D3 — the one place a host-reported lost turn becomes a run outcome.
 *
 * The claim is THREE-sided, and that is the whole reason this function exists.
 * `runs.status` and `node_attempts.status` are the obvious two; the third is
 * `execution_commands.application_state`. A boundary that closed the attempt
 * and crashed the run but left the command `pending` would produce a row set
 * that can never be retired (`classifyCommandRetirement` answers
 * `owner_unapplied`) and that `execution_commands_protected_evidence` then
 * refuses to delete — a run nobody can clean up.
 *
 * The single-winner mechanism is `completion_applied_at IS NULL`, not a new
 * lock: the invariant is "this command is applied exactly once" and the guard
 * is keyed on exactly that object. It is the same guard `applyCrashedTurnEvidence`
 * relies on, which is what makes the two paths safe against each other.
 *
 * Two callers, both on the flow path, because those are the two that genuinely
 * race: the reconcile sweep's evidence arms and the flow prompt owner. Agent
 * and scratch runs have ONE writer each and keep their own choke points.
 */
export async function applyTurnLostBoundary(input: {
  db: Db;
  runId: string;
  nodeId: string;
  reason: CrashReason;
  /** The status the caller CLASSIFIED the run in. Default `Running`. */
  fromStatuses?: readonly string[];
  /** Already-resolved command id (the owner side knows it); otherwise the
   * attempt's newest owned prompt is looked up. */
  commandId?: string;
}): Promise<TurnLostBoundaryResult> {
  const { db, runId, nodeId } = input;
  const [attempt] = await db
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, nodeId),
        eq(nodeAttempts.status, "Running"),
        isNull(nodeAttempts.endedAt),
      ),
    )
    .orderBy(desc(nodeAttempts.startedAt))
    .limit(1);

  if (!attempt) {
    log.info(
      { runId, nodeId, reason: input.reason, outcome: "not-claimed" },
      "turn-lost boundary: no open attempt — another writer already closed it",
    );

    return "not-claimed";
  }
  const [command] = input.commandId
    ? await db
        .select({
          id: executionCommands.id,
          applicationState: executionCommands.applicationState,
        })
        .from(executionCommands)
        .where(eq(executionCommands.id, input.commandId))
    : await db
        .select({
          id: executionCommands.id,
          applicationState: executionCommands.applicationState,
        })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
            sql`${executionCommands.ownerRef}->>'variant' = 'node'`,
            sql`${executionCommands.ownerRef}->>'nodeAttemptId' = ${attempt.id}`,
          ),
        )
        .orderBy(desc(executionCommands.createdAt))
        .limit(1);
  const commandId: string | null = command?.id ?? null;
  // Already `applied` or `superseded` means the discharge obligation is MET,
  // not that a race was lost. It is reachable on exactly one arm: `quarantine()`
  // writes `application_state = completion_applied_at ? "applied" : "poisoned"`,
  // so a conflict found after application arrives here already stamped. The
  // guard that protects against crashing a run whose turn produced a REAL
  // result is the attempt's `action_completion IS NULL`, not this one.
  const alreadyDischarged =
    command?.applicationState === "applied" ||
    command?.applicationState === "superseded";

  if (!commandId) {
    // The boundary is named for the evidence it discharges. Without a command
    // there is nothing to discharge, and crashing here would be an ordinary
    // `agent-session-gone` wearing a more specific reason.
    log.warn(
      { runId, nodeId, nodeAttemptId: attempt.id, reason: input.reason },
      "turn-lost boundary: no owned prompt for this attempt — yielding",
    );

    return "not-claimed";
  }

  const applied = await db
    .transaction(async (tx: Db) => {
      await closeTurnLostAttempt(tx, {
        runId,
        nodeAttemptId: attempt.id,
        reason: input.reason,
        fromStatuses: input.fromStatuses,
      });

      if (alreadyDischarged) return true;

      const marked = await tx
        .update(executionCommands)
        .set({
          applicationState: "applied",
          completionAppliedAt: new Date(),
          // `execution_commands_application_shape_check` binds the disposition
          // to the claim fields, so the claim is released in the same write.
          applicationClaimOwner: null,
          applicationClaimExpiresAt: null,
          applicationNextRetryAt: null,
          // `application_error` is deliberately PRESERVED, unlike the ADR-175
          // handoff which nulls it. For `owner-poisoned` it is the only record
          // of WHY the application failed, and `applied` with a non-null
          // `application_error` is already a valid shape here — `quarantine()`
          // writes exactly it when `completion_applied_at` is already set.
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(executionCommands.id, commandId),
            isNull(executionCommands.completionAppliedAt),
          ),
        )
        .returning({ id: executionCommands.id });

      if (marked.length === 0) throw new TurnLostCasLost("command");

      return true;
    })
    .catch((error: unknown) => {
      if (error instanceof TurnLostCasLost) {
        log.info(
          {
            runId,
            nodeId,
            nodeAttemptId: attempt.id,
            commandId,
            reason: input.reason,
            guard: error.guard,
            outcome: "lost-cas",
          },
          "turn-lost boundary: another writer won — nothing written",
        );

        return false;
      }

      throw error;
    });

  if (!applied) return "lost-cas";
  const logger = input.reason === "owner-poisoned" ? log.error : log.info;

  logger.call(
    log,
    {
      runId,
      nodeId,
      nodeAttemptId: attempt.id,
      commandId,
      reason: input.reason,
      outcome: "applied",
    },
    "turn-lost boundary: attempt closed, run crashed, command discharged",
  );

  return "applied";
}
