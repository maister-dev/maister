import "server-only";

import type { KnowledgeDatabase } from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";
import type { KnowledgeRecordSelector } from "./knowledge-records";
import type { KnowledgePageInput } from "./knowledge-evidence-page";

import { sql } from "drizzle-orm";
import { z } from "zod";
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
import { knowledgePageInputSchema } from "./knowledge-evidence-page";
import { knowledgeConflictEdges } from "./knowledge-conflict-query";
import { knowledgeRevisionReadPolicyCte } from "./knowledge-query-policy";
import { readKnowledgeRecord } from "./knowledge-records";
import {
  authorizeKnowledgeRevisionRead,
  restrictionsForKnowledgeAccess,
} from "./knowledge-restrictions";
import { knowledgeReferenceSchema } from "./knowledge-types";

import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { postgresTextSchema } from "@/lib/text-schema";

const log = pino({
  name: "brain:knowledge-conflicts",
  level: process.env.LOG_LEVEL ?? "info",
});

export const knowledgeConflictSchema = z
  .object({
    edgeId: postgresTextSchema.min(1).max(128),
    classification: z.enum(["potential_conflict", "declared_conflict"]),
    reference: knowledgeReferenceSchema.extend({
      kind: z.literal("knowledge"),
      revision: z.number().int().positive().max(2147483647),
    }),
  })
  .strict();
export type KnowledgeConflict = z.infer<typeof knowledgeConflictSchema>;
export type KnowledgeConflictPage = Readonly<{
  items: readonly KnowledgeConflict[];
  nextCursor: string | null;
}>;

/** Conflict edges retain the original opposing revision; neither score nor a newer claim resolves them. */
export async function getKnowledgeConflictsPage(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  selector: KnowledgeRecordSelector,
  input: KnowledgePageInput,
): Promise<KnowledgeConflictPage> {
  const parsed = knowledgePageInputSchema.safeParse(input);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid knowledge conflict page");
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
      const root = await readKnowledgeRecord(tx, principal, selector);
      const { cursor: rawCursor, limit } = parsed.data;
      const scope = await knowledgeCursorScope(tx, principal, identity, {
        kind: "conflicts",
        recordId: root.record.id,
        revision: root.record.revision,
        limit,
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
      const edges = knowledgeConflictEdges(
        root.record.id,
        root.record.revision,
      );
      const policy = knowledgeRevisionReadPolicyCte(
        identity,
        sql`SELECT e.record_id,e.revision FROM (${edges}) e`,
      );
      const after =
        cursor === null
          ? sql`true`
          : sql`(e.created_at,e.edge_id)<(${cursor.at}::timestamptz,${cursor.id})`;
      const rows = (
        await tx.execute(
          sql`${policy} SELECT e.*,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM (${edges}) e JOIN knowledge_readable_records r ON r.id=e.record_id AND r.selected_revision=e.revision WHERE e.created_at<=${upper}::timestamptz AND ${after} ORDER BY e.created_at DESC,e.edge_id DESC LIMIT ${limit + 1}`,
        )
      ).rows;
      const items: KnowledgeConflict[] = [];
      let access = root.access;
      let nextCursor: string | null = null;

      for (let index = 0; index < rows.length && index < limit; index++) {
        const row = rows[index];

        access = await authorizeKnowledgeRevisionRead(
          tx,
          principal,
          String(row.record_id),
          Number(row.revision),
          access,
        );
        items.push(
          knowledgeConflictSchema.parse({
            edgeId: row.edge_id,
            classification: row.classification,
            reference: {
              kind: "knowledge",
              id: row.record_id,
              revision: row.revision,
            },
          }),
        );
        nextCursor =
          index + 1 < rows.length
            ? encodeKnowledgeCursor({
                version: 1,
                scope,
                upper,
                at: String(row.at),
                id: String(row.edge_id),
              })
            : null;
      }
      await recordKnowledgeDisclosure(
        tx,
        consumer,
        restrictionsForKnowledgeAccess(access),
      );
      log.debug(
        {
          recordId: root.record.id,
          revision: root.record.revision,
          count: items.length,
          hasContinuation: nextCursor !== null,
        },
        "knowledge conflicts disclosed",
      );

      return { items, nextCursor };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
