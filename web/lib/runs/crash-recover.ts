import "server-only";

import type { FlowActionCompletion } from "@/lib/flows/graph/action-completion";

import { and, desc, eq, isNull } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { CRASH_RECOVER_DECISION } from "@/lib/flows/graph/attempt-decisions";
import { decodeNodePromptCompletion } from "@/lib/flows/graph/node-prompt-owner";
import { readPromptOutput } from "@/lib/execution-host/prompt-output";
import { reconcilePromptCommand } from "@/lib/execution-host/prompt-reconciliation";
import { resolveNodeResumeSessionId } from "@/lib/runs/node-resume-session";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executionCommands, nodeAttempts, runSessionIncarnations } =
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
): Promise<Array<{ id: string; executionAssignmentId: string | null }>> {
  return await db
    .select({
      id: nodeAttempts.id,
      executionAssignmentId: nodeAttempts.executionAssignmentId,
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

export type CrashEvidenceOutcome = "applied" | "absent" | "quarantined";

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

  if (attempts.length === 0) return "absent";

  for (const attempt of attempts) {
    const commandRows = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, input.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      )
      .orderBy(desc(executionCommands.createdAt));
    const command = commandRows.find(
      (row: Record<string, any>) =>
        row.ownerRef?.variant === "node" &&
        row.ownerRef?.nodeAttemptId === attempt.id,
    );

    if (!command) continue;
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

        if (rows.length === 0) return false;

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
      .catch((error: unknown) => {
        if (error instanceof PromptOwnerHandoffLost) {
          log.info(
            { runId: input.runId, commandId: settled.id },
            "crash-recover: evidence-first lost the handoff to another writer",
          );

          return false;
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
