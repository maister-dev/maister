import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import {
  librarianConversations,
  librarianMessages,
  users,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

const log = pino({
  name: "librarian.history",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function searchLibrarianHistory(
  ownerId: string,
  query: string,
  db: Db = getDb() as unknown as Db,
): Promise<{
  hits: Array<{
    messageId: string;
    seq: string;
    authorKind: "owner" | "librarian" | "update";
    excerpt: string;
    label: "current_segment" | "earlier_conversation";
    createdAt: string;
  }>;
  truncated: boolean;
}> {
  const q = query.trim();

  if (!q || q.length > 200)
    throw new MaisterError(
      "PRECONDITION",
      "history query must contain 1 to 200 characters",
    );
  const [conversation] = await db
    .select({
      id: librarianConversations.id,
      currentSegmentId: librarianConversations.currentSegmentId,
    })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  if (!conversation) return { hits: [], truncated: false };
  const [owner] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));
  const visible = owner ? await getVisibleProjectIds(ownerId, owner.role, db) : [];
  const candidates = await db
    .select({
      id: librarianMessages.id,
      seq: librarianMessages.seq,
      body: librarianMessages.body,
      segmentId: librarianMessages.segmentId,
      authorKind: librarianMessages.authorKind,
      createdAt: librarianMessages.createdAt,
    })
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.conversationId, conversation.id),
        inArray(librarianMessages.authorKind, ["owner", "librarian", "update"]),
        sql`${librarianMessages.bodyTsv} @@ plainto_tsquery('simple', ${q})`,
        sql`(${librarianMessages.authorKind} = 'owner' OR ${librarianMessages.sourceProjectIds}
          <@ ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(visible)}::jsonb)))`,
      ),
    )
    .orderBy(desc(librarianMessages.seq))
    .limit(21);
  const hits = candidates
    .slice(0, 20)
    .map((row) => ({
      messageId: row.id,
      seq: row.seq.toString(),
      authorKind: row.authorKind as "owner" | "librarian" | "update",
      excerpt: row.body.slice(0, 500),
      label:
        row.segmentId === conversation.currentSegmentId
          ? "current_segment" as const
          : "earlier_conversation" as const,
      createdAt: row.createdAt.toISOString(),
    }));

  log.debug({ hits: hits.length }, "librarian history searched");

  return { hits, truncated: candidates.length > 20 };
}
