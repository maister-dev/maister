import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { SpecialistAssignmentStatus } from "./types";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { authorizeAssignment } from "./access";
import {
  appendSpecialistAssignmentInputInTransaction,
  beginAssignmentTransaction,
  cancelSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInTransaction,
  recoverSpecialistAssignmentInTransaction,
} from "./store";
import { assignmentInputUpdateSchema } from "./types";

import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { isTerminalRunStatus } from "@/lib/runs/run-status-sets";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "specialist-assignment-controls",
  level: process.env.LOG_LEVEL ?? "info",
});

type ControlAction = "input" | "continue" | "cancel";

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
  key: Readonly<{
    assignmentId: string;
    userId: string;
    action: ControlAction;
    idempotencyKey: string;
    digest: string;
  }>,
): Promise<AssignmentControlReceipt | null> {
  const [row] = (
    await tx.execute(sql`
      SELECT request_sha256,revision,status FROM specialist_assignment_control_receipts
      WHERE assignment_id=${key.assignmentId} AND actor_user_id=${key.userId}
        AND action=${key.action} AND idempotency_key=${key.idempotencyKey}
      FOR SHARE
    `)
  ).rows as {
    request_sha256: string;
    revision: number;
    status: AssignmentControlReceipt["status"];
  }[];

  if (!row) return null;
  if (row.request_sha256 !== key.digest)
    throw new MaisterError(
      "CONFLICT",
      "This idempotency key already recorded a different assignment control",
      { details: { reason: "assignment_control_key_reused" } },
    );
  // Replay still requires current read access; the receipt itself is content-free.
  await getSpecialistAssignmentInTransaction(tx, key.userId, key.assignmentId);

  return {
    id: key.assignmentId,
    revision: Number(row.revision),
    status: row.status,
    duplicate: true,
  };
}

async function retainReceipt(
  tx: SqlTransaction,
  key: Readonly<{
    assignmentId: string;
    userId: string;
    action: ControlAction;
    idempotencyKey: string;
    digest: string;
    reason: string | null;
  }>,
  receipt: AssignmentControlReceipt,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO specialist_assignment_control_receipts
      (assignment_id,actor_user_id,action,idempotency_key,request_sha256,revision,status,reason)
    VALUES (${key.assignmentId},${key.userId},${key.action},${key.idempotencyKey},
      ${key.digest},${receipt.revision},${receipt.status},${key.reason})
  `);
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
      await beginAssignmentTransaction(tx);
      const replay = await priorReceipt(tx, key);

      if (replay) return { receipt: replay, settled: true };
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

/** Reopens failed or cancelled work as queued intent; it never launches or repeats an effect itself. */
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
      await beginAssignmentTransaction(tx);
      const replay = await priorReceipt(tx, key);

      if (replay) return { receipt: replay, settled: true };
      const state = await recoverSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
        control.expectedRevision,
      );
      const receipt: AssignmentControlReceipt = {
        id: assignmentId,
        revision: state.revision,
        status: receiptStatus(state.status),
        duplicate: false,
      };

      await retainReceipt(tx, key, receipt);
      log.info(
        { assignmentId, revision: state.revision, actorId: userId },
        "assignment continuation accepted",
      );

      return { receipt, settled: false };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/**
 * Cancel stops the assignment's live linked runs first, then records the
 * cancellation. Teardown that has not settled yet is reported as pending
 * intent (202) with no receipt, so the same key retries safely.
 */
export async function cancelAssignmentExecution(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  raw: unknown,
  stopRun: (runId: string) => Promise<unknown>,
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
  const liveRunIds = await db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);
    const replay = await priorReceipt(tx, key);

    if (replay) return replay;
    const assignment = await getSpecialistAssignmentInTransaction(
      tx,
      userId,
      assignmentId,
    );

    if (assignment.revision !== control.expectedRevision)
      throw new MaisterError("CONFLICT", "Assignment revision is stale", {
        details: { currentRevision: assignment.revision },
      });
    await authorizeAssignment(
      tx,
      userId,
      assignment.owner,
      "assignments:cancel",
      { preset: "supervised" },
    );
    const linked = (
      await tx.execute(sql`
        SELECT execution.id,execution.status FROM runs execution
        JOIN specialist_run_links link ON link.run_id=execution.id
        WHERE link.assignment_id=${assignmentId}
        ORDER BY execution.id
      `)
    ).rows as { id: string; status: string }[];

    return linked
      .filter(({ status }) => !isTerminalRunStatus(status))
      .map(({ id }) => id);
  });

  if (!Array.isArray(liveRunIds)) return { receipt: liveRunIds, settled: true };
  for (const runId of liveRunIds) {
    try {
      await stopRun(runId);
    } catch (error) {
      // A stop another owner already finished, or one still tearing down, is
      // settled by the guarded cancellation below rather than here.
      if (!isMaisterError(error) || error.code !== "CONFLICT") throw error;
      log.warn(
        { assignmentId, runId, actorId: userId },
        "linked run stop did not settle during assignment cancellation",
      );
    }
  }

  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const replay = await priorReceipt(tx, key);

      if (replay) return { receipt: replay, settled: true };
      const state = await cancelSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
        control.expectedRevision,
        control.reason,
      );
      const receipt: AssignmentControlReceipt = {
        id: assignmentId,
        revision: state.revision,
        status: receiptStatus(state.status),
        duplicate: false,
      };

      await retainReceipt(tx, key, receipt);
      log.info(
        {
          assignmentId,
          revision: state.revision,
          stoppedRuns: liveRunIds.length,
          actorId: userId,
        },
        "assignment cancellation recorded after stopping owned runs",
      );

      return { receipt, settled: true };
    });
  } catch (error) {
    if (
      isMaisterError(error) &&
      error.details?.reason === "assignment_execution_unsettled"
    ) {
      log.info(
        { assignmentId, actorId: userId },
        "assignment cancellation pending linked run teardown",
      );

      return {
        receipt: {
          id: assignmentId,
          revision: control.expectedRevision,
          status: "active",
          duplicate: false,
        },
        settled: false,
      };
    }
    throw redactQueryError(error);
  }
}
