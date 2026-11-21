import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { RunStatusValue } from "@/lib/runs/run-status-sets";
import type { SpecialistAssignmentStatus } from "./types";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { authorizeAssignment } from "./access";
import {
  appendSpecialistAssignmentInputInTransaction,
  assertAssignmentCancellable,
  beginAssignmentTransaction,
  cancelSpecialistAssignmentInTransaction,
  getVisibleSpecialistAssignmentInTransaction,
  lockAssignmentHead,
  lockSpecialistAssignment,
} from "./store";
import { assignmentInputUpdateSchema } from "./types";

import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { isSettledRunStatus } from "@/lib/runs/run-status-sets";
import { postgresTextSchema } from "@/lib/text-schema";
import { authorizeCompanyRunUserActionInTransaction } from "@/lib/agents/company-run-read-access";
import { TERMINAL_CAS_SOURCE } from "@/lib/agents/finalization";
import { companyFlowCanAbandon } from "@/lib/run-results/company-flow-terminal";
import { isStoppableRunStatus } from "@/lib/workbench-git/policy";

const log = pino({
  name: "specialist-assignment-controls",
  level: process.env.LOG_LEVEL ?? "info",
});

type ControlAction = "input" | "continue" | "cancel";
type ControlKey = Readonly<{
  assignmentId: string;
  userId: string;
  action: ControlAction;
  idempotencyKey: string;
  digest: string;
}>;

/** Wire receipt for operator controls (`CBReceipt`). */
export type AssignmentControlReceipt = Readonly<{
  id: string;
  revision: number;
  status: "queued" | "active" | "completed" | "failed" | "cancelled";
  duplicate: boolean;
}>;

/** A control the server recorded (`settled`) or only accepted as pending intent. */
export type AssignmentControlOutcome = Readonly<{
  receipt: AssignmentControlReceipt;
  settled: boolean;
}>;

const controlInputSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();
const inputControlSchema = assignmentInputUpdateSchema
  .extend({ idempotencyKey: knowledgeDeliveryKeySchema })
  .strict();

export function receiptStatus(
  status: SpecialistAssignmentStatus,
): AssignmentControlReceipt["status"] {
  if (status === "queued" || status === "completed" || status === "failed")
    return status;
  if (status === "cancelled") return "cancelled";

  return "active";
}

async function priorReceipt(
  tx: SqlTransaction,
  key: ControlKey,
): Promise<AssignmentControlOutcome | null> {
  const [row] = (
    await tx.execute(sql`
      SELECT request_sha256,revision,status,next_attempt_at IS NULL AS settled FROM specialist_assignment_control_receipts
      WHERE assignment_id=${key.assignmentId} AND actor_user_id=${key.userId}
        AND action=${key.action} AND idempotency_key=${key.idempotencyKey}
      FOR SHARE
    `)
  ).rows as {
    request_sha256: string;
    revision: number;
    status: AssignmentControlReceipt["status"];
    settled: boolean;
  }[];

  if (!row) return null;
  if (row.request_sha256 !== key.digest)
    throw new MaisterError(
      "CONFLICT",
      "This idempotency key already recorded a different assignment control",
      { details: { reason: "assignment_control_key_reused" } },
    );

  return {
    settled: row.settled,
    receipt: {
      id: key.assignmentId,
      revision: Number(row.revision),
      status: row.status,
      duplicate: true,
    },
  };
}

async function retainReceipt(
  tx: SqlTransaction,
  key: ControlKey & Readonly<{ reason: string | null }>,
  receipt: AssignmentControlReceipt,
  nextAttemptAt: SQL = sql`NULL`,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO specialist_assignment_control_receipts
      (assignment_id,actor_user_id,action,idempotency_key,request_sha256,revision,status,reason,next_attempt_at)
    VALUES (${key.assignmentId},${key.userId},${key.action},${key.idempotencyKey},
      ${key.digest},${receipt.revision},${receipt.status},${key.reason},${nextAttemptAt}::timestamptz)
  `);
}

async function lockVisibleControl(
  tx: SqlTransaction,
  key: Pick<ControlKey, "assignmentId" | "userId">,
) {
  await beginAssignmentTransaction(tx);
  // All writers take the exclusive head lock before examining visibility or receipts.
  await lockAssignmentHead(tx, key.assignmentId);

  return getVisibleSpecialistAssignmentInTransaction(
    tx,
    key.userId,
    key.assignmentId,
  );
}

function parseControl(raw: unknown): z.infer<typeof controlInputSchema> {
  const parsed = controlInputSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Assignment controls require an exact revision, a nonblank reason and an idempotency key",
    );

  return parsed.data;
}

/** Appends one correlated input revision; exact replay returns the original receipt. */
export async function submitAssignmentInput(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  raw: unknown,
): Promise<AssignmentControlOutcome> {
  const parsed = inputControlSchema.safeParse(raw);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Invalid exact-revision assignment input update",
    );
  const { idempotencyKey, ...update } = parsed.data;
  const key = {
    assignmentId,
    userId,
    action: "input" as const,
    idempotencyKey,
    digest: contentDigest({ action: "input", ...update }),
    reason: null,
  };

  try {
    return await db.transaction(async (tx) => {
      const current = await lockVisibleControl(tx, key);
      const replay = await priorReceipt(tx, key);

      if (replay) return replay;
      if (current.cancellationPending)
        throw new MaisterError(
          "CONFLICT",
          "Cancellation is already pending for this assignment",
          {
            details: { reason: "assignment_cancellation_pending" },
          },
        );
      const assignment = await appendSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        assignmentId,
        update,
      );
      const receipt: AssignmentControlReceipt = {
        id: assignmentId,
        revision: assignment.revision,
        status: receiptStatus(assignment.status),
        duplicate: false,
      };

      await retainReceipt(tx, key, receipt);

      return { receipt, settled: true };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Route the operator to the owner of the retained work or effect. */
export async function continueAssignment(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  raw: unknown,
): Promise<AssignmentControlOutcome> {
  const control = parseControl(raw);
  const key = {
    assignmentId,
    userId,
    action: "continue" as const,
    idempotencyKey: control.idempotencyKey,
    digest: contentDigest({
      action: "continue",
      expectedRevision: control.expectedRevision,
      reason: control.reason,
    }),
    reason: control.reason,
  };

  try {
    return await db.transaction(async (tx) => {
      const assignment = await lockVisibleControl(tx, key);
      const replay = await priorReceipt(tx, key);

      if (replay) return replay;
      await lockSpecialistAssignment(
        tx,
        assignmentId,
        control.expectedRevision,
      );
      await authorizeAssignment(
        tx,
        userId,
        assignment.owner,
        "assignments:recover",
        { preset: "supervised" },
      );
      const [state] = (
        await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM stand_operations operation
          WHERE operation.assignment_id=${assignmentId} AND operation.action='restart'
            AND (operation.effect_state IN ('dispatching','unknown')
              OR operation.effect_state='confirmed_applied' AND operation.verification_state<>'healthy')
        ) AS reconcile,
        EXISTS (
          SELECT 1 FROM specialist_run_links link JOIN runs child ON child.id=link.run_id
          WHERE link.assignment_id=${assignmentId} AND child.status='Review'
        ) AS review
      `)
      ).rows;

      if (state?.reconcile)
        throw new MaisterError(
          "CONFLICT",
          "Reconcile the retained operation under Stand operations before requesting further work",
          {
            details: { reason: "assignment_effect_reconciliation_required" },
          },
        );
      if (state?.review)
        throw new MaisterError(
          "CONFLICT",
          "Resolve the retained Review Run from its Run page",
          {
            details: { reason: "assignment_run_review_required" },
          },
        );
      if (!["failed", "cancelled"].includes(assignment.status))
        throw new MaisterError(
          "CONFLICT",
          "Use the current assignment controls or its Run recovery action",
          {
            details: { reason: "assignment_use_current_recovery" },
          },
        );
      throw new MaisterError(
        "CONFLICT",
        "Submit a new assignment for further work from this terminal outcome",
        {
          details: { reason: "assignment_new_request_required" },
        },
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

type StopRun = (runId: string) => Promise<unknown>;
type PendingCancellation = Readonly<{
  assignment_id: string;
  actor_user_id: string;
  revision: number;
  idempotency_key: string;
  reason: string;
}>;
type LinkedRun = Readonly<{
  id: string;
  status: RunStatusValue;
  run_kind: string;
  company_id: string | null;
}>;

async function liveCancellationRuns(
  tx: SqlTransaction,
  assignmentId: string,
): Promise<LinkedRun[]> {
  const { rows } = await tx.execute(sql`
    SELECT execution.id,execution.status,execution.run_kind,execution.company_id
    FROM runs execution JOIN specialist_run_links link ON link.run_id=execution.id
    WHERE link.assignment_id=${assignmentId} ORDER BY execution.parent_run_id NULLS FIRST,execution.id
  `);

  return (rows as LinkedRun[]).filter(
    ({ status }) => !isSettledRunStatus(status),
  );
}

function unstoppableRun(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "A linked Run cannot be stopped from its current state; settle it from the Run before cancelling",
    { details: { reason: "assignment_run_unstoppable" } },
  );
}

function logCancellationFailure(
  assignmentId: string,
  actorId: string,
  error: unknown,
  runId?: string,
): void {
  const failure = redactQueryError(error);
  const details = isMaisterError(failure) ? failure.details : undefined;

  log.warn(
    {
      assignmentId,
      actorId,
      runId,
      code: isMaisterError(failure) ? failure.code : null,
      reason: typeof details?.reason === "string" ? details.reason : null,
      constraint:
        typeof details?.constraint === "string" ? details.constraint : null,
      errorType: failure instanceof Error ? failure.name : typeof failure,
    },
    "assignment cancellation retained for native stop reconciliation",
  );
}

/** Persist the entire cancel intent before any Run owner is asked to stop. */
export async function cancelAssignmentExecution(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  raw: unknown,
  stopRun: StopRun,
): Promise<AssignmentControlOutcome> {
  const control = parseControl(raw);
  const key = {
    assignmentId,
    userId,
    action: "cancel" as const,
    idempotencyKey: control.idempotencyKey,
    digest: contentDigest({
      action: "cancel",
      expectedRevision: control.expectedRevision,
      reason: control.reason,
    }),
    reason: control.reason,
  };

  try {
    const outcome = await db.transaction(async (tx) => {
      const assignment = await lockVisibleControl(tx, key);
      const replay = await priorReceipt(tx, key);

      if (replay) return replay;
      await lockSpecialistAssignment(
        tx,
        assignmentId,
        control.expectedRevision,
      );
      await authorizeAssignment(
        tx,
        userId,
        assignment.owner,
        "assignments:cancel",
        { preset: "supervised" },
      );
      assertAssignmentCancellable(assignment.status);
      const [pending] = (
        await tx.execute(sql`
        SELECT 1 FROM specialist_assignment_control_receipts
        WHERE assignment_id=${assignmentId} AND next_attempt_at IS NOT NULL
      `)
      ).rows;

      if (pending)
        throw new MaisterError(
          "CONFLICT",
          "Cancellation is already pending for this assignment",
          {
            details: { reason: "assignment_cancellation_pending" },
          },
        );
      const live = await liveCancellationRuns(tx, assignmentId);

      if (assignment.owner.kind === "project" && live.length)
        await authorizeAssignment(
          tx,
          userId,
          assignment.owner,
          "assignments:recover",
          { preset: "supervised" },
        );
      for (const run of live) {
        if (run.company_id !== null) {
          await authorizeCompanyRunUserActionInTransaction(
            tx,
            userId,
            run.id,
            "assignments:cancel",
          );
          const allowed =
            run.run_kind === "flow"
              ? companyFlowCanAbandon(run.status)
              : (TERMINAL_CAS_SOURCE.Abandoned as readonly string[]).includes(
                  run.status,
                );

          if (!allowed) throw unstoppableRun();
        } else if (!isStoppableRunStatus(run.status)) throw unstoppableRun();
      }
      const receipt: AssignmentControlReceipt = {
        id: assignmentId,
        revision: assignment.revision,
        status: "active",
        duplicate: false,
      };

      await retainReceipt(tx, key, receipt, sql`clock_timestamp()`);

      return { receipt, settled: false };
    });

    if (outcome.settled || outcome.receipt.duplicate) return outcome;
    const settled = await resumeAssignmentCancellation(
      db,
      assignmentId,
      (runId) => stopRun(runId),
    );

    return settled ? { receipt: settled, settled: true } : outcome;
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Only one processor may drive an assignment's native stops. The claim drops with its connection. */
async function resumeAssignmentCancellation(
  db: SqlDatabase,
  assignmentId: string,
  stopRun: (runId: string, userId: string) => Promise<unknown>,
): Promise<AssignmentControlReceipt | null> {
  return db.transaction(async (claim) => {
    const [lock] = (
      await claim.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${assignmentId},7339)) AS acquired
    `)
    ).rows;

    if (lock?.acquired !== true) return null;

    const [pending] = (
      await claim.execute(sql`
      SELECT assignment_id,actor_user_id,revision,idempotency_key,reason
      FROM specialist_assignment_control_receipts
      WHERE assignment_id=${assignmentId} AND next_attempt_at<=clock_timestamp()
    `)
    ).rows as PendingCancellation[];

    if (!pending) return null;
    const userId = pending.actor_user_id;

    try {
      const linked = await db.transaction(async (tx) => {
        const assignment = await lockVisibleControl(tx, {
          assignmentId,
          userId,
        });

        await authorizeAssignment(
          tx,
          userId,
          assignment.owner,
          "assignments:cancel",
          { preset: "supervised" },
        );

        return liveCancellationRuns(tx, assignmentId);
      });

      for (const run of linked) {
        const [current] = (
          await claim.execute(sql`SELECT status FROM runs WHERE id=${run.id}`)
        ).rows;

        if (!current || isSettledRunStatus(String(current.status))) continue;
        try {
          await stopRun(run.id, userId);
        } catch (error) {
          logCancellationFailure(assignmentId, userId, error, run.id);
        }
      }

      return await db.transaction(async (tx) => {
        const assignment = await lockVisibleControl(tx, {
          assignmentId,
          userId,
        });
        const state = await cancelSpecialistAssignmentInTransaction(
          tx,
          userId,
          assignmentId,
          assignment.revision,
          pending.reason,
        );

        await tx.execute(sql`
          UPDATE specialist_assignment_control_receipts
          SET revision=${state.revision},status='cancelled',next_attempt_at=NULL
          WHERE assignment_id=${assignmentId} AND actor_user_id=${userId}
            AND action='cancel' AND idempotency_key=${pending.idempotency_key}
        `);
        log.info(
          { assignmentId, revision: state.revision, actorId: userId },
          "assignment cancellation settled",
        );

        return {
          id: assignmentId,
          revision: state.revision,
          status: "cancelled",
          duplicate: false,
        };
      });
    } catch (error) {
      await claim.execute(sql`
        UPDATE specialist_assignment_control_receipts SET next_attempt_at=clock_timestamp()+interval '30 seconds'
        WHERE assignment_id=${assignmentId} AND next_attempt_at IS NOT NULL
      `);
      logCancellationFailure(assignmentId, userId, error);

      return null;
    }
  });
}

export async function reconcileAssignmentCancellations(
  db: SqlDatabase,
  stopRun: (userId: string, runId: string) => Promise<unknown>,
): Promise<void> {
  const { rows } = await db.execute(sql`
    SELECT assignment_id FROM specialist_assignment_control_receipts
    WHERE next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,assignment_id LIMIT 10
  `);

  for (const row of rows)
    await resumeAssignmentCancellation(
      db,
      String(row.assignment_id),
      (runId, userId) => stopRun(userId, runId),
    );
}
