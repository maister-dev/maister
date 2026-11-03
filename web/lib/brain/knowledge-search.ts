import "server-only";

import type { SQL } from "drizzle-orm";
import type { KnowledgeDatabase } from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type {
  KnowledgeSearch,
  KnowledgeSummaryDto,
} from "./knowledge-read-types";
import type { KnowledgeAccessWalk } from "./knowledge-restrictions";

import { sql } from "drizzle-orm";
import pino from "pino";

import { resolveKnowledgePrincipal } from "./knowledge-access";
import {
  decodeKnowledgeCursor,
  encodeKnowledgeCursor,
  knowledgeCursorScope,
} from "./knowledge-cursor";
import {
  lockKnowledgeReadConsumer,
  recordKnowledgeDisclosure,
} from "./knowledge-disclosure";
import {
  knowledgeSearchSchema,
  knowledgeSummarySchema,
} from "./knowledge-read-types";
import { knowledgeReadPolicyCte } from "./knowledge-query-policy";
import { readKnowledgeRecord } from "./knowledge-records";
import { restrictionsForKnowledgeAccess } from "./knowledge-restrictions";

import { redactQueryError } from "@/lib/db/pg-error";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { truncateUtf16 } from "@/lib/utf8";

const log = pino({
  name: "brain:knowledge-search",
  level: process.env.LOG_LEVEL ?? "info",
});

export type KnowledgePage = Readonly<{
  items: readonly KnowledgeSummaryDto[];
  nextCursor: string | null;
}>;

function searchSelection(input: KnowledgeSearch): SQL {
  const conditions: SQL[] = [sql`i.status='active'`];

  if (input.owner?.kind === "company")
    conditions.push(sql`i.company_id=${input.owner.companyId}`);
  if (input.owner?.kind === "project")
    conditions.push(sql`i.project_id=${input.owner.projectId}`);
  if (input.q !== "")
    conditions.push(
      sql`strpos(lower(i.title || E'\\n' || i.content),lower(${input.q}))>0`,
    );
  if (input.kind !== undefined) conditions.push(sql`i.kind=${input.kind}`);
  if (input.confirmation !== undefined)
    conditions.push(
      sql`coalesce((SELECT CASE c.decision WHEN 'confirm' THEN 'confirmed' ELSE 'revoked' END FROM brain_confirmations c WHERE c.record_id=i.id AND c.record_revision=i.current_revision ORDER BY c.decision_sequence DESC LIMIT 1),'unconfirmed')=${input.confirmation}`,
    );
  if (input.freshness !== undefined)
    conditions.push(
      sql`coalesce((SELECT r.freshness->>'state' FROM brain_record_revisions r WHERE r.record_id=i.id AND r.revision=i.current_revision),'unknown')=${input.freshness}`,
    );
  if (input.conflict !== undefined)
    conditions.push(
      input.conflict === "resolved"
        ? sql`false`
        : sql`EXISTS (SELECT 1 FROM brain_edges e WHERE e.claim_state IS NOT NULL AND ((e.from_ref->>'id'=i.id AND e.from_revision=i.current_revision) OR (e.to_ref->>'id'=i.id AND e.to_revision=i.current_revision)))`,
    );

  return sql.join(conditions, sql` AND `);
}

/** SQL filters source closure before LIMIT; only disclosed rows become signed page anchors. */
export async function searchKnowledge(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  input: KnowledgeSearch,
): Promise<KnowledgePage> {
  const parsed = knowledgeSearchSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid structured knowledge search");
  const { cursor: rawCursor, ...filters } = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const consumer = await lockKnowledgeReadConsumer(tx, principal);
      const identity = await resolveKnowledgePrincipal(
        tx,
        principal,
        "knowledge:read",
      );
      const scope = await knowledgeCursorScope(
        tx,
        principal,
        identity,
        filters,
      );
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
      const policy = knowledgeReadPolicyCte(
        identity,
        searchSelection(parsed.data),
      );
      const after =
        cursor === null
          ? sql`true`
          : sql`(i.created_at,i.id)<(${cursor.at}::timestamptz,${cursor.id})`;
      const rows = (
        await tx.execute(
          sql`${policy} SELECT i.id,to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM knowledge_readable_records i WHERE i.created_at<=${upper}::timestamptz AND ${after} ORDER BY i.created_at DESC,i.id DESC LIMIT ${filters.limit + 1}`,
        )
      ).rows;
      const items: KnowledgeSummaryDto[] = [];
      let access: KnowledgeAccessWalk = { visited: [], remaining: 256 };
      let nextCursor: string | null = null;

      for (
        let index = 0;
        index < rows.length && index < filters.limit;
        index++
      ) {
        const row = rows[index];
        const result = await readKnowledgeRecord(tx, principal, {
          recordId: String(row.id),
        });
        const { record } = result;
        const assertionPreview = truncateUtf16(record.assertion, 1000);
        const summary = knowledgeSummarySchema.parse({
          id: record.id,
          owner: record.owner,
          revision: record.revision,
          title: record.title,
          assertionPreview,
          assertionTruncated:
            record.assertionTruncated ||
            assertionPreview.length !== record.assertion.length,
          kind: record.kind,
          basis: record.basis,
          lifecycle: record.lifecycle,
          visibility: record.visibility,
          confirmationState: record.confirmation.state,
          freshnessState: record.freshness.state,
          conflict: record.conflict,
          updatedAt: record.updatedAt,
        });
        const visited = [
          ...new Set([...access.visited, ...result.access.visited]),
        ];
        const continuation =
          index + 1 < rows.length
            ? encodeKnowledgeCursor({
                version: 1,
                scope,
                upper,
                at: String(row.at),
                id: String(row.id),
              })
            : null;
        const candidate = {
          items: [...items, summary],
          nextCursor: continuation,
        };

        if (
          visited.length > 256 ||
          Buffer.byteLength(JSON.stringify(candidate), "utf8") > 131072
        ) {
          if (items.length === 0)
            throw new MaisterError(
              "PRECONDITION",
              "Knowledge summary exceeds the bounded page contract",
            );
          break;
        }
        items.push(summary);
        access = { visited, remaining: 256 - visited.length };
        nextCursor = continuation;
      }
      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(access),
      );
      log.debug(
        {
          queryHash: contentDigest(filters),
          count: items.length,
          hasContinuation: nextCursor !== null,
        },
        "structured knowledge searched",
      );

      return { items, nextCursor };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
