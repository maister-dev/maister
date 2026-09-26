import "server-only";

import type {
  LibrarianConversationRow,
  LibrarianMessageRow,
  LibrarianSegmentRow,
} from "@/lib/db/schema";
import type { LibrarianSubject } from "@/lib/librarian/types";

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  librarianConversations,
  librarianMessages,
  librarianSegments,
  librarianTurns,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "librarian.conversation",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ConversationWithSegment = {
  conversation: LibrarianConversationRow;
  segment: LibrarianSegmentRow;
};

export const LIBRARIAN_MESSAGE_PAGE_MAX = 100;

async function currentSegment(
  tx: Db,
  conversation: LibrarianConversationRow,
): Promise<LibrarianSegmentRow> {
  if (conversation.currentSegmentId) {
    const [segment] = await tx
      .select()
      .from(librarianSegments)
      .where(eq(librarianSegments.id, conversation.currentSegmentId));

    if (segment) return segment;
  }
  const [last] = await tx
    .select({ ordinal: librarianSegments.ordinal })
    .from(librarianSegments)
    .where(eq(librarianSegments.conversationId, conversation.id))
    .orderBy(desc(librarianSegments.ordinal))
    .limit(1);
  const [segment] = await tx
    .insert(librarianSegments)
    .values({
      conversationId: conversation.id,
      ordinal: last ? last.ordinal + 1 : 0,
      startedAt: new Date(),
    })
    .returning();

  await tx
    .update(librarianConversations)
    .set({ currentSegmentId: segment.id, updatedAt: new Date() })
    .where(eq(librarianConversations.id, conversation.id));
  conversation.currentSegmentId = segment.id;

  return segment;
}

/** Locks the owner's conversation row, creating it (and its first segment) on
 * first use. The row lock orders admission, the single active turn, reset and
 * the daily cap (D15); every writer of a conversation takes it first. */
export async function lockOwnerConversation(
  tx: Db,
  ownerId: string,
): Promise<ConversationWithSegment> {
  await tx
    .insert(librarianConversations)
    .values({ userId: ownerId })
    .onConflictDoNothing({ target: librarianConversations.userId });
  const [conversation] = await tx
    .select()
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId))
    .for("update");

  if (!conversation)
    throw new MaisterError("CONFLICT", "librarian conversation vanished", {
      details: { reason: "conversation_missing" },
    });

  return { conversation, segment: await currentSegment(tx, conversation) };
}

export async function getOrCreateConversation(
  ownerId: string,
  db: Db = getDb(),
): Promise<ConversationWithSegment> {
  return db.transaction((tx: Db) => lockOwnerConversation(tx, ownerId));
}

/** The next `seq` of a conversation. The counter only moves forward, so a
 * deleted message never frees its sequence number. Caller holds the lock. */
export async function allocateSeq(
  tx: Db,
  conversationId: string,
): Promise<bigint> {
  const [row] = await tx
    .update(librarianConversations)
    .set({
      lastSeq: sql`${librarianConversations.lastSeq} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(librarianConversations.id, conversationId))
    .returning({ lastSeq: librarianConversations.lastSeq });

  return BigInt(row.lastSeq);
}

export async function findMessageByClientId(
  tx: Db,
  conversationId: string,
  clientMessageId: string,
): Promise<LibrarianMessageRow | null> {
  const [row] = await tx
    .select()
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.conversationId, conversationId),
        eq(librarianMessages.clientMessageId, clientMessageId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export type AppendOwnerMessageInput = {
  clientMessageId: string;
  body: string;
  subject: LibrarianSubject | null;
  deliveryState: "accepted" | "queued";
};

/** Stores the owner's message with the subject it was sent under. Caller holds
 * the conversation lock, so a repeated client id is answered from the stored
 * row; the partial unique index is the backstop, never the decision. */
export async function appendOwnerMessage(
  tx: Db,
  locked: ConversationWithSegment,
  input: AppendOwnerMessageInput,
): Promise<{ message: LibrarianMessageRow; deduped: boolean }> {
  const existing = await findMessageByClientId(
    tx,
    locked.conversation.id,
    input.clientMessageId,
  );

  if (existing) {
    log.info(
      {
        conversationId: locked.conversation.id,
        seq: existing.seq.toString(),
        deduped: true,
      },
      "librarian owner message",
    );

    return { message: existing, deduped: true };
  }
  const seq = await allocateSeq(tx, locked.conversation.id);
  const [message] = await tx
    .insert(librarianMessages)
    .values({
      conversationId: locked.conversation.id,
      segmentId: locked.segment.id,
      seq,
      authorKind: "owner",
      clientMessageId: input.clientMessageId,
      body: input.body,
      subject: input.subject,
      deliveryState: input.deliveryState,
    })
    .returning();

  await tx
    .update(librarianConversations)
    .set({ subject: input.subject, updatedAt: new Date() })
    .where(eq(librarianConversations.id, locked.conversation.id));
  log.info(
    {
      conversationId: locked.conversation.id,
      seq: seq.toString(),
      deduped: false,
    },
    "librarian owner message",
  );

  return { message, deduped: false };
}

/** A reply, update or system line. Caller holds the conversation lock. */
export async function appendConversationMessage(
  tx: Db,
  input: {
    conversationId: string;
    segmentId: string;
    authorKind: "librarian" | "update" | "system";
    body: string;
    turnId?: string | null;
    sourceProjectIds?: string[];
  },
): Promise<LibrarianMessageRow> {
  const seq = await allocateSeq(tx, input.conversationId);
  const [message] = await tx
    .insert(librarianMessages)
    .values({
      conversationId: input.conversationId,
      segmentId: input.segmentId,
      seq,
      authorKind: input.authorKind,
      body: input.body,
      deliveryState: "processed",
      turnId: input.turnId ?? null,
      sourceProjectIds: input.sourceProjectIds ?? [],
    })
    .returning();

  return message;
}

function notFound(what: string): MaisterError {
  return new MaisterError("PRECONDITION", `${what} not found`, {
    details: { reason: "not_found" },
  });
}

/** Withdraws a message still waiting for its turn; its turn never runs. */
export async function withdrawMessage(
  ownerId: string,
  messageId: string,
  db: Db = getDb(),
): Promise<void> {
  await db.transaction(async (tx: Db) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);
    const [message] = await tx
      .select()
      .from(librarianMessages)
      .where(
        and(
          eq(librarianMessages.id, messageId),
          eq(librarianMessages.conversationId, conversation.id),
        ),
      )
      .for("update");

    if (!message) throw notFound("message");
    if (message.deliveryState !== "queued")
      throw new MaisterError(
        "CONFLICT",
        "Only a queued message can be withdrawn",
        {
          details: {
            reason: "message_not_queued",
            deliveryState: message.deliveryState,
          },
        },
      );
    const withdrawn = await tx
      .update(librarianTurns)
      .set({ status: "withdrawn", endedAt: new Date() })
      .where(
        and(
          eq(librarianTurns.messageId, messageId),
          eq(librarianTurns.status, "queued"),
        ),
      )
      .returning({ id: librarianTurns.id });

    if (withdrawn.length === 0)
      throw new MaisterError("CONFLICT", "The message's turn already started", {
        details: { reason: "message_not_queued" },
      });
    await tx
      .update(librarianMessages)
      .set({ deliveryState: "withdrawn" })
      .where(eq(librarianMessages.id, messageId));
    log.info(
      { conversationId: conversation.id, messageId, turnId: withdrawn[0].id },
      "librarian message withdrawn",
    );
  });
}

/** The `limit` messages before `beforeSeq` (absent = the latest), ascending. */
export async function listMessages(
  ownerId: string,
  input: { beforeSeq?: bigint | null; limit: number },
  db: Db = getDb(),
): Promise<{ messages: LibrarianMessageRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, input.limit), LIBRARIAN_MESSAGE_PAGE_MAX);
  const [conversation] = await db
    .select({ id: librarianConversations.id })
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  if (!conversation) return { messages: [], hasMore: false };
  const rows: LibrarianMessageRow[] = await db
    .select()
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.conversationId, conversation.id),
        input.beforeSeq != null
          ? lt(librarianMessages.seq, input.beforeSeq)
          : undefined,
      ),
    )
    .orderBy(desc(librarianMessages.seq))
    .limit(limit + 1);

  return {
    messages: rows.slice(0, limit).reverse(),
    hasMore: rows.length > limit,
  };
}

/** Monotonic: a stale or replayed cursor never resurfaces read messages. A
 * value past the latest seq is clamped to it. */
export async function advanceReadCursor(
  ownerId: string,
  seq: bigint,
  db: Db = getDb(),
): Promise<bigint> {
  const [row] = await db
    .update(librarianConversations)
    .set({
      readThroughSeq: sql`GREATEST(${librarianConversations.readThroughSeq}, LEAST(${seq}::bigint, ${librarianConversations.lastSeq}))`,
    })
    .where(eq(librarianConversations.userId, ownerId))
    .returning({ readThroughSeq: librarianConversations.readThroughSeq });

  if (!row) throw notFound("conversation");

  return BigInt(row.readThroughSeq);
}

export async function listQueuedMessages(
  db: Db,
  conversationId: string,
): Promise<LibrarianMessageRow[]> {
  return db
    .select()
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.conversationId, conversationId),
        eq(librarianMessages.deliveryState, "queued"),
      ),
    )
    .orderBy(asc(librarianMessages.seq));
}
