import "server-only";

import type { KnowledgeTransaction } from "@/lib/brain/knowledge-access";
import type { KnowledgeAccessWalk } from "@/lib/brain/knowledge-restrictions";
import type {
  KnowledgePrincipal,
  KnowledgeReference,
} from "@/lib/brain/knowledge-types";
import type { AgentResultDecision } from "./agent-result";
import type { RunResultContract } from "./types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { FINDINGS_CONTRACT } from "./findings-contract";
import {
  inspectFindingsReduction,
  retainsEvidenceReference,
  type InheritedResultReference,
} from "./findings-reduction";
import { evidenceFindingsV1Schema } from "./findings-types";

import { authorizeKnowledge } from "@/lib/brain/knowledge-access";
import { recordKnowledgeDisclosure } from "@/lib/brain/knowledge-disclosure";
import { resolveRunKnowledgePrincipal } from "@/lib/brain/knowledge-execution-access";
import {
  authorizeKnowledgeRevisionRead,
  authorizeSourceRestrictions,
  restrictionsForKnowledgeAccess,
  unavailableKnowledgeReference,
} from "@/lib/brain/knowledge-restrictions";
import { inspectKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "findings-references",
  level: process.env.LOG_LEVEL ?? "info",
});

type LocatedReference = Readonly<{
  reference: KnowledgeReference;
  path: string;
}>;

function matchesReferenceWitness(
  reference: KnowledgeReference,
  revision: number | null,
  version: unknown,
  sha256: unknown,
): boolean {
  return (
    (reference.revision === undefined || reference.revision === revision) &&
    (reference.version === undefined || reference.version === version) &&
    (reference.sha256 === undefined || reference.sha256 === sha256)
  );
}

async function resolveReference(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  runId: string,
  reference: KnowledgeReference,
  access: KnowledgeAccessWalk,
  inheritedReferences: readonly InheritedResultReference[],
): Promise<KnowledgeAccessWalk> {
  if (reference.kind === "knowledge" && reference.revision !== undefined) {
    const authorized = await authorizeKnowledgeRevisionRead(
      tx,
      principal,
      reference.id,
      reference.revision,
      access,
    );
    const row = (
      await tx.execute(
        sql`SELECT content_sha256 FROM brain_record_revisions WHERE record_id=${reference.id} AND revision=${reference.revision}`,
      )
    ).rows[0];

    if (
      !row ||
      !matchesReferenceWitness(
        reference,
        reference.revision,
        String(reference.revision),
        row.content_sha256,
      )
    )
      throw unavailableKnowledgeReference();

    return authorized;
  }
  if (reference.kind === "witness" && reference.revision === undefined) {
    const inspection = await inspectKnowledgeWitness(
      tx,
      principal,
      reference.id,
      access,
    );

    if (
      !matchesReferenceWitness(
        reference,
        null,
        inspection.witness.sourceVersion,
        inspection.witness.sha256,
      )
    )
      throw unavailableKnowledgeReference();

    return inspection.access;
  }
  if (reference.kind === "result" && reference.revision !== undefined) {
    const origins = [
      ...new Set(
        inheritedReferences
          .filter((origin) =>
            retainsEvidenceReference(reference, origin.reference),
          )
          .map((origin) => origin.childRunId),
      ),
    ];
    const inherited =
      origins.length === 0
        ? sql`false`
        : sql`EXISTS (
      WITH RECURSIVE ancestry AS (
        SELECT execution.id,execution.parent_run_id,ARRAY[execution.id] AS path FROM runs execution WHERE execution.id=${reference.id}
        UNION ALL SELECT ancestor.id,ancestor.parent_run_id,lineage.path || ancestor.id FROM runs ancestor JOIN ancestry lineage ON ancestor.id=lineage.parent_run_id
          WHERE cardinality(lineage.path)<256 AND NOT ancestor.id=ANY(lineage.path)
      ) SELECT 1 FROM ancestry WHERE id IN (${sql.join(
        origins.map((id) => sql`${id}`),
        sql`, `,
      )}) AND id<>${reference.id}
    )`;
    const row = (
      await tx.execute(sql`
      SELECT result.value,child.knowledge_access FROM run_results result JOIN runs child ON child.id=result.run_id
      WHERE child.id=${reference.id} AND (child.parent_run_id=${runId} OR ${inherited}) AND result.revision=${reference.revision}
        AND result.first_collected_at IS NOT NULL AND result.validity IN ('valid','superseded') FOR SHARE OF result,child
    `)
    ).rows[0];
    const capture = knowledgeAccessCaptureSchema.safeParse(
      row?.knowledge_access,
    );

    if (
      !row ||
      !capture.success ||
      capture.data.state !== "complete" ||
      !matchesReferenceWitness(
        reference,
        reference.revision,
        String(reference.revision),
        contentDigest(row.value),
      )
    )
      throw unavailableKnowledgeReference();

    return authorizeSourceRestrictions(
      tx,
      principal,
      capture.data.restrictions,
      access,
    );
  }
  // Effect references require the stand operation owner's resolver, introduced with that slice.
  throw unavailableKnowledgeReference();
}

/** Validate inside terminal publication's transaction while the run and current authority are locked. */
export async function validateFindingsReferences(
  tx: KnowledgeTransaction,
  runId: string,
  contract: RunResultContract | null,
  decision: AgentResultDecision,
  nodeAttemptId?: string,
): Promise<AgentResultDecision> {
  if (decision.kind !== "valid" || contract === null) return decision;
  const native =
    contract.kind !== "agent_operational" &&
    contract.nativeContract === FINDINGS_CONTRACT;
  const parsed = native
    ? evidenceFindingsV1Schema.safeParse(decision.value)
    : null;

  if (parsed && !parsed.success)
    return {
      kind: "invalid",
      reason: "schema_mismatch",
      message: "Native findings do not match their frozen contract",
    };
  const findings = parsed?.success ? parsed.data : null;
  let path = "$";

  try {
    const row = (
      await tx.execute(
        sql`SELECT knowledge_access FROM runs WHERE id=${runId} FOR UPDATE`,
      )
    ).rows[0];

    if (!native && row?.knowledge_access === null) return decision;
    const capture = knowledgeAccessCaptureSchema.safeParse(
      row?.knowledge_access,
    );

    if (!capture.success || capture.data.state !== "complete")
      throw unavailableKnowledgeReference();
    const references: LocatedReference[] = (findings?.findings ?? []).flatMap(
      (finding, index) => [
        ...finding.supporting.map((reference, i) => ({
          reference,
          path: `findings[${index}].supporting[${i}]`,
        })),
        ...finding.contradicting.map((reference, i) => ({
          reference,
          path: `findings[${index}].contradicting[${i}]`,
        })),
      ],
    );

    for (const [index, proposal] of (
      findings?.knowledgeProposals ?? []
    ).entries()) {
      references.push(
        ...proposal.evidence.map((entry, i) => ({
          reference: entry.reference,
          path: `knowledgeProposals[${index}].evidence[${i}]`,
        })),
      );
      if (proposal.change === "correct")
        references.push({
          reference: {
            kind: "knowledge",
            id: proposal.recordId,
            revision: proposal.expectedRevision,
          },
          path: `knowledgeProposals[${index}].recordId`,
        });
    }
    if (references.length > 256) throw unavailableKnowledgeReference();
    const reduction =
      findings === null
        ? null
        : await inspectFindingsReduction(tx, runId, findings);

    if (
      references.length === 0 &&
      capture.data.restrictions.length === 0 &&
      (findings?.knowledgeProposals.length ?? 0) === 0 &&
      reduction?.hasSources !== true
    )
      return decision;
    const principal = await resolveRunKnowledgePrincipal(
      tx,
      runId,
      nodeAttemptId,
    );
    let access = await authorizeSourceRestrictions(tx, principal, [
      ...capture.data.restrictions,
      ...(reduction?.restrictions ?? []),
    ]);
    const visited = new Set<string>();

    for (const located of references) {
      path = located.path;
      const key = contentDigest(located.reference);

      if (visited.has(key)) continue;
      access = await resolveReference(
        tx,
        principal,
        runId,
        located.reference,
        access,
        reduction?.inheritedResultReferences ?? [],
      );
      visited.add(key);
    }
    for (const [index, proposal] of (
      findings?.knowledgeProposals ?? []
    ).entries()) {
      if (proposal.change !== "add") continue;
      path = `knowledgeProposals[${index}].owner`;
      await authorizeKnowledge(tx, principal, proposal.owner, "knowledge:read");
    }
    await recordKnowledgeDisclosure(
      tx,
      { runId, capture: capture.data },
      restrictionsForKnowledgeAccess(access),
    );
    log.debug(
      {
        runId,
        referenceCount: references.length,
        uniqueReferenceCount: visited.size,
        schemaSha256: contract.sha256,
      },
      "native findings references validated",
    );

    return decision;
  } catch (error) {
    if (
      !isMaisterError(error) ||
      (![
        "UNAUTHORIZED",
        "UNAUTHENTICATED",
        "ACCOUNT_INACTIVE",
        "PASSWORD_CHANGE_REQUIRED",
      ].includes(error.code) &&
        !(
          error.code === "PRECONDITION" &&
          [
            "knowledge_reference_unavailable",
            "knowledge_reference_budget_exceeded",
            "knowledge_capture_limit",
            "findings_reduction_invalid",
          ].includes(String(error.details?.reason))
        ))
    )
      throw error;
    const reductionInvalid =
      error.details?.reason === "findings_reduction_invalid";
    const failurePath =
      reductionInvalid && typeof error.details?.path === "string"
        ? error.details.path
        : path;

    log.warn(
      {
        runId,
        path: failurePath,
        reason: reductionInvalid
          ? "findings_reduction_invalid"
          : "reference_unavailable",
        schemaSha256: contract.sha256,
      },
      "native findings publication refused",
    );

    return {
      kind: "invalid",
      reason: "reference_invalid",
      message: reductionInvalid
        ? `Native findings reduction is invalid at ${failurePath}; preserve the exact collected finding and its evidence, limitations and questions`
        : `Execution result reference or source capture is unavailable at ${failurePath}`,
    };
  }
}
