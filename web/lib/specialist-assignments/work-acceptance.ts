import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { authorizeAssignment } from "./access";
import {
  readAuthorizedAssignmentInput,
  readSpecialistAssignmentContextInTransaction,
  retainAssignmentContextRevision,
} from "./context";
import { assignmentContextSnapshotSchema } from "./context-types";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
  unavailableAssignment,
} from "./store";
import { assignmentWorkDefinitionSchema } from "./work-types";

import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import {
  knowledgeDeliveryKeySchema,
  knowledgeRevisionSchema,
} from "@/lib/brain/knowledge-types";
import {
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
} from "@/lib/brain/knowledge-restrictions";
import {
  knowledgeAccessCaptureSchema,
  knowledgeRestrictionsSchema,
} from "@/lib/company/types";
import { emitSpecialistAssignmentChange } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { evidenceFindingsV1Schema } from "@/lib/run-results/findings-types";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "specialist-work-acceptance",
  level: process.env.LOG_LEVEL ?? "info",
});
const workAcceptanceSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    workRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    resultRevision: knowledgeRevisionSchema,
    decision: z.literal("accept"),
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

type WorkAcceptance = z.infer<typeof workAcceptanceSchema>;
type WorkAcceptanceReceipt = Readonly<{
  id: string;
  revision: number;
  status: "accepted";
  duplicate: boolean;
}>;

function staleWork(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "The exact work, result, or input revision changed",
    {
      details: { reason: "work_acceptance_conflict" },
    },
  );
}

async function readWorkResult(
  tx: SqlTransaction,
  childRunId: string,
  resultRevision: number,
  expected: NonNullable<
    z.infer<
      typeof assignmentWorkDefinitionSchema
    >["objectiveInput"]["expectedResult"]
  >,
) {
  const [result] = (
    await tx.execute(sql`
    SELECT result.id,result.value,child.knowledge_access,child.result_contract->>'nativeContract' AS native_contract
    FROM runs child JOIN run_results result ON result.run_id=child.id
    WHERE child.id=${childRunId} AND child.status='Done' AND result.revision=${resultRevision}
      AND result.validity='valid' AND result.first_collected_at IS NOT NULL
      AND result.schema_ref=${expected.schemaRef} AND result.schema_version=${expected.schemaVersion}
      AND result.schema_sha256=${expected.sha256}
    FOR SHARE OF result
  `)
  ).rows;
  const capture = knowledgeAccessCaptureSchema.safeParse(
    result?.knowledge_access,
  );

  if (
    typeof result?.id !== "string" ||
    !capture.success ||
    capture.data.state !== "complete"
  )
    throw new MaisterError(
      "PRECONDITION",
      "Work acceptance requires the exact collected result and available source evidence",
      { details: { reason: "work_acceptance_result_unavailable" } },
    );
  const sourceFindings =
    result.native_contract === FINDINGS_CONTRACT
      ? evidenceFindingsV1Schema
          .parse(result.value)
          .findings.map((finding) => ({
            childRunId,
            resultRevision,
            findingId: finding.id,
          }))
      : [];

  return {
    id: result.id,
    restrictions: capture.data.restrictions,
    sourceFindings,
  };
}

/** Accept one exact collected child result and retain the attributed context entry atomically. */
export async function acceptSpecialistWork(
  db: SqlDatabase,
  input: Readonly<{
    userId: string;
    assignmentId: string;
    workId: string;
    value: unknown;
  }>,
): Promise<WorkAcceptanceReceipt> {
  const parsed = workAcceptanceSchema.safeParse(input.value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Work acceptance requires the exact input, work and result revisions",
    );
  const decision: WorkAcceptance = parsed.data;

  return db.transaction(async (tx) => {
    const { assignmentId, workId, userId } = input;
    const principal = { kind: "user", userId } as const;

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
      decision.inputRevision,
    );
    const authority = await authorizeAssignment(
      tx,
      userId,
      assignment.owner,
      "assignments:accept",
      retainedInput.snapshot.authoritySnapshot.executionPolicy,
    );
    const [work] = (
      await tx.execute(sql`
      SELECT revision,input_revision,child_run_id,decision_state,definition,source_restrictions FROM specialist_work
      WHERE id=${workId} AND work_revision=${decision.workRevision} AND assignment_id=${assignmentId} FOR UPDATE
    `)
    ).rows;

    if (typeof work?.child_run_id !== "string") throw unavailableAssignment();
    if (work.input_revision !== decision.inputRevision) throw staleWork();
    const childRunId = work.child_run_id;
    const definition = assignmentWorkDefinitionSchema.parse(work.definition);

    if (
      !definition.objectiveInput.expectedResult.required ||
      definition.objectiveInput.verification.some(
        (obligation) => obligation.kind !== "result" && obligation.required,
      )
    )
      throw new MaisterError(
        "PRECONDITION",
        "Required work verification is not available for acceptance",
        { details: { reason: "work_acceptance_verification_unmet" } },
      );

    await authorizeRunKnowledgeDisclosure(tx, principal, childRunId);
    const result = await readWorkResult(
      tx,
      childRunId,
      decision.resultRevision,
      definition.objectiveInput.expectedResult,
    );
    const requestDigest = contentDigest({
      assignmentId,
      workId,
      userId,
      decision,
    });
    const [existing] = (
      await tx.execute(sql`
      SELECT id,request_sha256,result_id FROM specialist_work_decisions
      WHERE work_id=${workId} AND request_key=${decision.idempotencyKey}
    `)
    ).rows;
    const revision = decision.expectedRevision + 1;

    if (existing) {
      if (
        typeof existing.id !== "string" ||
        existing.request_sha256 !== requestDigest ||
        existing.result_id !== result.id
      )
        throw staleWork();

      return { id: existing.id, revision, status: "accepted", duplicate: true };
    }
    if (
      work.revision !== decision.expectedRevision ||
      work.decision_state !== "open" ||
      decision.inputRevision !== assignment.inputRevision ||
      !["active", "waiting_children", "awaiting_acceptance"].includes(
        assignment.status,
      ) ||
      decision.expectedRevision === 2147483647 ||
      assignment.revision === 2147483647 ||
      assignment.contextRevision === 2147483647
    )
      throw staleWork();
    const id = randomUUID();

    await tx.execute(sql`INSERT INTO specialist_work_decisions
      (id,work_id,work_revision,expected_revision,input_revision,actor,authority_snapshot,decision,result_id,result_revision,request_key,request_sha256,reason)
      VALUES(${id},${workId},${decision.workRevision},${decision.expectedRevision},${decision.inputRevision},${JSON.stringify(authority.actor)}::jsonb,${JSON.stringify(authority)}::jsonb,
        'accept',${result.id},${decision.resultRevision},${decision.idempotencyKey},${requestDigest},${decision.reason})`);
    await tx.execute(
      sql`UPDATE specialist_work SET decision_state='accepted',revision=${revision} WHERE id=${workId} AND work_revision=${decision.workRevision}`,
    );
    const current = await readSpecialistAssignmentContextInTransaction(
      tx,
      principal,
      assignmentId,
    );
    const access = await authorizeSourceRestrictions(
      tx,
      principal,
      [
        ...knowledgeRestrictionsSchema.parse(work.source_restrictions),
        ...result.restrictions,
      ],
      current.access,
    );
    const contextRevision = assignment.contextRevision + 1;
    const snapshot = assignmentContextSnapshotSchema.parse({
      schemaVersion: 1,
      inputRevision: retainedInput.revision,
      inputSha256: retainedInput.digest,
      entries: [
        ...current.value.entries,
        {
          entry: {
            id,
            kind: "accepted",
            state: "accepted",
            text: decision.reason,
            references: [],
            acceptedWork: {
              decisionId: id,
              workId,
              workRevision: decision.workRevision,
              childRunId,
              resultRevision: decision.resultRevision,
              sourceFindings: result.sourceFindings,
            },
          },
          actor: authority.actor,
          introducedRevision: contextRevision,
          ownerEpoch: null,
        },
      ],
    });

    await retainAssignmentContextRevision(tx, {
      assignmentId,
      baseRevision: assignment.contextRevision,
      snapshot,
      actor: authority.actor,
      sourceRestrictions: restrictionsForKnowledgeAccess(access),
      requestKey: `accept-${id}`,
      requestDigest,
    });
    await tx.execute(
      sql`UPDATE specialist_assignments SET revision=revision+1,context_revision=${contextRevision},updated_at=clock_timestamp() WHERE id=${assignmentId}`,
    );
    await emitSpecialistAssignmentChange({
      db: tx,
      owner: assignment.owner,
      assignmentId,
      revision: assignment.revision + 1,
      previousStatus: assignment.status,
      status: assignment.status,
      cause: "work",
      actor: { type: "user", id: userId },
    });
    log.info(
      {
        assignmentId,
        workId,
        workRevision: decision.workRevision,
        decisionId: id,
        resultRevision: decision.resultRevision,
        contextRevision,
      },
      "exact specialist work accepted",
    );

    return { id, revision, status: "accepted", duplicate: false };
  });
}
