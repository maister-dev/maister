import "server-only";

import type { KnowledgeDatabase } from "./knowledge-access";
import type { KnowledgePrincipal } from "./knowledge-types";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { resolveKnowledgePrincipal } from "./knowledge-access";
import {
  knowledgeCursorScope,
  parseKnowledgeCursor,
  signKnowledgeCursor,
} from "./knowledge-cursor";
import { knowledgeRevisionReadPolicyCte } from "./knowledge-query-policy";
import { authorizeKnowledgeRecordRead } from "./knowledge-restrictions";
import { knowledgeTimestamp } from "./knowledge-witnesses";
import { requireKnowledgeQueryKeys } from "./knowledge-url";

import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "knowledge-revisions",
  level: process.env.LOG_LEVEL ?? "info",
});
const cursorSchema = z.strictObject({
  scope: z.string(),
  upper: z.int().positive(),
  after: z.int().positive(),
});

export function parseKnowledgeRevisionPage(params: URLSearchParams) {
  requireKnowledgeQueryKeys(params, ["limit", "cursor"]);
  const limit = Number(params.get("limit") ?? "20");
  const cursor = params.get("cursor") ?? undefined;

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined && (!cursor || cursor.length > 2048))
  )
    throw new MaisterError("CONFIG", "Invalid record revision pagination");

  return { limit, cursor };
}

export async function listKnowledgeRevisions(
  db: KnowledgeDatabase,
  principal: KnowledgePrincipal,
  recordId: string,
  selection: Readonly<{ limit: number; cursor?: string }>,
) {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      const identity = await resolveKnowledgePrincipal(
        tx,
        principal,
        "knowledge:read",
      );
      const { record } = await authorizeKnowledgeRecordRead(
        tx,
        principal,
        recordId,
      );
      const scope = await knowledgeCursorScope(tx, principal, identity, [
        "record_revisions",
        recordId,
        selection.limit,
      ]);
      const continuation = selection.cursor
        ? cursorSchema.safeParse(parseKnowledgeCursor(selection.cursor))
        : null;

      if (
        continuation &&
        (!continuation.success || continuation.data.scope !== scope)
      )
        throw new MaisterError(
          "CONFIG",
          "Record revision cursor does not match the selection",
        );
      const after = continuation?.success ? continuation.data : null;
      const upper = after?.upper ?? record.current_revision;
      const policy = knowledgeRevisionReadPolicyCte(
        identity,
        sql`
        SELECT record_id,revision FROM brain_record_revisions
        WHERE record_id=${recordId} AND revision<=${upper} ${after ? sql`AND revision<${after.after}` : sql``}
      `,
      );
      const { rows } = await tx.execute(sql`${policy}
        SELECT r.record_id,r.revision,r.title,r.recorded_at,visible.status
        FROM knowledge_readable_records visible
        JOIN brain_record_revisions r ON r.record_id=visible.id AND r.revision=visible.selected_revision
        ORDER BY r.revision DESC LIMIT ${selection.limit + 1}
      `);
      const items = rows.slice(0, selection.limit).map((row) => ({
        recordId,
        revision: Number(row.revision),
        title: String(row.title),
        status: String(row.status),
        createdAt: knowledgeTimestamp(row.recorded_at),
        href: `/knowledge/${encodeURIComponent(recordId)}?revision=${row.revision}`,
      }));
      const last = items.at(-1);

      log.debug(
        { count: items.length, continued: Boolean(after) },
        "record revisions read",
      );

      return {
        items,
        nextCursor:
          rows.length > selection.limit && last
            ? signKnowledgeCursor({ scope, upper, after: last.revision })
            : null,
      };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
