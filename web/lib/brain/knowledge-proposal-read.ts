import "server-only";

import type {
  KnowledgeDatabase,
  KnowledgeTransaction,
} from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeAccessWalk } from "./knowledge-restrictions";
import type { KnowledgeProposalList } from "./knowledge-write-types";

import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import {
  authorizeKnowledge,
  knowledgeOwner,
  resolveKnowledgePrincipal,
} from "./knowledge-access";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import {
  decodeKnowledgeCursor,
  encodeKnowledgeCursor,
  knowledgeCursorScope,
} from "./knowledge-cursor";
import {
  knowledgeActorSchema,
  knowledgeRecordEvidenceSummarySchema,
} from "./knowledge-read-types";
import {
  knowledgeDraftSchema,
  knowledgeRevisionSchema,
} from "./knowledge-types";
import {
  knowledgeProposalContentSchema,
  knowledgeProposalListSchema,
} from "./knowledge-write-types";
import { knowledgeProposalReadPolicyCte } from "./knowledge-proposal-query";
import {
  authorizeSourceRestrictions,
  authorizeKnowledgeRevisionRead,
  restrictionsForKnowledgeAccess,
  unavailableKnowledgeReference,
} from "./knowledge-restrictions";
import {
  inspectKnowledgeWitness,
  knowledgeTimestamp,
} from "./knowledge-witnesses";
import { evidenceSummary } from "./knowledge-records";
import { resolveKnowledgeRecordCapture } from "./knowledge-record-capture";

import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError, isMaisterError } from "@/lib/errors";
import { truncateUtf16 } from "@/lib/utf8";

const log = pino({
  name: "brain:knowledge-proposals-read",
  level: process.env.LOG_LEVEL ?? "info",
});
const identity = postgresTextSchema.min(1).max(128);

export const knowledgeProposalViewSchema = z
  .object({
    id: identity,
    owner: ownerSchema,
    revision: knowledgeRevisionSchema,
    status: z.enum(["pending", "accepted", "rejected"]),
    content: knowledgeProposalContentSchema,
    attribution: knowledgeActorSchema,
    acceptedRecordId: identity.nullable(),
    acceptedRecordRevision: knowledgeRevisionSchema.nullable(),
    decision: z
      .object({
        by: identity.nullable(),
        at: z.string().datetime().nullable(),
        reason: postgresTextSchema.max(2000).nullable(),
        reviewedVersion: identity.nullable(),
      })
      .strict()
      .optional(),
    evidence: z.array(knowledgeRecordEvidenceSummarySchema).max(64),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const knowledgeProposalSummarySchema = knowledgeProposalViewSchema
  .omit({ content: true, evidence: true, decision: true })
  .extend({
    change: z.enum(["add", "correct"]),
    title: postgresTextSchema.min(1).max(256),
    kind: knowledgeDraftSchema.shape.kind,
    basis: knowledgeDraftSchema.shape.basis,
    assertionPreview: postgresTextSchema.max(1000),
    assertionTruncated: z.boolean(),
    targetRecordId: identity.nullable(),
    expectedRecordRevision: knowledgeRevisionSchema.nullable(),
  })
  .strict();
export type KnowledgeProposalView = z.infer<typeof knowledgeProposalViewSchema>;
export type KnowledgeProposalSummary = z.infer<
  typeof knowledgeProposalSummarySchema
>;
export type KnowledgeProposalPage = Readonly<{
  items: readonly KnowledgeProposalSummary[];
  nextCursor: string | null;
}>;

async function readProposal(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  proposalId: string,
  historyRead: boolean,
): Promise<{ proposal: KnowledgeProposalView; access: KnowledgeAccessWalk }> {
  const actor = await resolveKnowledgePrincipal(
    tx,
    principal,
    "knowledge:read",
  );
  const policy = knowledgeProposalReadPolicyCte(
    actor,
    principal,
    sql`p.id=${proposalId}`,
    sql`${historyRead}`,
  );
  const row = (
    await tx.execute(
      sql`${policy} SELECT p.*,permitted.inspection_action FROM brain_proposals p JOIN knowledge_readable_proposals permitted ON permitted.id=p.id FOR SHARE OF p`,
    )
  ).rows[0];

  if (!row) throw unavailableKnowledgeReference();
  const owner = knowledgeOwner(row);
  const action =
    row.inspection_action === "review"
      ? "knowledge:review"
      : row.inspection_action === "propose"
        ? "knowledge:propose"
        : "knowledge:read";

  await authorizeKnowledge(tx, principal, owner, action);
  let access = await authorizeSourceRestrictions(tx, principal, [owner]);

  access = await authorizeSourceRestrictions(
    tx,
    principal,
    row.source_restrictions,
    access,
  );
  const parsed = knowledgeDraftSchema.safeParse(row.draft);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Retained knowledge proposal does not match its native contract",
    );
  const evidence: KnowledgeProposalView["evidence"] = [];

  for (const link of parsed.data.evidence) {
    if (
      link.reference.kind !== "witness" &&
      link.reference.kind !== "knowledge"
    )
      throw new MaisterError(
        "PRECONDITION",
        "This proposal requires its native evidence resolver",
        { details: { reason: "native_reference_kind_unavailable" } },
      );
    const resolved =
      link.reference.kind === "knowledge"
        ? await resolveKnowledgeRecordCapture(
            tx,
            principal,
            link.reference,
            access,
          )
        : { witnessId: link.reference.id, access };

    access = resolved.access;
    const present =
      resolved.witnessId === null
        ? undefined
        : (
            await tx.execute(
              sql`SELECT id FROM brain_evidence_witnesses WHERE id=${resolved.witnessId}`,
            )
          ).rows[0];

    if (!present) {
      evidence.push({
        relation: link.relation,
        unavailable: {
          state: "missing",
          reasonCode: "proposal_source_capture_missing",
          reason:
            "The proposal's retained source capture is currently unavailable.",
        },
      });
      continue;
    }
    const inspection = await inspectKnowledgeWitness(
      tx,
      principal,
      resolved.witnessId!,
      access,
    );

    if (
      (link.reference.version !== undefined &&
        link.reference.version !== inspection.witness.sourceVersion) ||
      (link.reference.sha256 !== undefined &&
        link.reference.sha256 !== inspection.witness.sha256)
    )
      throw new MaisterError(
        "CONFLICT",
        "Proposal evidence does not match its retained version witness",
      );
    access = inspection.access;
    evidence.push(
      evidenceSummary({ relation: link.relation, witness: inspection.witness }),
    );
  }
  if (typeof row.published_record_id === "string")
    access = await authorizeKnowledgeRevisionRead(
      tx,
      principal,
      row.published_record_id,
      Number(row.published_record_revision),
      access,
    );
  const content =
    row.kind === "knowledge_add"
      ? { ...parsed.data, change: "add", owner }
      : {
          ...parsed.data,
          change: "correct",
          recordId: row.target_record_id,
          expectedRevision: row.expected_record_revision,
        };
  const value = knowledgeProposalViewSchema.safeParse({
    id: row.id,
    owner,
    revision: row.revision,
    status: row.status,
    content,
    attribution: row.knowledge_attribution,
    acceptedRecordId: row.published_record_id,
    acceptedRecordRevision: row.published_record_revision,
    ...(row.status !== "pending" && {
      decision: (() => {
        const resolution = z
          .object({
            actor: z.object({ id: identity }).optional(),
            reason: postgresTextSchema.max(2000).optional(),
          })
          .safeParse(row.resolution);

        return {
          by: resolution.data?.actor?.id ?? null,
          reason: resolution.data?.reason ?? null,
          at: row.resolved_at ? knowledgeTimestamp(row.resolved_at) : null,
          reviewedVersion:
            Number(row.revision) > 1 ? String(Number(row.revision) - 1) : null,
        };
      })(),
    }),
    evidence,
    createdAt: knowledgeTimestamp(row.created_at),
    updatedAt: knowledgeTimestamp(row.updated_at),
  });

  if (!value.success)
    throw new MaisterError(
      "CONFIG",
      "Retained proposal does not match its explicit read projection",
    );

  return { proposal: value.data, access };
}

export async function getKnowledgeProposal(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  proposalId: string,
  options?: Readonly<{ historyRead: true }>,
): Promise<KnowledgeProposalView> {
  if (!identity.safeParse(proposalId).success)
    throw new MaisterError("CONFIG", "Invalid knowledge proposal identity");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const result = await readProposal(
        tx,
        principal,
        proposalId,
        options?.historyRead ?? false,
      );

      if (Buffer.byteLength(JSON.stringify(result.proposal), "utf8") > 524288)
        throw new MaisterError(
          "PRECONDITION",
          "Knowledge proposal exceeds its bounded detail contract",
        );
      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(result.access),
      );
      log.debug(
        {
          proposalId,
          revision: result.proposal.revision,
          evidenceCount: result.proposal.evidence.length,
        },
        "knowledge proposal disclosed",
      );

      return result.proposal;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** A review page exposes bounded metadata; evidence inspection remains a separate exact-detail operation. */
function proposalSummary(
  row: Record<string, unknown>,
): KnowledgeProposalSummary {
  const parsed = knowledgeDraftSchema.safeParse(row.draft);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Retained knowledge proposal does not match its native contract",
    );
  const draft = parsed.data;
  const assertionPreview = truncateUtf16(draft.assertion, 1000);

  return knowledgeProposalSummarySchema.parse({
    id: row.id,
    owner: knowledgeOwner(row),
    revision: row.revision,
    status: row.status,
    attribution: row.knowledge_attribution,
    acceptedRecordId: row.published_record_id,
    acceptedRecordRevision: row.published_record_revision,
    createdAt: knowledgeTimestamp(row.created_at),
    updatedAt: knowledgeTimestamp(row.updated_at),
    change: row.kind === "knowledge_add" ? "add" : "correct",
    title: draft.title,
    kind: draft.kind,
    basis: draft.basis,
    assertionPreview,
    assertionTruncated: assertionPreview.length !== draft.assertion.length,
    targetRecordId: row.target_record_id,
    expectedRecordRevision: row.expected_record_revision,
  });
}

function listSelection(input: KnowledgeProposalList): SQL {
  const conditions: SQL[] = [sql`true`];

  if (input.owner?.kind === "company")
    conditions.push(sql`p.company_id=${input.owner.companyId}`);
  if (input.owner?.kind === "project")
    conditions.push(sql`p.project_id=${input.owner.projectId}`);
  if (input.status !== undefined)
    conditions.push(sql`p.status=${input.status}`);

  return sql.join(conditions, sql` AND `);
}

export async function listKnowledgeProposals(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  input: KnowledgeProposalList,
): Promise<KnowledgeProposalPage> {
  const parsed = knowledgeProposalListSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid knowledge proposal list filters");
  const { cursor: rawCursor, ...filters } = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const actor = await resolveKnowledgePrincipal(
        tx,
        principal,
        "knowledge:read",
      );

      await resolveKnowledgePrincipal(tx, principal, "knowledge:review");
      const scope = await knowledgeCursorScope(tx, principal, actor, {
        kind: "proposals",
        ...filters,
      });
      const cursor =
        rawCursor === undefined
          ? null
          : decodeKnowledgeCursor(rawCursor, scope);
      const upper =
        cursor?.upper ??
        String(
          (
            await tx.execute(
              sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
            )
          ).rows[0].at,
        );
      const policy = knowledgeProposalReadPolicyCte(
        actor,
        principal,
        listSelection(parsed.data),
      );
      const after =
        cursor === null
          ? sql`true`
          : sql`(p.created_at,p.id)<(${cursor.at}::timestamptz,${cursor.id})`;
      const rows = (
        await tx.execute(
          sql`${policy} SELECT p.*,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
            (SELECT coalesce(jsonb_agg(DISTINCT dependencies.ref),'[]'::jsonb) FROM (
              SELECT jsonb_build_object('kind',CASE WHEN o.company_id IS NULL THEN 'project' ELSE 'company' END,CASE WHEN o.company_id IS NULL THEN 'projectId' ELSE 'companyId' END,coalesce(o.company_id,o.project_id)) AS ref
              FROM jsonb_array_elements(p.draft->'evidence') proof JOIN brain_evidence_witnesses w ON proof->'reference'->>'kind'='witness' AND w.id=proof->'reference'->>'id' JOIN brain_evidence_observations o ON o.id=w.observation_id
              UNION ALL
              SELECT ref FROM jsonb_array_elements(p.draft->'evidence') proof JOIN brain_evidence_witnesses w ON proof->'reference'->>'kind'='witness' AND w.id=proof->'reference'->>'id' CROSS JOIN LATERAL jsonb_array_elements(w.restrictions) ref
            ) dependencies) AS evidence_restrictions
            FROM brain_proposals p JOIN knowledge_readable_proposals permitted ON permitted.id=p.id
            WHERE permitted.inspection_action='review' AND p.created_at<=${upper}::timestamptz AND ${after}
            ORDER BY p.created_at DESC,p.id DESC LIMIT ${filters.limit + 1} FOR SHARE OF p`,
        )
      ).rows;
      const items: KnowledgeProposalSummary[] = [];
      let access: KnowledgeAccessWalk = { visited: [], remaining: 256 };
      let nextCursor: string | null = null;

      for (
        let index = 0;
        index < rows.length && index < filters.limit;
        index++
      ) {
        const row = rows[index];
        const summary = proposalSummary(row);
        let candidateAccess = access;

        try {
          candidateAccess = await authorizeSourceRestrictions(
            tx,
            principal,
            [summary.owner],
            access,
          );

          candidateAccess = await authorizeSourceRestrictions(
            tx,
            principal,
            row.source_restrictions,
            candidateAccess,
          );
          candidateAccess = await authorizeSourceRestrictions(
            tx,
            principal,
            row.evidence_restrictions,
            candidateAccess,
          );
          if (
            summary.acceptedRecordId !== null &&
            summary.acceptedRecordRevision !== null
          )
            candidateAccess = await authorizeKnowledgeRevisionRead(
              tx,
              principal,
              summary.acceptedRecordId,
              summary.acceptedRecordRevision,
              candidateAccess,
            );
        } catch (error) {
          if (
            items.length > 0 &&
            isMaisterError(error) &&
            error.code === "PRECONDITION" &&
            error.details?.reason === "knowledge_reference_budget_exceeded"
          )
            break;
          throw error;
        }
        const visited = candidateAccess.visited;
        const next =
          index + 1 < rows.length
            ? encodeKnowledgeCursor({
                version: 1,
                scope,
                upper,
                at: String(rows[index].at),
                id: String(rows[index].id),
              })
            : null;

        if (
          visited.length > 256 ||
          Buffer.byteLength(
            JSON.stringify({ items: [...items, summary], nextCursor: next }),
            "utf8",
          ) > 131072
        ) {
          if (items.length === 0)
            throw new MaisterError(
              "PRECONDITION",
              "Knowledge proposal summary exceeds its bounded page contract",
            );
          break;
        }
        items.push(summary);
        access = { visited, remaining: 256 - visited.length };
        nextCursor = next;
      }
      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(access),
      );
      log.debug(
        { count: items.length, hasContinuation: nextCursor !== null },
        "knowledge proposals listed",
      );

      return { items, nextCursor };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
