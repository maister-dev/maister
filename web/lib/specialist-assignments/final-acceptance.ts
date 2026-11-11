import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentResultWitness } from "./delivery-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { authorizeAssignment } from "./access";
import {
  readAuthorizedAssignmentInput,
  readSpecialistAssignmentContextInTransaction,
} from "./context";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
} from "./store";

import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "specialist-assignment-acceptance",
  level: process.env.LOG_LEVEL ?? "info",
});
const identity = postgresTextSchema.min(1).max(128);
const acceptanceSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    contextRevision: z.number().int().min(0).max(2147483647),
    result: z
      .object({ runId: identity, revision: knowledgeRevisionSchema })
      .strict(),
    verificationIds: z.array(identity).max(16),
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

type FinalAcceptanceReceipt = Readonly<{
  id: string;
  revision: number;
  status: "completed";
  duplicate: boolean;
}>;

/** Only a current eligible root result moves business work to its review state. */
export async function markSpecialistResultReady(
  tx: SqlTransaction,
  snapshot: AssignmentResultWitness,
): Promise<void> {
  const { assignmentId, inputRevision, runId, resultRevision } = snapshot;

  // Re-read the appointment after any competing root admission has committed.
  await tx.execute(
    sql`SELECT id FROM specialist_assignments WHERE id=${assignmentId} FOR NO KEY UPDATE`,
  );
  const [head] = (
    await tx.execute(sql`
    WITH candidate AS (
      SELECT id,status FROM specialist_assignments
      WHERE id=${assignmentId} AND input_revision=${inputRevision}
        AND status IN ('active','reconciling') AND revision<2147483647
        AND specialist_final_result_id(id,${inputRevision},${runId},${resultRevision}) IS NOT NULL
    )
    UPDATE specialist_assignments subject SET status='awaiting_acceptance',
      revision=subject.revision+1,updated_at=clock_timestamp()
    FROM candidate WHERE subject.id=candidate.id
    RETURNING subject.revision,candidate.status AS previous_status
  `)
  ).rows;

  if (!head) return;
  if (
    typeof head.revision !== "number" ||
    (head.previous_status !== "active" &&
      head.previous_status !== "reconciling")
  )
    throw new MaisterError(
      "CRASH",
      "Result readiness did not return the retained assignment state",
    );
  await emitSpecialistAssignmentChange({
    db: tx,
    owner: snapshot.owner,
    assignmentId,
    revision: head.revision,
    previousStatus: head.previous_status,
    status: "awaiting_acceptance",
    cause: "state",
    actor: { type: "system", id: null },
  });
  log.info(
    { assignmentId, runId, inputRevision, resultRevision },
    "assignment root result ready for acceptance",
  );
}

/** Final result-only acceptance is distinct from every child decision. */
export async function acceptSpecialistAssignment(
  db: SqlDatabase,
  input: Readonly<{ userId: string; assignmentId: string; value: unknown }>,
): Promise<FinalAcceptanceReceipt> {
  const parsed = acceptanceSchema.safeParse(input.value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Assignment acceptance requires exact business, input, context and result revisions",
    );
  const request = parsed.data;
  const { userId, assignmentId } = input;
  const principal = { kind: "user", userId } as const;
  const requestDigest = contentDigest({ assignmentId, userId, request });
  const revision = request.expectedRevision + 1;

  return db.transaction(async (tx) => {
    await beginAssignmentTransaction(tx);
    await tx.execute(
      sql`SELECT id FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
    );
    const assignment = await getSpecialistAssignmentInTransaction(
      tx,
      userId,
      assignmentId,
    );
    const retainedInput = await readAuthorizedAssignmentInput(
      tx,
      principal,
      assignmentId,
      request.inputRevision,
    );
    const authority = await authorizeAssignment(
      tx,
      userId,
      assignment.owner,
      "assignments:accept",
      retainedInput.snapshot.authoritySnapshot.executionPolicy,
    );

    await readSpecialistAssignmentContextInTransaction(
      tx,
      principal,
      assignmentId,
      request.contextRevision,
    );

    const [existing] = (
      await tx.execute(sql`
      SELECT id,request_key,request_sha256 FROM specialist_acceptances WHERE assignment_id=${assignmentId}
    `)
    ).rows;

    if (existing) {
      if (
        typeof existing.id !== "string" ||
        existing.request_key !== request.idempotencyKey ||
        existing.request_sha256 !== requestDigest
      )
        throw new MaisterError(
          "CONFLICT",
          "The assignment already has a different acceptance",
        );
      await authorizeRunKnowledgeDisclosure(
        tx,
        principal,
        request.result.runId,
      );

      return {
        id: existing.id,
        revision,
        status: "completed",
        duplicate: true,
      };
    }
    if (
      assignment.status !== "awaiting_acceptance" ||
      request.expectedRevision !== assignment.revision ||
      request.inputRevision !== assignment.inputRevision ||
      request.contextRevision !== assignment.contextRevision ||
      request.expectedRevision === 2147483647
    )
      throw new MaisterError(
        "CONFLICT",
        "Assignment acceptance requires the current ready result and assignment heads",
        {
          details: { reason: "assignment_acceptance_conflict" },
        },
      );
    if (request.verificationIds.length)
      throw new MaisterError(
        "PRECONDITION",
        "This acceptance requires a result-only obligation set",
        {
          details: { reason: "assignment_acceptance_verification_unmet" },
        },
      );
    await authorizeRunKnowledgeDisclosure(tx, principal, request.result.runId);
    const [witness] = (
      await tx.execute(sql`
      SELECT result.id AS result_id FROM specialist_delivery_receipts witness
      JOIN run_results result ON result.id=specialist_final_result_id(
        witness.assignment_id,witness.input_revision,witness.run_id,witness.result_revision)
      WHERE witness.assignment_id=${assignmentId} AND witness.input_revision=${request.inputRevision}
        AND witness.run_id=${request.result.runId} AND witness.result_revision=${request.result.revision}
      FOR SHARE OF result
    `)
    ).rows;

    if (typeof witness?.result_id !== "string")
      throw new MaisterError(
        "PRECONDITION",
        "The exact expected root result or its verification is unavailable",
        {
          details: { reason: "assignment_acceptance_result_unavailable" },
        },
      );
    const id = randomUUID();

    await tx.execute(sql`INSERT INTO specialist_acceptances
      (id,assignment_id,expected_revision,input_revision,context_revision,result_id,result_revision,run_id,actor,authority_snapshot,verification_ids,request_key,request_sha256,reason)
      VALUES(${id},${assignmentId},${request.expectedRevision},${request.inputRevision},${request.contextRevision},
        ${witness.result_id},${request.result.revision},${request.result.runId},${JSON.stringify(authority.actor)}::jsonb,${JSON.stringify(authority)}::jsonb,
        '[]'::jsonb,${request.idempotencyKey},${requestDigest},${request.reason})`);
    await tx.execute(sql`UPDATE specialist_assignments SET status='completed',acceptance_id=${id},
      revision=${revision},completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${assignmentId}`);
    await emitSpecialistAssignmentChange({
      db: tx,
      owner: assignment.owner,
      assignmentId,
      revision,
      previousStatus: assignment.status,
      status: "completed",
      cause: "acceptance",
      actor: { type: "user", id: userId },
    });
    log.info(
      {
        assignmentId,
        acceptanceId: id,
        inputRevision: request.inputRevision,
        runId: request.result.runId,
        resultRevision: request.result.revision,
      },
      "assignment exact root result accepted",
    );

    return { id, revision, status: "completed", duplicate: false };
  });
}
