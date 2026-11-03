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

import { ownerSchema } from "@/lib/company/types";
import { postgresTextSchema } from "@/lib/text-schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
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
    evidence: z.array(knowledgeRecordEvidenceSummarySchema).max(64),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const knowledgeProposalSummarySchema = knowledgeProposalViewSchema
  .omit({ content: true, evidence: true })
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
      : "knowledge:propose";

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
    if (link.reference.kind !== "witness")
      throw new MaisterError(
        "PRECONDITION",
        "This proposal requires its native evidence resolver",
        { details: { reason: "native_reference_kind_unavailable" } },
      );
    const present = (
      await tx.execute(
        sql`SELECT id FROM brain_evidence_witnesses WHERE id=${link.reference.id}`,
      )
    ).rows[0];

    if (!present) {
      evidence.push({
        relation: link.relation,
        unavailable: {
          state: "missing",
          reason:
            "The proposal's retained source capture is currently unavailable.",
        },
      });
      continue;
    }
    const inspection = await inspectKnowledgeWitness(
      tx,
      principal,
      link.reference.id,
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
): Promise<KnowledgeProposalView> {
  if (!identity.safeParse(proposalId).success)
    throw new MaisterError("CONFIG", "Invalid knowledge proposal identity");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const result = await readProposal(tx, principal, proposalId);

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
          sql`${policy} SELECT p.id,to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM knowledge_readable_proposals p WHERE p.inspection_action='review' AND p.created_at<=${upper}::timestamptz AND ${after} ORDER BY p.created_at DESC,p.id DESC LIMIT ${filters.limit + 1}`,
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
        const result = await readProposal(
          tx,
          principal,
          String(rows[index].id),
        );
        const { proposal } = result;
        const { content, evidence: _evidence, ...metadata } = proposal;
        const assertionPreview = truncateUtf16(content.assertion, 1000);
        const summary = knowledgeProposalSummarySchema.parse({
          ...metadata,
          change: content.change,
          title: content.title,
          kind: content.kind,
          basis: content.basis,
          assertionPreview,
          assertionTruncated:
            assertionPreview.length !== content.assertion.length,
          targetRecordId:
            content.change === "correct" ? content.recordId : null,
          expectedRecordRevision:
            content.change === "correct" ? content.expectedRevision : null,
        });
        const visited = [
          ...new Set([...access.visited, ...result.access.visited]),
        ];
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
