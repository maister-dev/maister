import "server-only";

import type {
  EvidenceCrashReason,
  PromptEvidenceClass,
} from "@/lib/reconcile-evidence";
import type { CrashReason } from "@/lib/runs/state-transitions";

import { and, eq, inArray, isNull } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { TURN_LOST_DECISION } from "@/lib/flows/graph/attempt-decisions";
import { classifyPromptEvidence } from "@/lib/reconcile-evidence";
import {
  CURRENT_TURN_VARIANTS,
  loadPromptEvidence,
  resolveEvidenceAttemptId,
} from "@/lib/reconcile-evidence-db";
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
  constructor(
    readonly guard: "attempt" | "run" | "command" | "gate",
    /** The command's class under the row lock, when that is what refused. */
    readonly observed?: PromptEvidenceClass,
  ) {
    super("CONFLICT", "turn-lost boundary lost a guard", {
      details: { reason: "turn_lost_cas_lost", guard, observed },
    });
    Object.setPrototypeOf(this, TurnLostCasLost.prototype);
  }
}

/** The command classes that still justify each evidence crash, read under the
 * row lock inside the boundary's transaction.
 *
 * The sweep classified the command outside any transaction, and two writers
 * can land before this write: a host-span reader settling the turn, and the
 * owner applying it. Neither is refused by the other guards — a freshly
 * settled result still has `completion_applied_at IS NULL`, and a gate's close
 * admits the action's completion — so a readable result was discarded, and an
 * applied gate crashed its run.
 *
 * Read without a probe (no host call inside a transaction), so an `accepted`
 * row with no terminal evidence reads `pending_ingest`: what a probe-proved
 * lost turn and a stream-lost `pending_ingest`/`inflight` both are while
 * nothing has moved. `quarantined` is the one class that may already be
 * applied — `quarantine()` stamps `applied` on a conflict found after
 * application — and its discharge obligation is then met. */
const CRASH_EVIDENCE = {
  "turn-lost": ["turn_lost", "pending_ingest"],
  "stream-lost": ["pending_ingest"],
  "owner-poisoned": ["quarantined", "poisoned"],
} as const satisfies Record<
  EvidenceCrashReason,
  readonly PromptEvidenceClass[]
>;

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
    /** Admit an attempt that already carries `action_completion`.
     *
     * The ACTION path must NOT: a completion means a writer applied a real
     * result between the classification and this write, that result IS the
     * node's outcome, and crashing over it would discard a paid turn.
     *
     * The GATE path must: gates run AFTER the action persists its completion on
     * the SAME attempt (`runner-graph.ts` — "Run pre_finish.gates after the
     * action succeeds"), so requiring NULL there matches zero rows on EVERY
     * real lost gate turn. That threw, the owner retried, and the command
     * poisoned — a permanent stall. The gate's protection against acting on the
     * wrong row is its evaluation identity, checked by the caller, and — on the
     * sweep side — the command's evidence re-read under lock
     * (`applyTurnLostBoundary`). */
    admitCompletedAction?: boolean;
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
        ...(input.admitCompletedAction
          ? []
          : [isNull(nodeAttempts.actionCompletion)]),
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
 * Winning that guard is not enough to be RIGHT, though, so the command row is
 * also read `FOR UPDATE` and re-classified against `CRASH_EVIDENCE` before the
 * discharge. The transaction takes the owner application's own order: the run
 * row first, the domain rows, the command last.
 *
 * Two callers, both on the flow path, because those are the two that genuinely
 * race: the reconcile sweep's evidence arms and the flow prompt owner. Agent
 * and scratch runs have ONE writer each and keep their own choke points.
 */
export async function applyTurnLostBoundary(input: {
  db: Db;
  runId: string;
  nodeId: string;
  reason: EvidenceCrashReason;
  /** The status the caller CLASSIFIED the run in. Default `Running`. */
  fromStatuses?: readonly string[];
  /** The attempt the CALLER classified. Re-deriving it here is not the same
   * thing: between the sweep's classification and this write a Recover can
   * close attempt A and open attempt B at the same node, and a fresh lookup
   * would then close B and mark B's healthy in-flight command applied using
   * A's diagnosis. Passing it makes the write refuse a moved target. */
  expectedAttemptId?: string;
  /** The command the caller classified, for the same reason. */
  commandId?: string;
}): Promise<TurnLostBoundaryResult> {
  const { db, runId, nodeId } = input;
  // The SAME predicate the sweep classified from, imported rather than
  // restated: a decision about attempt A must not become a write to attempt B.
  const attemptId = await resolveEvidenceAttemptId(db, { runId, nodeId });

  if (
    attemptId &&
    input.expectedAttemptId &&
    attemptId !== input.expectedAttemptId
  ) {
    log.info(
      {
        runId,
        nodeId,
        reason: input.reason,
        classified: input.expectedAttemptId,
        current: attemptId,
        outcome: "not-claimed",
      },
      "turn-lost boundary: the node moved to another attempt since classification — yielding",
    );

    return "not-claimed";
  }
  const attempt = attemptId ? { id: attemptId } : null;

  if (!attempt) {
    log.info(
      { runId, nodeId, reason: input.reason, outcome: "not-claimed" },
      "turn-lost boundary: no open attempt — another writer already closed it",
    );

    return "not-claimed";
  }
  // The SAME lookup the sweep classified from when the caller names no command.
  const targetId =
    input.commandId ??
    (
      await loadPromptEvidence(db, {
        runId,
        nodeAttemptId: attempt.id,
        variants: CURRENT_TURN_VARIANTS,
      })
    )?.id;
  const [command] = targetId
    ? await db
        .select({
          id: executionCommands.id,
          ownerRef: executionCommands.ownerRef,
        })
        .from(executionCommands)
        .where(eq(executionCommands.id, targetId))
    : [];
  const commandId: string | null = command?.id ?? null;
  // A gate turn is the attempt's turn too, but it runs AFTER the action applied
  // its completion, and its evaluation must not be left `running`: the gate
  // owner's lost-turn arm (`flows/graph/prompt-owner.ts`) makes the same writes.
  const gateEvaluationId =
    command?.ownerRef?.variant === "gate_ai" ||
    command?.ownerRef?.variant === "gate_skill"
      ? String(command.ownerRef.evaluationId)
      : null;

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

  // Resolved on the gate path only: the gate store's module graph (artifacts,
  // webhooks) and the `gate_results` table must not ride every caller of this
  // boundary — suites that partially mock the schema load it, and a vitest mock
  // throws on any read of an export it does not define.
  const gateStore = gateEvaluationId
    ? await import("@/lib/flows/graph/gate-store")
    : null;
  const gateResults = gateEvaluationId
    ? // FIXME(any): dual drizzle-orm peer-dep variants.
      (schemaModule as unknown as Record<string, any>).gateResults
    : null;
  // FIXME(any): dual drizzle-orm peer-dep variants. Read here, not at module
  // scope, like `gateResults` below.
  const runs = (schemaModule as unknown as Record<string, any>).runs;
  const applied = await db
    .transaction(async (tx: Db) => {
      // Run first, as every owner apply takes it (`lockFlowPromptOwner` →
      // `lockCurrentSessionAssignment`). The two writers that race on this
      // turn then queue on one row; taking the attempt (and a gate's
      // evaluation) first and the run only inside the crash was the opposite
      // order, and deadlocked against a concurrent owner apply.
      await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, runId))
        .for("update");
      const [evaluation] = gateEvaluationId
        ? await tx
            .select({
              runId: gateResults.runId,
              nodeAttemptId: gateResults.nodeAttemptId,
              status: gateResults.status,
            })
            .from(gateResults)
            .where(eq(gateResults.id, gateEvaluationId))
            .for("update")
        : [];

      // The gate owner's identity check: the evaluation belongs to this attempt.
      if (
        gateEvaluationId &&
        (evaluation?.runId !== runId ||
          evaluation?.nodeAttemptId !== attempt.id)
      )
        throw new TurnLostCasLost("gate");
      await closeTurnLostAttempt(tx, {
        runId,
        nodeAttemptId: attempt.id,
        reason: input.reason,
        fromStatuses: input.fromStatuses,
        // The action's completion is the node's real result and is preserved.
        admitCompletedAction: gateEvaluationId !== null,
      });
      // `stale`, never `failed`: the gate was invalidated, not decided. A
      // verdict already recorded (a conflict found after application) stays.
      if (
        gateEvaluationId &&
        (evaluation.status === "pending" || evaluation.status === "running")
      )
        await gateStore!.markGateStale(gateEvaluationId, tx);

      const [locked] = await tx
        .select({
          state: executionCommands.state,
          applicationState: executionCommands.applicationState,
          applicationError: executionCommands.applicationError,
          lastError: executionCommands.lastError,
          terminalEventId: executionCommands.terminalEventId,
          terminalEvidenceSha256: executionCommands.terminalEvidenceSha256,
          completionAppliedAt: executionCommands.completionAppliedAt,
        })
        .from(executionCommands)
        .where(eq(executionCommands.id, commandId))
        .for("update");
      const observed = classifyPromptEvidence(locked ?? null);

      const justifying: readonly PromptEvidenceClass[] =
        CRASH_EVIDENCE[input.reason];

      if (!justifying.includes(observed))
        throw new TurnLostCasLost("command", observed);
      // Only a quarantine stamped after application reaches here applied: the
      // discharge obligation is met, not lost.
      if (locked.completionAppliedAt) return true;

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
            observed: error.observed,
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
