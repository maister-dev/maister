import "server-only";

import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type { Db } from "@/lib/execution-host/db";

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import pino from "pino";

import {
  librarianMessageSources,
  recheckLibrarianProjects,
  visibleLibrarianTurnSources,
} from "./disclosed-context";
import { lockLibrarianKnowledgeContext } from "./knowledge-authority";

import { recordKnowledgeDisclosure } from "@/lib/brain/knowledge-disclosure";
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

type HistoryHit = {
  messageId: string;
  seq: string;
  authorKind: "owner" | "librarian" | "update";
  excerpt: string;
  label: "current_segment" | "earlier_conversation";
  createdAt: string;
};

type HistoryPage = { hits: HistoryHit[]; truncated: boolean };

export async function searchLibrarianHistory(
  ownerId: string,
  query: string,
  db: Db = getDb() as unknown as Db,
): Promise<HistoryPage> {
  const q = normalizeHistoryQuery(query);

  return db.transaction(
    async (tx) => {
      const { page } = await findVisibleHistory(tx, ownerId, q);

      return page;
    },
    { isolationLevel: "repeatable read" },
  );
}

export async function searchLibrarianHistoryForTurn(
  tokenId: string,
  query: string,
  db: Db = getDb() as unknown as Db,
): Promise<HistoryPage> {
  const q = normalizeHistoryQuery(query);

  return db.transaction(
    async (tx) => {
      const { ownerId, turnId, capture } = await lockLibrarianKnowledgeContext(
        tx,
        tokenId,
        "librarian:history",
      );
      const { page, restrictions } = await findVisibleHistory(tx, ownerId, q);

      await recheckLibrarianProjects(tx, ownerId, restrictions);
      await recordKnowledgeDisclosure(
        tx,
        { runId: null, librarianTurnId: turnId, capture },
        restrictions,
      );
      log.debug(
        { turnId, sourceCount: restrictions.length },
        "[FIX] Librarian history source capture checked",
      );

      return page;
    },
    { isolationLevel: "repeatable read" },
  );
}

function normalizeHistoryQuery(query: string): string {
  const q = query.trim();

  if (!q || q.length > 200)
    throw new MaisterError(
      "CONFIG",
      "history query must contain 1 to 200 characters",
    );

  return q;
}

async function findVisibleHistory(
  tx: Db,
  ownerId: string,
  query: string,
): Promise<{ page: HistoryPage; restrictions: KnowledgeAccessRestriction[] }> {
  const [conversation] = await tx
    .select({
      id: librarianConversations.id,
      currentSegmentId: librarianConversations.currentSegmentId,
    })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  if (!conversation)
    return { page: { hits: [], truncated: false }, restrictions: [] };
  const [owner] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerId));
  const visible = owner
    ? await getVisibleProjectIds(ownerId, owner.role, tx)
    : [];
  const hits: HistoryHit[] = [];
  const restrictions: KnowledgeAccessRestriction[] = [];
  const batchSize = 32;
  let before: bigint | undefined;

  while (hits.length < 21) {
    const candidates = await tx
      .select({
        id: librarianMessages.id,
        seq: librarianMessages.seq,
        body: librarianMessages.body,
        segmentId: librarianMessages.segmentId,
        authorKind: librarianMessages.authorKind,
        createdAt: librarianMessages.createdAt,
        turnId: librarianMessages.turnId,
        sourceProjectIds: librarianMessages.sourceProjectIds,
      })
      .from(librarianMessages)
      .where(
        and(
          eq(librarianMessages.conversationId, conversation.id),
          inArray(librarianMessages.authorKind, [
            "owner",
            "librarian",
            "update",
          ]),
          before === undefined ? undefined : lt(librarianMessages.seq, before),
          sql`${librarianMessages.bodyTsv} @@ plainto_tsquery('simple', ${query})`,
          sql`(${librarianMessages.authorKind} = 'owner' OR ${librarianMessages.sourceProjectIds}
          <@ ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(visible)}::jsonb)))`,
        ),
      )
      .orderBy(desc(librarianMessages.seq))
      .limit(batchSize);
    const disclosures = await visibleLibrarianTurnSources(
      tx,
      ownerId,
      candidates.flatMap(({ turnId }) => (turnId ? [turnId] : [])),
    );

    for (const row of candidates) {
      const sources = librarianMessageSources(row, disclosures);

      if (!sources) continue;
      // The lookahead hit also contributes to the returned truncation flag.
      restrictions.push(...sources);
      hits.push({
        messageId: row.id,
        seq: row.seq.toString(),
        authorKind: row.authorKind as "owner" | "librarian" | "update",
        excerpt: row.body.slice(0, 500),
        label:
          row.segmentId === conversation.currentSegmentId
            ? ("current_segment" as const)
            : ("earlier_conversation" as const),
        createdAt: row.createdAt.toISOString(),
      });
      if (hits.length === 21) break;
    }
    if (candidates.length < batchSize) break;
    before = candidates.at(-1)?.seq;
  }

  log.debug({ hits: hits.length }, "librarian history searched");

  return {
    page: { hits: hits.slice(0, 20), truncated: hits.length > 20 },
    restrictions,
  };
}
