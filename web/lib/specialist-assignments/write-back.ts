import "server-only";

import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type {
  KnowledgeDraft,
  KnowledgePrincipal,
  KnowledgeReference,
} from "@/lib/brain/knowledge-types";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
} from "./store";

import { authorizeKnowledge } from "@/lib/brain/knowledge-access";
import {
  canonicalKnowledgeRestrictions,
  lockKnowledgeWriteConsumer,
} from "@/lib/brain/knowledge-disclosure";
import { createKnowledgeProposalInTransaction } from "@/lib/brain/knowledge-proposals";
import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { retainSourceCapture } from "@/lib/brain/knowledge-source-capture";
import { authorizeRunKnowledgeDisclosure } from "@/lib/brain/knowledge-run-disclosure";
import { matchesReferenceWitness } from "@/lib/brain/knowledge-reference";
import { installationCompany } from "@/lib/company/grants";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { evidenceFindingsV1Schema } from "@/lib/run-results/findings-types";
import { operationalEvidenceV2Schema } from "@/lib/run-results/operational-schema";
import {
  knowledgeAccessCaptureSchema,
  knowledgeRestrictionsSchema,
} from "@/lib/company/types";

const log = pino({
  name: "specialist-assignment-write-back",
  level: process.env.LOG_LEVEL ?? "info",
});
const acceptedWork = z.object({
  acceptance_id: z.string(),
  accepted_by: z.string(),
  input_revision: z.number().int().positive(),
  input_sha256: z.string(),
  result_id: z.string(),
  run_id: z.string(),
  result_revision: z.number().int().positive(),
  schema_sha256: z.string(),
  value_sha256: z.string(),
  node_attempt_id: z.string().nullable(),
  value: z.unknown(),
  source_restrictions: knowledgeRestrictionsSchema,
});

async function readWork(tx: SqlTransaction, assignmentId: string) {
  const [row] = (
    await tx.execute(sql`
    SELECT acceptance.id AS acceptance_id,acceptance.actor->>'id' AS accepted_by,
      acceptance.input_revision,input.digest AS input_sha256,
      result.id AS result_id,result.run_id,result.revision AS result_revision,result.schema_sha256,
      delivery.snapshot->>'resultSha256' AS value_sha256,
      result.node_attempt_id,result.value,delivery.snapshot->'sourceRestrictions' AS source_restrictions
    FROM specialist_assignments assignment
    JOIN specialist_acceptances acceptance ON acceptance.id=assignment.acceptance_id AND acceptance.assignment_id=assignment.id
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=acceptance.input_revision
    JOIN run_results result ON result.id=acceptance.result_id AND result.run_id=acceptance.run_id AND result.revision=acceptance.result_revision
    JOIN specialist_delivery_receipts delivery ON delivery.assignment_id=assignment.id AND delivery.input_revision=input.revision
      AND delivery.run_id=result.run_id AND delivery.result_revision=result.revision
      AND delivery.snapshot->>'resultSha256'=encode(sha256(convert_to(jsonb_build_object(
        'schemaRef',result.schema_ref,'schemaVersion',result.schema_version,'schemaSha256',result.schema_sha256,'value',result.value
      )::text,'UTF8')),'hex')
    WHERE assignment.id=${assignmentId} AND assignment.status='completed'
    FOR SHARE OF assignment,acceptance,input,result,delivery
  `)
  ).rows;
  const retained = acceptedWork.safeParse(row);

  if (!retained.success)
    throw new MaisterError(
      "PRECONDITION",
      "The exact accepted result witness is unavailable",
    );

  return retained.data;
}

type AcceptedWork = z.infer<typeof acceptedWork>;
type DraftEvidence = KnowledgeDraft["evidence"][number];

/** Resolve a cited result within the accepted execution tree using its exact retained revision. */
async function readCitedResult(
  tx: SqlTransaction,
  principal: KnowledgePrincipal,
  work: AcceptedWork,
  reference: KnowledgeReference,
) {
  const [row] = (
    await tx.execute(sql`
      WITH RECURSIVE ancestry AS (
        SELECT run.id,run.parent_run_id,ARRAY[run.id] AS visited FROM runs run WHERE run.id=${reference.id}
        UNION ALL
        SELECT parent.id,parent.parent_run_id,ancestry.visited || parent.id
          FROM runs parent JOIN ancestry ON parent.id=ancestry.parent_run_id
        WHERE cardinality(ancestry.visited)<256 AND NOT parent.id=ANY(ancestry.visited)
      )
      SELECT result.id,result.revision,result.schema_sha256,result.value,source.knowledge_access
      FROM run_results result JOIN runs source ON source.id=result.run_id
      WHERE result.run_id=${reference.id} AND result.revision=${reference.revision ?? null}
        AND result.validity IN ('valid','superseded') AND EXISTS (SELECT 1 FROM ancestry WHERE ancestry.id=${work.run_id})
        AND (result.id=${work.result_id} OR (result.run_id<>${work.run_id} AND result.first_collected_at IS NOT NULL))
      FOR SHARE OF result,source
    `)
  ).rows;

  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.revision !== "number" ||
    typeof row.schema_sha256 !== "string"
  )
    throw new MaisterError(
      "PRECONDITION",
      "The cited result is unavailable in the accepted execution tree",
      {
        details: { reason: "knowledge_reference_unavailable" },
      },
    );
  const sha256 = contentDigest(row.value);

  if (
    !matchesReferenceWitness(
      reference,
      row.revision,
      String(row.revision),
      sha256,
    )
  )
    throw new MaisterError(
      "PRECONDITION",
      "The cited result does not match its retained revision",
      {
        details: { reason: "knowledge_reference_unavailable" },
      },
    );
  const capture = knowledgeAccessCaptureSchema.safeParse(row.knowledge_access);

  if (!capture.success || capture.data.state !== "complete")
    throw new MaisterError(
      "PRECONDITION",
      "The cited result has no complete source access capture",
      {
        details: { reason: "knowledge_reference_unavailable" },
      },
    );
  await authorizeRunKnowledgeDisclosure(tx, principal, reference.id);

  return {
    witness: {
      id: row.id,
      runId: reference.id,
      revision: row.revision,
      schemaSha256: row.schema_sha256,
      sha256,
    },
    restrictions: capture.data.restrictions,
  };
}

/** The requesting user submits existing model drafts under current Brain authority after business acceptance. */
export async function writeBackAcceptedAssignment(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
): Promise<string[]> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const principal = { kind: "user", userId } as const;

      await lockKnowledgeWriteConsumer(tx, principal);
      const assignment = await getSpecialistAssignmentInTransaction(
        tx,
        userId,
        assignmentId,
      );
      const work = await readWork(tx, assignmentId);

      if (work.accepted_by !== userId)
        throw new MaisterError(
          "UNAUTHORIZED",
          "The accepting user must submit the retained knowledge drafts",
        );
      await authorizeRunKnowledgeDisclosure(tx, principal, work.run_id);
      const findings = evidenceFindingsV1Schema.safeParse(work.value);
      const operational = operationalEvidenceV2Schema.safeParse(work.value);
      const drafts = operational.success
        ? operational.data.findings.knowledgeProposals
        : findings.success
          ? findings.data.knowledgeProposals
          : [];

      if (!drafts.length) return [];
      const authority = await authorizeKnowledge(
        tx,
        principal,
        assignment.owner,
        "knowledge:propose",
      );
      const origin = { runId: work.run_id, attemptId: work.node_attempt_id };
      const restrictions: KnowledgeAccessRestriction[] = [
        assignment.owner,
        ...work.source_restrictions,
        {
          kind: "assignment_input",
          assignmentId,
          inputRevision: work.input_revision,
          inputSha256: work.input_sha256,
        },
      ];
      const operationIds = operational.success
        ? operational.data.operationIds
        : [];
      const verificationIds = operational.success
        ? operational.data.verificationIds
        : [];
      const evidence = (
        await tx.execute(sql`
        SELECT operation.id AS "operationId",receipt.id AS "effectReceiptId",receipt.receipt_digest AS "effectSha256",
          receipt.target_receipt_revision AS "receiptRevision",receipt.captured_at AS "effectAt",
          probe.id AS "verificationId",probe.state AS "health",probe.observed_at AS "verifiedAt"
        FROM stand_operations operation JOIN stand_operation_receipts receipt ON receipt.operation_id=operation.id
        LEFT JOIN stand_verifications probe ON probe.effect_receipt_id=receipt.id
          AND probe.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(verificationIds)}::jsonb))
        WHERE operation.assignment_id=${assignmentId} AND operation.input_revision=${work.input_revision}
          AND operation.input_sha256=${work.input_sha256}
          AND operation.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(operationIds)}::jsonb))
        ORDER BY operation.id,receipt.target_receipt_revision,probe.id
      `)
      ).rows;

      if (
        new Set(evidence.map((row) => row.operationId)).size !==
          operationIds.length ||
        new Set(
          evidence.flatMap((row) =>
            row.verificationId ? [row.verificationId] : [],
          ),
        ).size !== verificationIds.length
      )
        throw new MaisterError(
          "PRECONDITION",
          "The accepted operation or independent verification witness is unavailable",
        );
      if (evidence.length)
        restrictions.push({
          kind: "stand_target",
          companyId: await installationCompany(tx),
        });
      const citedResults = new Map<
        string,
        Awaited<ReturnType<typeof readCitedResult>>
      >();

      for (const entry of drafts.flatMap((draft) => draft.evidence)) {
        if (entry.reference.kind !== "result") continue;
        const key = contentDigest(entry.reference);

        if (!citedResults.has(key)) {
          const cited = await readCitedResult(
            tx,
            principal,
            work,
            entry.reference,
          );

          citedResults.set(key, cited);
          restrictions.push(...cited.restrictions);
        }
      }
      const sourceRestrictions = canonicalKnowledgeRestrictions(restrictions);

      await authorizeSourceRestrictions(tx, principal, sourceRestrictions);
      const sourceKey = contentDigest({
        acceptanceId: work.acceptance_id,
        resultId: work.result_id,
      });
      const capture = await retainSourceCapture(tx, {
        actor: { ...authority.actor, ...origin },
        restrictions: sourceRestrictions,
        content: {
          owner: assignment.owner,
          title: "Accepted specialist work evidence",
          content: JSON.stringify({
            assignmentId,
            inputRevision: work.input_revision,
            inputSha256: work.input_sha256,
            acceptanceId: work.acceptance_id,
            result: {
              id: work.result_id,
              runId: work.run_id,
              revision: work.result_revision,
              schemaSha256: work.schema_sha256,
              sha256: work.value_sha256,
            },
            operations: evidence,
            ...(citedResults.size
              ? {
                  citedResults: [...citedResults.values()].map(
                    ({ witness }) => witness,
                  ),
                }
              : {}),
          }),
          reportedSourceVersion: sourceKey,
          idempotencyKey: sourceKey,
        },
      });
      const result: string[] = [];
      const resultWitnessIds = new Map<string, string>();

      for (const [key, cited] of citedResults) {
        const resultKey = contentDigest(cited.witness);
        const source = await retainSourceCapture(tx, {
          actor: { ...authority.actor, ...origin },
          restrictions: canonicalKnowledgeRestrictions([
            assignment.owner,
            ...cited.restrictions,
          ]),
          content: {
            owner: assignment.owner,
            title: "Cited specialist result evidence",
            content: JSON.stringify(cited.witness),
            reportedSourceVersion: resultKey,
            idempotencyKey: resultKey,
          },
        });

        resultWitnessIds.set(key, source.witnessId);
      }

      for (const draft of drafts) {
        if (
          draft.change === "add" &&
          contentDigest(draft.owner) !== contentDigest(assignment.owner)
        )
          throw new MaisterError(
            "CONFLICT",
            "Write-back requires the accepted assignment owner",
          );
        const content: KnowledgeDraft = {
          title: draft.title,
          kind: draft.kind,
          assertion: draft.assertion,
          basis: draft.basis,
          missingEvidence: draft.missingEvidence,
          limitations: draft.limitations,
          evidence: [
            ...draft.evidence.map((entry): DraftEvidence => {
              if (entry.reference.kind !== "result") return entry;
              const witnessId = resultWitnessIds.get(
                contentDigest(entry.reference),
              );

              if (!witnessId)
                throw new MaisterError(
                  "CRASH",
                  "The cited result witness was not retained",
                );

              return {
                relation: entry.relation,
                reference: { kind: "witness", id: witnessId },
              };
            }),
            {
              relation: "derived_from",
              reference: { kind: "witness", id: capture.witnessId },
            },
          ],
        };
        const saved = await createKnowledgeProposalInTransaction(
          tx,
          {
            owner: assignment.owner,
            principal,
            idempotencyKey: contentDigest({ sourceKey, draft }),
            draft: content,
            ...(draft.change === "add"
              ? { kind: "knowledge_add" }
              : {
                  kind: "knowledge_correct",
                  targetRecordId: draft.recordId,
                  expectedRecordRevision: draft.expectedRevision,
                }),
          },
          origin,
        );

        result.push(saved.id);
        log.info(
          {
            assignmentId,
            acceptanceId: work.acceptance_id,
            proposalId: saved.id,
            actorId: userId,
            duplicate: saved.duplicate,
          },
          "accepted work proposal retained",
        );
      }

      return [...new Set(result)];
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
