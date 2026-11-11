import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentContextPrincipal } from "./context-access";
import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  readAuthorizedAssignmentInput,
  readSpecialistAssignmentContextInTransaction,
  retainAssignmentContextRevision,
} from "./context";
import {
  authorizeAssignmentWorkAcceptance,
  resolveAssignmentContextPrincipal,
} from "./context-access";
import { assignmentContextSnapshotSchema } from "./context-types";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
  inspectExecutingAssignmentInTransaction,
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
import { lockDelegationParent } from "@/lib/orchestrator/admission";
import { projectNativeFindings } from "@/lib/run-results/findings-projection";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "specialist-work-decision",
  level: process.env.LOG_LEVEL ?? "info",
});
const workDecisionSchema = z
  .object({
    expectedRevision: knowledgeRevisionSchema,
    workRevision: knowledgeRevisionSchema,
    inputRevision: knowledgeRevisionSchema,
    resultRevision: knowledgeRevisionSchema,
    decision: z.enum(["accept", "reject"]),
    reason: postgresTextSchema.min(1).max(2000).regex(/\S/),
    idempotencyKey: knowledgeDeliveryKeySchema,
  })
  .strict();

type WorkDecision = z.infer<typeof workDecisionSchema>;
type WorkDecisionReceipt = Readonly<{
  id: string;
  revision: number;
  status: "accepted" | "rejected";
  duplicate: boolean;
}>;
type WorkDecisionRequest = Readonly<{
  assignmentId: string;
  workId: string;
  value: unknown;
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
    SELECT result.id,result.value,child.knowledge_access,child.result_contract
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
      "A work decision requires the exact collected result and available source evidence",
      { details: { reason: "work_acceptance_result_unavailable" } },
    );
  const sourceFindings =
    projectNativeFindings(
      result.result_contract as RunResultContract | null,
      result.value,
    )?.findings.map((finding) => ({
      childRunId,
      resultRevision,
      findingId: finding.id,
    })) ?? [];

  return {
    id: result.id,
    restrictions: capture.data.restrictions,
    sourceFindings,
  };
}

/** Review one exact collected child result and retain the attributed context entry atomically. */
export function decideSpecialistWork(
  db: SqlDatabase,
  { userId, ...input }: WorkDecisionRequest & Readonly<{ userId: string }>,
): Promise<WorkDecisionReceipt> {
  return decideWork(db, input, { kind: "user", userId }, null);
}

export function decideSpecialistWorkByToken(
  db: SqlDatabase,
  {
    tokenId,
    boundRunId,
    ...input
  }: WorkDecisionRequest &
    Readonly<{ tokenId: string; boundRunId: string | null }>,
): Promise<WorkDecisionReceipt> {
  return decideWork(db, input, { kind: "token", tokenId }, boundRunId);
}

async function decideWork(
  db: SqlDatabase,
  input: WorkDecisionRequest,
  principal: AssignmentContextPrincipal,
  boundRunId: string | null,
): Promise<WorkDecisionReceipt> {
  const parsed = workDecisionSchema.safeParse(input.value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "A work decision requires the exact input, work and result revisions",
    );
  const decision: WorkDecision = parsed.data;
  const status = decision.decision === "accept" ? "accepted" : "rejected";

  return db.transaction(async (tx) => {
    const { assignmentId, workId } = input;

    await beginAssignmentTransaction(tx);
    if (boundRunId !== null) await lockDelegationParent(tx, boundRunId);
    await tx.execute(
      sql`SELECT id FROM specialist_assignments WHERE id=${assignmentId} FOR UPDATE`,
    );
    const resolved = await resolveAssignmentContextPrincipal(
      tx,
      principal,
      "assignments:accept",
    );
    const { source } = resolved;

    if (source.kind === "execution" && source.runId !== boundRunId)
      throw unavailableAssignment();
    const assignment =
      source.kind === "user"
        ? await getSpecialistAssignmentInTransaction(
            tx,
            source.userId,
            assignmentId,
          )
        : (
            await inspectExecutingAssignmentInTransaction(
              tx,
              source,
              assignmentId,
            )
          ).value;
    const retainedInput = await readAuthorizedAssignmentInput(
      tx,
      source,
      assignmentId,
      decision.inputRevision,
    );
    const { authority, executionEpoch } =
      await authorizeAssignmentWorkAcceptance(
        tx,
        resolved,
        assignment.owner,
        retainedInput.snapshot.authoritySnapshot.executionPolicy,
      );
    const [work] = (
      await tx.execute(sql`
      SELECT revision,input_revision,child_run_id,parent_run_id,actor->>'id' AS origin_role,
        decision_state,definition,source_restrictions FROM specialist_work
      WHERE id=${workId} AND work_revision=${decision.workRevision} AND assignment_id=${assignmentId} FOR UPDATE
    `)
    ).rows;

    if (typeof work?.child_run_id !== "string") throw unavailableAssignment();
    if (
      source.kind === "execution" &&
      (source.runId !== work.parent_run_id ||
        authority.actor.id !== work.origin_role)
    )
      throw unavailableAssignment();
    if (work.input_revision !== decision.inputRevision) throw staleWork();
    const childRunId = work.child_run_id;
    const definition = assignmentWorkDefinitionSchema.parse(work.definition);

    if (
      status === "accepted" &&
      (!definition.objectiveInput.expectedResult.required ||
        definition.objectiveInput.verification.some(
          (obligation) => obligation.kind !== "result" && obligation.required,
        ))
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
      ...(source.kind === "user"
        ? { userId: source.userId }
        : {
            actor: {
              kind: authority.actor.kind,
              id: authority.actor.id,
              runId: source.runId,
            },
          }),
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

      return { id: existing.id, revision, status, duplicate: true };
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
        ${decision.decision},${result.id},${decision.resultRevision},${decision.idempotencyKey},${requestDigest},${decision.reason})`);
    await tx.execute(
      sql`UPDATE specialist_work SET decision_state=${status},revision=${revision} WHERE id=${workId} AND work_revision=${decision.workRevision}`,
    );
    const current = await readSpecialistAssignmentContextInTransaction(
      tx,
      source,
      assignmentId,
    );
    const access = await authorizeSourceRestrictions(
      tx,
      source,
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
            text: decision.reason,
            references: [],
            ...(status === "accepted"
              ? {
                  kind: "accepted",
                  state: "accepted",
                  acceptedWork: {
                    decisionId: id,
                    workId,
                    workRevision: decision.workRevision,
                    childRunId,
                    resultRevision: decision.resultRevision,
                    sourceFindings: result.sourceFindings,
                  },
                }
              : { kind: "decision", state: "resolved" }),
          },
          actor: authority.actor,
          introducedRevision: contextRevision,
          ownerEpoch: null,
          ...(executionEpoch === null ? {} : { executionEpoch }),
        },
      ],
    });

    await retainAssignmentContextRevision(tx, {
      assignmentId,
      baseRevision: assignment.contextRevision,
      snapshot,
      actor: authority.actor,
      executionEpoch,
      sourceRestrictions: restrictionsForKnowledgeAccess(access),
      requestKey: `${decision.decision}-${id}`,
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
      actor: { type: authority.actor.kind, id: authority.actor.id },
      ...(source.kind === "execution"
        ? {
            originExecution: {
              runId: source.runId,
              nodeAttemptId: source.nodeAttemptId,
            },
          }
        : {}),
    });
    log.info(
      {
        assignmentId,
        workId,
        workRevision: decision.workRevision,
        decisionId: id,
        resultRevision: decision.resultRevision,
        contextRevision,
        status,
      },
      "exact specialist work decision retained",
    );

    return { id, revision, status, duplicate: false };
  });
}
